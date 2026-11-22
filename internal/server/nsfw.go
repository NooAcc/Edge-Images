package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"

	"edge-image/internal/cache"
	"edge-image/internal/nsfw"
	"edge-image/internal/processor"
)

// ErrNSFWUnavailable is returned when the classifier could not be initialized
// (missing model or ONNX Runtime library, or invalid configuration).
var ErrNSFWUnavailable = errors.New("nsfw classifier is not available")

// nsfwService couples a classifier with the per-source-URL prediction cache.
type nsfwService struct {
	classifier nsfw.Classifier
	cache      *cache.Cache
	log        *slog.Logger
	// sem bounds the whole decode+inference pipeline, not just Run, so
	// NSFW_CONCURRENCY also limits full-resolution vips decodes.
	sem chan struct{}
}

func newNSFWService(classifier nsfw.Classifier, c *cache.Cache, log *slog.Logger, concurrency int) *nsfwService {
	if concurrency < 1 {
		concurrency = 1
	}
	s := &nsfwService{classifier: classifier, cache: c, log: log}
	if classifier != nil {
		s.sem = make(chan struct{}, concurrency)
	}
	return s
}

func (s *nsfwService) available() bool {
	return s != nil && s.classifier != nil
}

// nsfwCacheKey includes the model content hash and threshold so changing
// either invalidates old predictions.
func nsfwCacheKey(classifier nsfw.Classifier, url string) string {
	return cache.BuildCacheKey("nsfw", url,
		classifier.ModelID(),
		strconv.FormatFloat(float64(classifier.Threshold()), 'f', 4, 32),
	)
}

// Lookup returns a cached prediction for the source URL.
func (s *nsfwService) Lookup(url string) (*nsfw.Predictions, bool) {
	if s == nil || s.classifier == nil || s.cache == nil {
		return nil, false
	}
	entry, ok := s.cache.Get(nsfwCacheKey(s.classifier, url))
	if !ok || entry == nil {
		return nil, false
	}
	var preds nsfw.Predictions
	if err := json.Unmarshal(entry.Buffer, &preds); err != nil {
		return nil, false
	}
	return &preds, true
}

// ClassifySource classifies the source image (not the processed output) and
// caches the result by source URL. It returns ErrNSFWUnavailable when no
// classifier is configured.
func (s *nsfwService) ClassifySource(ctx context.Context, url string, source []byte) (*nsfw.Predictions, error) {
	if s == nil || s.classifier == nil {
		return nil, ErrNSFWUnavailable
	}
	if preds, ok := s.Lookup(url); ok {
		return preds, nil
	}

	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return nil, fmt.Errorf("nsfw: %w", ctx.Err())
	}

	rgb, width, height, err := processor.PrepareNSFWInput(source)
	if err != nil {
		return nil, fmt.Errorf("nsfw: %w", err)
	}

	preds, err := s.classifier.Classify(ctx, rgb, width, height)
	if err != nil {
		return nil, fmt.Errorf("nsfw: %w", err)
	}

	if s.log != nil {
		s.log.Debug("nsfw: classified", "url", url, "isNsfw", preds.IsNsfw)
	}

	if s.cache != nil {
		if data, err := json.Marshal(preds); err == nil {
			s.cache.Set(nsfwCacheKey(s.classifier, url), &cache.Entry{
				Buffer:      data,
				ContentType: "application/json",
			})
		}
	}

	return preds, nil
}

// imageData is the successful data payload for one batch item.
type imageData struct {
	Base64      string            `json:"base64"`
	ContentType string            `json:"contentType"`
	NSFW        *nsfw.Predictions `json:"nsfw,omitempty"`
}

// nsfwImageResponse is the single-image response when NSFW classification is enabled.
type nsfwImageResponse struct {
	Width       int               `json:"width"`
	Height      int               `json:"height"`
	Format      string            `json:"format"`
	ContentType string            `json:"contentType"`
	Image       string            `json:"image"`
	NSFW        *nsfw.Predictions `json:"nsfw"`
}

func buildNSFWImageResponse(buffer []byte, contentType, format string, width, height int, preds *nsfw.Predictions) ([]byte, error) {
	return json.Marshal(nsfwImageResponse{
		Width:       width,
		Height:      height,
		Format:      format,
		ContentType: contentType,
		Image:       base64.StdEncoding.EncodeToString(buffer),
		NSFW:        preds,
	})
}
