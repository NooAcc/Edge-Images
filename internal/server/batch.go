package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"

	"edge-image/internal/allowlist"
	"edge-image/internal/cache"
	"edge-image/internal/config"
	"edge-image/internal/fetcher"
	"edge-image/internal/nsfw"
	"edge-image/internal/params"
	"edge-image/internal/processor"
)

const maxBatchImages = 20
const maxAsyncBatchImages = 50
const maxInlineImageBytes = 50 << 20
const maxRequestBodyBytes = 256 << 20

type batchRequestItem struct {
	UUID        string                 `json:"uuid"`
	URL         string                 `json:"url"`
	Base64      string                 `json:"base64"`
	ContentType string                 `json:"contentType"`
	Params      map[string]interface{} `json:"params"`
}

type batchResponseItem struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

// batchRunner owns the shared per-batch pipeline used by both the sync and
// the async handlers.
type batchRunner struct {
	cfg   config.PlatformConfig
	al    *allowlist.Allowlist
	cache *cache.Cache
	fetch *fetcher.Fetcher
	nsfw  *nsfwService
	log   *slog.Logger
}

func newBatchRunner(cfg config.PlatformConfig, al *allowlist.Allowlist, c *cache.Cache, f *fetcher.Fetcher, classifier nsfw.Classifier, log *slog.Logger) *batchRunner {
	return &batchRunner{
		cfg:   cfg,
		al:    al,
		cache: c,
		fetch: f,
		nsfw:  newNSFWService(classifier, c, log, cfg.NSFW.Concurrency),
		log:   log,
	}
}

type BatchHandler struct {
	runner *batchRunner
}

func NewBatchHandler(cfg config.PlatformConfig, al *allowlist.Allowlist, c *cache.Cache, f *fetcher.Fetcher, classifier nsfw.Classifier, log *slog.Logger) *BatchHandler {
	return &BatchHandler{runner: newBatchRunner(cfg, al, c, f, classifier, log)}
}

func (h *BatchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}

	body, ok := readBatchBody(w, r)
	if !ok {
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

	if msg := validateBatchItems(items); msg != "" {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
		return
	}

	log := h.runner.log.With("batchSize", len(items))
	log.Info("batch.request.start")

	response := h.runner.process(r.Context(), items, log)

	log.Info("batch.request.complete", "count", len(items))
	sendJSON(w, http.StatusOK, response)
}

// readBatchBody reads the request body with a sanity limit so a large inline
// base64 batch cannot exhaust memory in one request.
func readBatchBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			sendJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "Request body too large"})
		} else {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Failed to read request body"})
		}
		return nil, false
	}
	return body, true
}

// validateBatchItems checks the fields shared by the sync and async endpoints.
// It returns an empty string when every item is valid.
func validateBatchItems(items []batchRequestItem) string {
	uuids := make(map[string]bool)
	for _, item := range items {
		if item.UUID == "" {
			return "Each image must have a string uuid"
		}
		if uuids[item.UUID] {
			return fmt.Sprintf("Duplicate uuid: %s", item.UUID)
		}
		uuids[item.UUID] = true
		if item.URL == "" && item.Base64 == "" {
			return fmt.Sprintf("Missing url or base64 for uuid: %s", item.UUID)
		}
		if item.URL != "" && item.Base64 != "" {
			return fmt.Sprintf("Provide either url or base64, not both for uuid: %s", item.UUID)
		}
	}
	return ""
}

// decodeInlineSource decodes a base64 image, accepting an optional data URI
// prefix, and resolves its content type. maxBytes bounds the decoded size.
func decodeInlineSource(encoded, contentType string, maxBytes int) ([]byte, string, error) {
	if strings.HasPrefix(encoded, "data:") {
		comma := strings.IndexByte(encoded, ',')
		if comma < 0 {
			return nil, "", errors.New("base64 data URI is malformed")
		}
		meta := encoded[:comma]
		if !strings.HasSuffix(meta, ";base64") {
			return nil, "", errors.New("base64 data URI must be base64-encoded")
		}
		if contentType == "" {
			contentType = strings.TrimSuffix(strings.TrimPrefix(meta, "data:"), ";base64")
		}
		encoded = encoded[comma+1:]
	}

	if encoded == "" {
		return nil, "", errors.New("base64 image is empty")
	}
	if len(encoded) > base64.StdEncoding.EncodedLen(maxBytes) {
		return nil, "", fmt.Errorf("base64 image exceeds %d MB limit", maxBytes>>20)
	}
	buf, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, "", fmt.Errorf("invalid base64: %w", err)
	}
	if len(buf) > maxBytes {
		return nil, "", fmt.Errorf("base64 image exceeds %d MB limit", maxBytes>>20)
	}
	if contentType == "" {
		contentType = http.DetectContentType(buf)
	}
	return buf, contentType, nil
}

// inlineSourceKey gives inline bytes a stable cache identity that cannot
// collide with a real URL.
func inlineSourceKey(buf []byte) string {
	sum := sha256.Sum256(buf)
	return "inline:" + hex.EncodeToString(sum[:])
}

// process runs the two-phase batch pipeline: fetch sources, then process.
// NSFW predictions are cached per source URL and shared by all items that
// requested them.
func (r *batchRunner) process(ctx context.Context, items []batchRequestItem, log *slog.Logger) map[string]batchResponseItem {
	response := make(map[string]batchResponseItem)
	var responseMu sync.Mutex
	setResponse := func(uuid string, item batchResponseItem) {
		responseMu.Lock()
		response[uuid] = item
		responseMu.Unlock()
	}

	type pendingItem struct {
		uuid              string
		params            *params.Params
		isVideo           bool
		cachedImage       *cache.Entry
		inline            bool
		inlineBuffer      []byte
		inlineContentType string
	}
	var pending []pendingItem

	nsfwResults := make(map[string]*nsfw.Predictions)
	nsfwErrs := make(map[string]error)

	for _, item := range items {
		query := buildQueryFromParams(item.Params)

		var (
			p         *params.Params
			err       error
			inlineBuf []byte
			inlineCT  string
		)
		if item.Base64 != "" {
			inlineBuf, inlineCT, err = decodeInlineSource(item.Base64, item.ContentType, maxInlineImageBytes)
			if err != nil {
				setResponse(item.UUID, batchResponseItem{Success: false, Error: err.Error()})
				continue
			}
			p, err = params.ParseInline(inlineSourceKey(inlineBuf), query, r.cfg)
		} else {
			p, err = params.Parse(item.URL, query, r.cfg, r.al)
		}
		if err != nil {
			setResponse(item.UUID, batchResponseItem{Success: false, Error: err.Error()})
			continue
		}

		isInline := item.Base64 != ""
		isVideo := !isInline && videoExtensions.MatchString(p.URL)

		if p.Format == "json" {
			var data interface{}
			if isInline {
				data, err = r.handleInlineMetadata(p, inlineBuf, inlineCT, log)
			} else {
				data, err = r.handleMetadata(p, isVideo, log)
			}
			if err != nil {
				setResponse(item.UUID, batchResponseItem{Success: false, Error: err.Error()})
			} else {
				setResponse(item.UUID, batchResponseItem{Success: true, Data: data})
			}
			continue
		}

		// Fail fast instead of downloading/processing a source that can never
		// be classified.
		if p.NSFW && !r.nsfw.available() {
			setResponse(item.UUID, batchResponseItem{
				Success: false,
				Error:   "nsfw: classifier is not available",
			})
			continue
		}

		var cachedImage *cache.Entry
		if r.cache != nil {
			if entry, found := r.cache.Get(buildProcessedCacheKey(p)); found {
				cachedImage = entry
			}
		}

		var preds *nsfw.Predictions
		nsfwOK := false
		if p.NSFW {
			preds, nsfwOK = r.nsfw.Lookup(p.URL)
			if nsfwOK {
				nsfwResults[p.URL] = preds
			}
		}

		if cachedImage != nil && (!p.NSFW || nsfwOK) {
			var attached *nsfw.Predictions
			if p.NSFW {
				attached = preds
			}
			setResponse(item.UUID, batchResponseItem{
				Success: true,
				Data: imageData{
					Base64:      base64.StdEncoding.EncodeToString(cachedImage.Buffer),
					ContentType: cachedImage.ContentType,
					NSFW:        attached,
				},
			})
			continue
		}

		pending = append(pending, pendingItem{
			uuid:              item.UUID,
			params:            p,
			isVideo:           isVideo,
			cachedImage:       cachedImage,
			inline:            isInline,
			inlineBuffer:      inlineBuf,
			inlineContentType: inlineCT,
		})
	}

	// ---- phase 1: fetch every source URL needed by pending items ----
	type sourceEntry struct {
		buffer      []byte
		contentType string
		err         error
	}
	sourceCache := make(map[string]*sourceEntry)
	var sourceMu sync.Mutex

	// Inline sources need no download; seed the cache so phase 2 finds them.
	for _, item := range pending {
		if item.inline {
			sourceCache[item.params.URL] = &sourceEntry{
				buffer:      item.inlineBuffer,
				contentType: item.inlineContentType,
			}
		}
	}

	urlGroups := make(map[string][]int)
	for i, item := range pending {
		if item.inline {
			continue
		}
		urlGroups[item.params.URL] = append(urlGroups[item.params.URL], i)
	}

	var fetchWg sync.WaitGroup
	for url, indices := range urlGroups {
		fetchWg.Add(1)
		go func(url string, indices []int) {
			defer fetchWg.Done()
			isVideo := pending[indices[0]].isVideo
			entry := &sourceEntry{}

			if r.cache != nil {
				if cached, found := r.cache.Get(cache.BuildCacheKey("source", url)); found {
					entry.buffer = cached.Buffer
					entry.contentType = cached.ContentType
				}
			}

			if entry.buffer == nil {
				if isVideo {
					frame, err := processor.ExtractVideoFrame(url, r.fetch, log)
					if err != nil {
						entry.err = err
					} else {
						entry.buffer = frame
						entry.contentType = "image/jpeg"
					}
				} else {
					result, err := r.fetch.FetchImage(url)
					if err != nil {
						entry.err = err
					} else {
						entry.buffer = result.Buffer
						entry.contentType = result.ContentType
					}
				}

				if entry.err == nil && r.cache != nil {
					r.cache.Set(cache.BuildCacheKey("source", url), &cache.Entry{
						Buffer:      entry.buffer,
						ContentType: entry.contentType,
					})
				}
			}

			sourceMu.Lock()
			sourceCache[url] = entry
			sourceMu.Unlock()
		}(url, indices)
	}
	fetchWg.Wait()

	// ---- phase 1b: classify each URL at most once ----
	classified := make(map[string]bool)
	for _, item := range pending {
		if !item.params.NSFW {
			continue
		}
		url := item.params.URL
		if classified[url] {
			continue
		}
		classified[url] = true
		if _, ok := nsfwResults[url]; ok {
			continue
		}

		src := sourceCache[url]
		if src == nil || src.err != nil || src.buffer == nil {
			nsfwErrs[url] = errors.New("source unavailable")
			continue
		}

		preds, err := r.nsfw.ClassifySource(ctx, url, src.buffer)
		if err != nil {
			nsfwErrs[url] = err
			continue
		}
		nsfwResults[url] = preds
	}

	// ---- phase 2: process images ----
	var processWg sync.WaitGroup
	for _, item := range pending {
		item := item
		processWg.Add(1)
		go func() {
			defer processWg.Done()

			p := item.params
			url := p.URL
			src := sourceCache[url]
			preds, hasPreds := nsfwResults[url]
			nsfwErr := nsfwErrs[url]

			if item.cachedImage != nil {
				if nsfwErr != nil {
					setResponse(item.uuid, batchResponseItem{Success: false, Error: nsfwItemError(nsfwErr)})
					return
				}
				if !hasPreds || preds == nil {
					setResponse(item.uuid, batchResponseItem{Success: false, Error: "nsfw: prediction unavailable"})
					return
				}
				setResponse(item.uuid, batchResponseItem{
					Success: true,
					Data: imageData{
						Base64:      base64.StdEncoding.EncodeToString(item.cachedImage.Buffer),
						ContentType: item.cachedImage.ContentType,
						NSFW:        preds,
					},
				})
				return
			}

			if src == nil || src.err != nil || src.buffer == nil {
				setResponse(item.uuid, batchResponseItem{Success: false, Error: "Source fetch failed"})
				return
			}

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
				SourceContentType: src.contentType,
			}

			result, err := processor.ProcessImage(src.buffer, procParams, log)

			var buffer []byte
			var contentType string
			if err != nil {
				log.Warn("batch: process failed, returning original", "uuid", item.uuid, "error", err)
				buffer = src.buffer
				contentType = src.contentType
			} else {
				contentType = processor.FormatContentTypes[result.Format]
				if contentType == "" {
					contentType = "application/octet-stream"
				}
				buffer = result.Buffer
				if r.cache != nil {
					r.cache.Set(buildProcessedCacheKey(p), &cache.Entry{
						Buffer:      buffer,
						ContentType: contentType,
					})
				}
			}

			var attached *nsfw.Predictions
			if p.NSFW {
				if nsfwErr != nil {
					setResponse(item.uuid, batchResponseItem{Success: false, Error: nsfwItemError(nsfwErr)})
					return
				}
				if !hasPreds || preds == nil {
					setResponse(item.uuid, batchResponseItem{Success: false, Error: "nsfw: prediction unavailable"})
					return
				}
				attached = preds
			}

			setResponse(item.uuid, batchResponseItem{
				Success: true,
				Data: imageData{
					Base64:      base64.StdEncoding.EncodeToString(buffer),
					ContentType: contentType,
					NSFW:        attached,
				},
			})
		}()
	}
	processWg.Wait()

	return response
}

// nsfwItemError renders a classification error for a batch item, always with
// the "nsfw:" prefix required by the API contract.
func nsfwItemError(err error) string {
	if errors.Is(err, ErrNSFWUnavailable) {
		return "nsfw: classifier is not available"
	}
	msg := err.Error()
	if strings.HasPrefix(msg, "nsfw:") {
		return msg
	}
	return "nsfw: " + msg
}

func (r *batchRunner) handleMetadata(p *params.Params, isVideo bool, log *slog.Logger) (interface{}, error) {
	if r.cache != nil {
		key := cache.BuildCacheKey("meta", p.URL)
		if entry, found := r.cache.Get(key); found {
			var data interface{}
			json.Unmarshal(entry.Buffer, &data)
			return data, nil
		}
	}

	if isVideo {
		meta, err := processor.ProbeVideoMetadata(p.URL, r.fetch, log)
		if err != nil {
			return nil, err
		}
		data := map[string]interface{}{
			"width": meta.Width, "height": meta.Height,
			"codec": meta.Codec, "duration": meta.Duration,
			"format": meta.Format, "sourceUrl": p.URL, "sourceSize": meta.SourceSize,
		}
		r.cacheMetadata(p.URL, data)
		return data, nil
	}

	result, err := r.fetch.FetchImageRange(p.URL, fetcher.DefaultMetaRange)
	if err != nil {
		return nil, err
	}

	meta, err := processor.ProbeImageMetadata(result.Buffer, log)
	if err != nil {
		fullResult, fullErr := r.fetch.FetchImage(p.URL)
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
	r.cacheMetadata(p.URL, data)
	return data, nil
}

// handleInlineMetadata probes metadata directly from an inline source buffer
// instead of fetching it.
func (r *batchRunner) handleInlineMetadata(p *params.Params, buffer []byte, contentType string, log *slog.Logger) (interface{}, error) {
	if r.cache != nil {
		key := cache.BuildCacheKey("meta", p.URL)
		if entry, found := r.cache.Get(key); found {
			var data interface{}
			json.Unmarshal(entry.Buffer, &data)
			return data, nil
		}
	}

	meta, err := processor.ProbeImageMetadata(buffer, log)
	if err != nil {
		return nil, err
	}
	meta.SourceSize = int64(len(buffer))
	meta.SourceContentType = contentType

	data := map[string]interface{}{
		"width": meta.Width, "height": meta.Height,
		"format": meta.Format, "channels": meta.Channels,
		"sourceUrl": "inline", "sourceContentType": meta.SourceContentType,
		"sourceSize": meta.SourceSize,
	}
	r.cacheMetadata(p.URL, data)
	return data, nil
}

func (r *batchRunner) cacheMetadata(url string, data interface{}) {
	if r.cache == nil {
		return
	}
	jsonData, _ := json.Marshal(data)
	key := cache.BuildCacheKey("meta", url)
	r.cache.Set(key, &cache.Entry{Buffer: jsonData, ContentType: "application/json"})
}

func buildQueryFromParams(p map[string]interface{}) map[string][]string {
	query := make(map[string][]string)
	for k, v := range p {
		query[k] = []string{fmt.Sprintf("%v", v)}
	}
	return query
}
