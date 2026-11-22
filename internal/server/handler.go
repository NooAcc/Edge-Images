package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"edge-image/internal/allowlist"
	"edge-image/internal/cache"
	"edge-image/internal/config"
	"edge-image/internal/fetcher"
	"edge-image/internal/nsfw"
	"edge-image/internal/params"
	"edge-image/internal/processor"
)

const (
	cacheControl  = "public, max-age=31536000, immutable"
	processorName = "edge-image"
	mediaRoute    = "/api/media/"
)

var videoExtensions = regexp.MustCompile(`\.(mp4|webm)(\?.*)?$`)

type Handler struct {
	cfg   config.PlatformConfig
	al    *allowlist.Allowlist
	cache *cache.Cache
	fetch *fetcher.Fetcher
	nsfw  *nsfwService
	log   *slog.Logger

	// processImage is a seam so tests can exercise the degraded-original path.
	processImage func([]byte, processor.ImageParams, *slog.Logger) (*processor.ImageResult, error)
}

func NewHandler(cfg config.PlatformConfig, al *allowlist.Allowlist, c *cache.Cache, f *fetcher.Fetcher, classifier nsfw.Classifier, log *slog.Logger) *Handler {
	return &Handler{
		cfg:          cfg,
		al:           al,
		cache:        c,
		fetch:        f,
		nsfw:         newNSFWService(classifier, c, log, cfg.NSFW.Concurrency),
		log:          log,
		processImage: processor.ProcessImage,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}

	sourceURL := extractSourceURL(r)
	if sourceURL == "" {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing source URL"})
		return
	}

	p, err := params.Parse(sourceURL, r.URL.Query(), h.cfg, h.al)
	if err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	isVideo := videoExtensions.MatchString(p.URL)
	log := h.log.With("sourceUrl", p.URL, "isVideo", isVideo)

	if p.Format == "json" {
		h.handleMetadata(w, p, isVideo, log)
		return
	}

	if p.NSFWJS && !h.nsfw.available() {
		h.writeNSFWError(w, log, ErrNSFWUnavailable)
		return
	}

	var cachedEntry *cache.Entry
	if h.cache != nil {
		key := buildProcessedCacheKey(p)
		if entry, found := h.cache.Get(key); found {
			cachedEntry = entry
		}
	}

	var preds *nsfw.Predictions
	predsOK := false
	if p.NSFWJS {
		preds, predsOK = h.nsfw.Lookup(p.URL)
	}

	// Unchanged fast path: processed cache hit without nsfwjs.
	if cachedEntry != nil && !p.NSFWJS {
		w.Header().Set("Content-Type", cachedEntry.ContentType)
		w.Header().Set("Cache-Control", cacheControl)
		w.Header().Set("X-Processor", processorName)
		w.Header().Set("X-Cache", "HIT")
		w.Write(cachedEntry.Buffer)
		return
	}

	// Processed image is cached but nsfwjs was requested.
	if cachedEntry != nil {
		meta, err := processor.ProbeImageMetadata(cachedEntry.Buffer, log)
		if err != nil {
			h.writeNSFWError(w, log, fmt.Errorf("nsfwjs: probe cached image: %w", err))
			return
		}

		if !predsOK {
			source, _, err := h.fetchSource(p, isVideo, log)
			if err != nil {
				h.writeNSFWError(w, log, fmt.Errorf("nsfwjs: fetch source: %w", err))
				return
			}
			preds, err = h.nsfw.ClassifySource(r.Context(), p.URL, source)
			if err != nil {
				h.writeNSFWError(w, log, err)
				return
			}
		}

		body, err := buildNSFWImageResponse(cachedEntry.Buffer, cachedEntry.ContentType,
			meta.Format, meta.Width, meta.Height, preds)
		if err != nil {
			h.writeNSFWError(w, log, fmt.Errorf("nsfwjs: encode response: %w", err))
			return
		}
		h.writeNSFWImage(w, body, meta.Width, meta.Height, meta.Format, len(cachedEntry.Buffer), true, "")
		return
	}

	sourceBuffer, sourceContentType, err := h.fetchSource(p, isVideo, log)
	if err != nil {
		log.Warn("handler: fetch failed", "error", err)
		sendJSON(w, http.StatusBadGateway, map[string]string{
			"error":   "Bad Gateway",
			"details": sanitizeHeader(err.Error()),
		})
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
		SourceContentType: sourceContentType,
	}

	result, err := h.processImage(sourceBuffer, procParams, log)
	if err != nil {
		log.Warn("handler: processing failed, returning original", "error", err)
		procErr := err

		if !p.NSFWJS {
			w.Header().Set("Content-Type", sourceContentType)
			w.Header().Set("Cache-Control", cacheControl)
			w.Header().Set("X-Processor", processorName)
			w.Header().Set("X-Processing-Error", sanitizeHeader(procErr.Error()))
			w.Write(sourceBuffer)
			return
		}

		if !predsOK {
			var classifyErr error
			preds, classifyErr = h.nsfw.ClassifySource(r.Context(), p.URL, sourceBuffer)
			if classifyErr != nil {
				h.writeNSFWError(w, log, classifyErr)
				return
			}
		}
		meta, metaErr := processor.ProbeImageMetadata(sourceBuffer, log)
		if metaErr != nil {
			h.writeNSFWError(w, log, fmt.Errorf("nsfwjs: probe original: %w", metaErr))
			return
		}
		body, encodeErr := buildNSFWImageResponse(sourceBuffer, sourceContentType,
			meta.Format, meta.Width, meta.Height, preds)
		if encodeErr != nil {
			h.writeNSFWError(w, log, fmt.Errorf("nsfwjs: encode response: %w", encodeErr))
			return
		}
		h.writeNSFWImage(w, body, meta.Width, meta.Height, meta.Format, len(sourceBuffer), false, procErr.Error())
		return
	}

	outputContentType := processor.FormatContentTypes[result.Format]
	if outputContentType == "" {
		outputContentType = "application/octet-stream"
	}

	if h.cache != nil {
		key := buildProcessedCacheKey(p)
		h.cache.Set(key, &cache.Entry{
			Buffer:      result.Buffer,
			ContentType: outputContentType,
		})
	}

	if !p.NSFWJS {
		w.Header().Set("Content-Type", outputContentType)
		w.Header().Set("Cache-Control", cacheControl)
		w.Header().Set("X-Processor", processorName)
		w.Header().Set("X-Image-Width", fmt.Sprintf("%d", result.Width))
		w.Header().Set("X-Image-Height", fmt.Sprintf("%d", result.Height))
		w.Header().Set("X-Image-Format", result.Format)
		w.Header().Set("X-Image-Size", fmt.Sprintf("%d", result.Size))
		w.Write(result.Buffer)
		return
	}

	if !predsOK {
		preds, err = h.nsfw.ClassifySource(r.Context(), p.URL, sourceBuffer)
		if err != nil {
			h.writeNSFWError(w, log, err)
			return
		}
	}

	body, err := buildNSFWImageResponse(result.Buffer, outputContentType,
		result.Format, result.Width, result.Height, preds)
	if err != nil {
		h.writeNSFWError(w, log, fmt.Errorf("nsfwjs: encode response: %w", err))
		return
	}
	h.writeNSFWImage(w, body, result.Width, result.Height, result.Format, len(result.Buffer), false, "")
}

// fetchSource returns the source bytes and content type, using the source
// cache for images (videos always go through frame extraction).
func (h *Handler) fetchSource(p *params.Params, isVideo bool, log *slog.Logger) ([]byte, string, error) {
	if isVideo {
		frame, err := processor.ExtractVideoFrame(p.URL, h.fetch, log)
		if err != nil {
			return nil, "", err
		}
		return frame, "image/jpeg", nil
	}

	if h.cache != nil {
		sourceKey := cache.BuildCacheKey("source", p.URL)
		if entry, found := h.cache.Get(sourceKey); found {
			return entry.Buffer, entry.ContentType, nil
		}
	}

	result, err := h.fetch.FetchImage(p.URL)
	if err != nil {
		return nil, "", err
	}

	if h.cache != nil {
		sourceKey := cache.BuildCacheKey("source", p.URL)
		h.cache.Set(sourceKey, &cache.Entry{
			Buffer:      result.Buffer,
			ContentType: result.ContentType,
		})
	}

	return result.Buffer, result.ContentType, nil
}

func (h *Handler) writeNSFWImage(w http.ResponseWriter, body []byte, width, height int, format string, size int, cacheHit bool, processingErr string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", cacheControl)
	w.Header().Set("X-Processor", processorName)
	w.Header().Set("X-Image-Width", strconv.Itoa(width))
	w.Header().Set("X-Image-Height", strconv.Itoa(height))
	w.Header().Set("X-Image-Format", format)
	w.Header().Set("X-Image-Size", strconv.Itoa(size))
	if cacheHit {
		w.Header().Set("X-Cache", "HIT")
	}
	if processingErr != "" {
		w.Header().Set("X-Processing-Error", sanitizeHeader(processingErr))
	}
	w.Write(body)
}

func (h *Handler) writeNSFWError(w http.ResponseWriter, log *slog.Logger, err error) {
	if errors.Is(err, ErrNSFWUnavailable) {
		sendJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error":   "Service Unavailable",
			"details": "nsfwjs classifier is not available",
		})
		return
	}

	log.Warn("handler: nsfw classification failed", "error", err)
	sendJSON(w, http.StatusBadGateway, map[string]string{
		"error":   "Bad Gateway",
		"details": sanitizeHeader(err.Error()),
	})
}

func (h *Handler) handleMetadata(w http.ResponseWriter, p *params.Params, isVideo bool, log *slog.Logger) {
	if h.cache != nil {
		key := cache.BuildCacheKey("meta", p.URL)
		if entry, found := h.cache.Get(key); found {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", cacheControl)
			w.Header().Set("X-Processor", processorName)
			w.Write(entry.Buffer)
			return
		}
	}

	var data interface{}

	if isVideo {
		meta, err := processor.ProbeVideoMetadata(p.URL, h.fetch, log)
		if err != nil {
			log.Warn("handler: video probe failed", "error", err)
			sendJSON(w, http.StatusBadGateway, map[string]string{
				"error":   "Bad Gateway",
				"details": sanitizeHeader(err.Error()),
			})
			return
		}
		data = map[string]interface{}{
			"width":      meta.Width,
			"height":     meta.Height,
			"codec":      meta.Codec,
			"duration":   meta.Duration,
			"format":     meta.Format,
			"sourceUrl":  p.URL,
			"sourceSize": meta.SourceSize,
		}
	} else {
		// Check source cache first — a prior image processing request may have cached the full source bytes
		var sourceBuffer []byte
		var sourceContentType string
		if h.cache != nil {
			sourceKey := cache.BuildCacheKey("source", p.URL)
			if entry, found := h.cache.Get(sourceKey); found {
				sourceBuffer = entry.Buffer
				sourceContentType = entry.ContentType
			}
		}

		if sourceBuffer == nil {
			result, err := h.fetch.FetchImageRange(p.URL, fetcher.DefaultMetaRange)
			if err != nil {
				log.Warn("handler: image metadata fetch failed", "error", err)
				sendJSON(w, http.StatusBadGateway, map[string]string{
					"error":   "Bad Gateway",
					"details": sanitizeHeader(err.Error()),
				})
				return
			}
			sourceBuffer = result.Buffer
			sourceContentType = result.ContentType
		}

		meta, err := processor.ProbeImageMetadata(sourceBuffer, log)
		if err != nil {
			if len(sourceBuffer) >= int(fetcher.DefaultMetaRange) {
				// Partial download probe failed — try full download
				log.Warn("handler: image probe failed, trying full download", "error", err)
				fullResult, fullErr := h.fetch.FetchImage(p.URL)
				if fullErr != nil {
					sendJSON(w, http.StatusBadGateway, map[string]string{
						"error":   "Bad Gateway",
						"details": sanitizeHeader(fullErr.Error()),
					})
					return
				}
				sourceBuffer = fullResult.Buffer
				sourceContentType = fullResult.ContentType
				if h.cache != nil {
					sourceKey := cache.BuildCacheKey("source", p.URL)
					h.cache.Set(sourceKey, &cache.Entry{
						Buffer:      sourceBuffer,
						ContentType: sourceContentType,
					})
				}
				meta, err = processor.ProbeImageMetadata(sourceBuffer, log)
				if err != nil {
					sendJSON(w, http.StatusBadGateway, map[string]string{
						"error":   "Bad Gateway",
						"details": sanitizeHeader(err.Error()),
					})
					return
				}
			} else {
				sendJSON(w, http.StatusBadGateway, map[string]string{
					"error":   "Bad Gateway",
					"details": sanitizeHeader(err.Error()),
				})
				return
			}
		}
		meta.SourceSize = int64(len(sourceBuffer))
		meta.SourceContentType = sourceContentType

		data = map[string]interface{}{
			"width":             meta.Width,
			"height":            meta.Height,
			"format":            meta.Format,
			"channels":          meta.Channels,
			"sourceUrl":         p.URL,
			"sourceContentType": meta.SourceContentType,
			"sourceSize":        meta.SourceSize,
		}
	}

	jsonData, _ := json.Marshal(data)

	if h.cache != nil {
		key := cache.BuildCacheKey("meta", p.URL)
		h.cache.Set(key, &cache.Entry{
			Buffer:      jsonData,
			ContentType: "application/json",
		})
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", cacheControl)
	w.Header().Set("X-Processor", processorName)
	w.Write(jsonData)
}

func extractSourceURL(r *http.Request) string {
	path := r.URL.Path
	if strings.HasPrefix(path, mediaRoute) {
		encoded := path[len(mediaRoute):]
		if encoded == "" {
			return ""
		}
		decoded, err := decodePercentEncoding(encoded)
		if err != nil {
			return ""
		}
		return decoded
	}

	source := r.URL.Query().Get("source")
	if source != "" {
		if strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") {
			return source
		}
		decoded, err := decodePercentEncoding(source)
		if err != nil {
			return ""
		}
		return decoded
	}

	return ""
}

func decodePercentEncoding(s string) (string, error) {
	var result strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' {
			if i+2 >= len(s) {
				return "", fmt.Errorf("invalid percent encoding")
			}
			high := hexDigit(s[i+1])
			low := hexDigit(s[i+2])
			if high < 0 || low < 0 {
				return "", fmt.Errorf("invalid percent encoding")
			}
			result.WriteByte(byte(high*16 + low))
			i += 2
		} else {
			result.WriteByte(s[i])
		}
	}
	return result.String(), nil
}

func hexDigit(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	default:
		return -1
	}
}

func sanitizeHeader(value string) string {
	var result strings.Builder
	for _, r := range value {
		if r >= 32 && r <= 126 {
			result.WriteRune(r)
		} else {
			result.WriteRune(' ')
		}
		if result.Len() >= 180 {
			break
		}
	}
	return result.String()
}

func sendJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func buildProcessedCacheKey(p *params.Params) string {
	return cache.BuildCacheKey("processed", p.URL,
		fmt.Sprintf("%d", p.Width), fmt.Sprintf("%d", p.Height),
		p.Crop, p.Size, fmt.Sprintf("%d", p.Quality), p.Format,
		fmt.Sprintf("%d", p.Rotate), p.Flip)
}
