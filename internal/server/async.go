package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"edge-image/internal/allowlist"
	"edge-image/internal/cache"
	"edge-image/internal/config"
	"edge-image/internal/fetcher"
	"edge-image/internal/params"
	"edge-image/internal/processor"
)

// asyncBatchRequest is the incoming request when callbackUrl is present.
type asyncBatchRequest struct {
	Items       []batchRequestItem `json:"items"`
	CallbackURL string             `json:"callbackUrl"`
	JobID       string             `json:"jobId"`
}

// callbackPayload is what Edge-Images POSTs back to the caller after processing.
type callbackPayload struct {
	JobID     string                       `json:"jobId"`
	Status    string                       `json:"status"`
	Items     []callbackItem               `json:"items"`
	Results   map[string]batchResponseItem `json:"results"`
	Timestamp string                       `json:"timestamp"`
}

// callbackItem records the original request item so the receiver can map results back.
type callbackItem struct {
	UUID   string                 `json:"uuid"`
	URL    string                 `json:"url"`
	Params map[string]interface{} `json:"params"`
}

// AsyncBatchHandler processes batches asynchronously and POSTs results to a callback URL.
type AsyncBatchHandler struct {
	cfg   config.PlatformConfig
	al    *allowlist.Allowlist
	cache *cache.Cache
	fetch *fetcher.Fetcher
	log   *slog.Logger
}

func NewAsyncBatchHandler(cfg config.PlatformConfig, al *allowlist.Allowlist, c *cache.Cache, f *fetcher.Fetcher, log *slog.Logger) *AsyncBatchHandler {
	return &AsyncBatchHandler{
		cfg:   cfg,
		al:    al,
		cache: c,
		fetch: f,
		log:   log,
	}
}

func (h *AsyncBatchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Failed to read request body"})
		return
	}

	var req asyncBatchRequest
	if err := json.Unmarshal(body, &req); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Request body must be JSON"})
		return
	}

	if len(req.Items) == 0 {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "items array is required"})
		return
	}

	if len(req.Items) > maxBatchImages {
		sendJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("Maximum %d images allowed per batch", maxBatchImages),
		})
		return
	}

	if req.CallbackURL == "" {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "callbackUrl is required"})
		return
	}

	jobID := req.JobID
	if jobID == "" {
		jobID = fmt.Sprintf("ej-%d", time.Now().UnixNano())
	}

	// Validate items
	uuids := make(map[string]bool)
	for _, item := range req.Items {
		if item.UUID == "" {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Each image must have a string uuid"})
			return
		}
		if uuids[item.UUID] {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("Duplicate uuid: %s", item.UUID)})
			return
		}
		uuids[item.UUID] = true
		if item.URL == "" {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("Missing url for uuid: %s", item.UUID)})
			return
		}
	}

	log := h.log.With("jobId", jobID, "batchSize", len(req.Items), "callbackUrl", req.CallbackURL)
	log.Info("asyncBatch.request.received")

	// Return immediately — processing happens in background
	sendJSON(w, http.StatusAccepted, map[string]string{
		"jobId":  jobID,
		"status": "accepted",
	})

	// Process in background
	go h.processAsync(jobID, req.Items, req.CallbackURL, log)
}

func (h *AsyncBatchHandler) processAsync(jobID string, items []batchRequestItem, callbackURL string, log *slog.Logger) {
	start := time.Now()

	response := make(map[string]batchResponseItem)

	type pendingItem struct {
		uuid    string
		params  *params.Params
		isVideo bool
	}
	var pending []pendingItem

	for _, item := range items {
		query := buildQueryFromParams(item.Params)
		p, err := params.Parse(item.URL, query, h.cfg, h.al)
		if err != nil {
			response[item.UUID] = batchResponseItem{Success: false, Error: err.Error()}
			continue
		}

		isVideo := videoExtensions.MatchString(p.URL)

		if p.Format == "json" {
			data, err := h.handleBatchMetadata(p, isVideo, log)
			if err != nil {
				response[item.UUID] = batchResponseItem{Success: false, Error: err.Error()}
			} else {
				response[item.UUID] = batchResponseItem{Success: true, Data: data}
			}
			continue
		}

		if h.cache != nil {
			key := buildProcessedCacheKey(p)
			if entry, found := h.cache.Get(key); found {
				response[item.UUID] = batchResponseItem{
					Success: true,
					Data: map[string]string{
						"base64":      base64.StdEncoding.EncodeToString(entry.Buffer),
						"contentType": entry.ContentType,
					},
				}
				continue
			}
		}

		pending = append(pending, pendingItem{uuid: item.UUID, params: p, isVideo: isVideo})
	}

	// Fetch source images (grouped by URL)
	type sourceEntry struct {
		buffer      []byte
		contentType string
	}

	urlGroups := make(map[string][]int)
	for i, item := range pending {
		urlGroups[item.params.URL] = append(urlGroups[item.params.URL], i)
	}

	sourceCache := make(map[string]*sourceEntry)
	var sourceMu sync.Mutex

	var wg sync.WaitGroup
	for url, indices := range urlGroups {
		wg.Add(1)
		go func(url string, indices []int) {
			defer wg.Done()

			isVideo := pending[indices[0]].isVideo

			if h.cache != nil {
				sourceKey := cache.BuildCacheKey("source", url)
				if entry, found := h.cache.Get(sourceKey); found {
					sourceMu.Lock()
					sourceCache[url] = &sourceEntry{buffer: entry.Buffer, contentType: entry.ContentType}
					sourceMu.Unlock()
					return
				}
			}

			var buffer []byte
			var contentType string

			if isVideo {
				frame, err := processor.ExtractVideoFrame(url, h.fetch, log)
				if err != nil {
					log.Warn("asyncBatch: video frame failed", "url", url, "error", err)
					for _, idx := range indices {
						pending[idx].params = nil
					}
					return
				}
				buffer = frame
				contentType = "image/png"
			} else {
				result, err := h.fetch.FetchImage(url)
				if err != nil {
					log.Warn("asyncBatch: fetch failed", "url", url, "error", err)
					for _, idx := range indices {
						pending[idx].params = nil
					}
					return
				}
				buffer = result.Buffer
				contentType = result.ContentType
			}

			sourceMu.Lock()
			sourceCache[url] = &sourceEntry{buffer: buffer, contentType: contentType}
			sourceMu.Unlock()

			if h.cache != nil {
				sourceKey := cache.BuildCacheKey("source", url)
				h.cache.Set(sourceKey, &cache.Entry{Buffer: buffer, ContentType: contentType})
			}
		}(url, indices)
	}
	wg.Wait()

	// Process images concurrently
	var processWg sync.WaitGroup
	for _, item := range pending {
		if item.params == nil {
			response[item.uuid] = batchResponseItem{Success: false, Error: "Source fetch failed"}
			continue
		}

		source, ok := sourceCache[item.params.URL]
		if !ok {
			response[item.uuid] = batchResponseItem{Success: false, Error: "Source unavailable"}
			continue
		}

		processWg.Add(1)
		go func(uuid string, p *params.Params, source *sourceEntry) {
			defer processWg.Done()

			procParams := processor.ImageParams{
				Width:             p.Width,
				Height:            p.Height,
				Crop:              p.Crop,
				Size:              p.Size,
				Quality:           p.Quality,
				Format:            p.Format,
				Rotate:            p.Rotate,
				Flip:              p.Flip,
				Background:        p.Background,
				MaxDimension:      p.MaxDimension,
				SourceContentType: source.contentType,
			}

			result, err := processor.ProcessImage(source.buffer, procParams, log)
			if err != nil {
				log.Warn("asyncBatch: process failed, returning original", "uuid", uuid, "error", err)
				response[uuid] = batchResponseItem{
					Success: true,
					Data: map[string]string{
						"base64":      base64.StdEncoding.EncodeToString(source.buffer),
						"contentType": source.contentType,
					},
				}
				return
			}

			outputContentType := processor.FormatContentTypes[result.Format]
			if outputContentType == "" {
				outputContentType = "application/octet-stream"
			}

			if h.cache != nil {
				key := buildProcessedCacheKey(p)
				h.cache.Set(key, &cache.Entry{Buffer: result.Buffer, ContentType: outputContentType})
			}

			response[uuid] = batchResponseItem{
				Success: true,
				Data: map[string]string{
					"base64":      base64.StdEncoding.EncodeToString(result.Buffer),
					"contentType": outputContentType,
				},
			}
		}(item.uuid, item.params, source)
	}
	processWg.Wait()

	elapsed := time.Since(start)
	log.Info("asyncBatch.processing.complete", "duration", elapsed.String(), "count", len(items))

	// Build callback items (preserves original request for each UUID)
	callbackItems := make([]callbackItem, len(items))
	for i, item := range items {
		callbackItems[i] = callbackItem{
			UUID:   item.UUID,
			URL:    item.URL,
			Params: item.Params,
		}
	}

	// Determine status
	status := "completed"
	for _, r := range response {
		if !r.Success {
			status = "partial"
			break
		}
	}

	payload := callbackPayload{
		JobID:     jobID,
		Status:    status,
		Items:     callbackItems,
		Results:   response,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}

	h.sendCallback(callbackURL, payload, log)
}

func (h *AsyncBatchHandler) sendCallback(callbackURL string, payload callbackPayload, log *slog.Logger) {
	data, err := json.Marshal(payload)
	if err != nil {
		log.Error("asyncBatch.callback.marshal_failed", "error", err)
		return
	}

	client := &http.Client{Timeout: 30 * time.Second}

	// Retry up to 3 times with exponential backoff
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			delay := time.Duration(1<<uint(attempt-1)) * time.Second // 1s, 2s
			time.Sleep(delay)
		}

		req, err := http.NewRequest(http.MethodPost, callbackURL, bytes.NewReader(data))
		if err != nil {
			log.Error("asyncBatch.callback.request_failed", "error", err, "attempt", attempt+1)
			continue
		}
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
		req.Header.Set("X-Job-ID", payload.JobID)

		resp, err := client.Do(req)
		if err != nil {
			log.Warn("asyncBatch.callback.send_failed", "error", err, "attempt", attempt+1)
			continue
		}
		resp.Body.Close()

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			log.Info("asyncBatch.callback.delivered", "status", resp.StatusCode, "attempt", attempt+1)
			return
		}

		log.Warn("asyncBatch.callback.rejected", "status", resp.StatusCode, "attempt", attempt+1)
	}

	log.Error("asyncBatch.callback.all_retries_failed", "jobId", payload.JobID, "callbackUrl", callbackURL)
}

func (h *AsyncBatchHandler) handleBatchMetadata(p *params.Params, isVideo bool, log *slog.Logger) (interface{}, error) {
	if h.cache != nil {
		key := cache.BuildCacheKey("meta", p.URL)
		if entry, found := h.cache.Get(key); found {
			var data interface{}
			json.Unmarshal(entry.Buffer, &data)
			return data, nil
		}
	}

	if isVideo {
		meta, err := processor.ProbeVideoMetadata(p.URL, h.fetch, log)
		if err != nil {
			return nil, err
		}
		data := map[string]interface{}{
			"width": meta.Width, "height": meta.Height,
			"codec": meta.Codec, "duration": meta.Duration,
			"format": meta.Format, "sourceUrl": p.URL, "sourceSize": meta.SourceSize,
		}
		h.cacheMetadata(p.URL, data)
		return data, nil
	}

	result, err := h.fetch.FetchImageRange(p.URL, fetcher.DefaultMetaRange)
	if err != nil {
		return nil, err
	}

	meta, err := processor.ProbeImageMetadata(result.Buffer, log)
	if err != nil {
		fullResult, fullErr := h.fetch.FetchImage(p.URL)
		if fullErr != nil {
			return nil, fullErr
		}
		meta, err = processor.ProbeImageMetadata(fullResult.Buffer, log)
		if err != nil {
			return nil, err
		}
		meta.SourceSize = int64(len(fullResult.Buffer))
		meta.SourceContentType = fullResult.ContentType
	} else {
		meta.SourceSize = result.SourceSize
		meta.SourceContentType = result.ContentType
	}

	data := map[string]interface{}{
		"width": meta.Width, "height": meta.Height,
		"format": meta.Format, "channels": meta.Channels,
		"sourceUrl": p.URL, "sourceContentType": meta.SourceContentType,
		"sourceSize": meta.SourceSize,
	}
	h.cacheMetadata(p.URL, data)
	return data, nil
}

func (h *AsyncBatchHandler) cacheMetadata(url string, data interface{}) {
	if h.cache == nil {
		return
	}
	jsonData, _ := json.Marshal(data)
	key := cache.BuildCacheKey("meta", url)
	h.cache.Set(key, &cache.Entry{Buffer: jsonData, ContentType: "application/json"})
}
