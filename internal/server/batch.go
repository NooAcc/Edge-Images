package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"

	"edge-image/internal/allowlist"
	"edge-image/internal/cache"
	"edge-image/internal/config"
	"edge-image/internal/fetcher"
	"edge-image/internal/params"
	"edge-image/internal/processor"
)

const maxBatchImages = 20
const maxAsyncBatchImages = 50

type batchRequestItem struct {
	UUID   string                 `json:"uuid"`
	URL    string                 `json:"url"`
	Params map[string]interface{} `json:"params"`
}

type batchResponseItem struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

type BatchHandler struct {
	cfg   config.PlatformConfig
	al    *allowlist.Allowlist
	cache *cache.Cache
	fetch *fetcher.Fetcher
	log   *slog.Logger
}

func NewBatchHandler(cfg config.PlatformConfig, al *allowlist.Allowlist, c *cache.Cache, f *fetcher.Fetcher, log *slog.Logger) *BatchHandler {
	return &BatchHandler{
		cfg:   cfg,
		al:    al,
		cache: c,
		fetch: f,
		log:   log,
	}
}

func (h *BatchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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

	var items []batchRequestItem
	if err := json.Unmarshal(body, &items); err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Request body must be a JSON array"})
		return
	}

	if len(items) == 0 {
		sendJSON(w, http.StatusOK, map[string]interface{}{})
		return
	}

	if len(items) > maxBatchImages {
		sendJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("Maximum %d images allowed per batch", maxBatchImages),
		})
		return
	}

	uuids := make(map[string]bool)
	for _, item := range items {
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

	log := h.log.With("batchSize", len(items))
	log.Info("batch.request.start")

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
					log.Warn("batch: video frame failed", "url", url, "error", err)
					for _, idx := range indices {
						pending[idx].params = nil
					}
					return
				}
				buffer = frame
				contentType = "image/jpeg"
			} else {
				result, err := h.fetch.FetchImage(url)
				if err != nil {
					log.Warn("batch: fetch failed", "url", url, "error", err)
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
				log.Warn("batch: process failed, returning original", "uuid", uuid, "error", err)
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

	log.Info("batch.request.complete", "count", len(items))
	sendJSON(w, http.StatusOK, response)
}

func (h *BatchHandler) handleBatchMetadata(p *params.Params, isVideo bool, log *slog.Logger) (interface{}, error) {
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

func (h *BatchHandler) cacheMetadata(url string, data interface{}) {
	if h.cache == nil {
		return
	}
	jsonData, _ := json.Marshal(data)
	key := cache.BuildCacheKey("meta", url)
	h.cache.Set(key, &cache.Entry{Buffer: jsonData, ContentType: "application/json"})
}

func buildQueryFromParams(p map[string]interface{}) map[string][]string {
	query := make(map[string][]string)
	for k, v := range p {
		query[k] = []string{fmt.Sprintf("%v", v)}
	}
	return query
}
