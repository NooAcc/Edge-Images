package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"edge-image/internal/allowlist"
	"edge-image/internal/cache"
	"edge-image/internal/config"
	"edge-image/internal/fetcher"
	"edge-image/internal/nsfw"
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
// Inline base64 payloads are intentionally not echoed.
type callbackItem struct {
	UUID        string                 `json:"uuid"`
	URL         string                 `json:"url"`
	ContentType string                 `json:"contentType,omitempty"`
	Params      map[string]interface{} `json:"params"`
}

// AsyncBatchHandler processes batches asynchronously and POSTs results to a callback URL.
type AsyncBatchHandler struct {
	runner *batchRunner
}

func NewAsyncBatchHandler(cfg config.PlatformConfig, al *allowlist.Allowlist, c *cache.Cache, f *fetcher.Fetcher, classifier nsfw.Classifier, log *slog.Logger) *AsyncBatchHandler {
	return &AsyncBatchHandler{runner: newBatchRunner(cfg, al, c, f, classifier, log)}
}

func (h *AsyncBatchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		sendJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method Not Allowed"})
		return
	}

	body, ok := readBatchBody(w, r)
	if !ok {
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

	if len(req.Items) > maxAsyncBatchImages {
		sendJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("Maximum %d images allowed per async batch", maxAsyncBatchImages),
		})
		return
	}

	if req.CallbackURL == "" {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "callbackUrl is required"})
		return
	}

	if len(req.CallbackURL) < 8 || (req.CallbackURL[:7] != "http://" && req.CallbackURL[:8] != "https://") {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "callbackUrl must be a valid http/https URL"})
		return
	}

	jobID := req.JobID
	if jobID == "" {
		jobID = fmt.Sprintf("ej-%d", time.Now().UnixNano())
	}

	// Validate items
	if msg := validateBatchItems(req.Items); msg != "" {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
		return
	}

	log := h.runner.log.With("jobId", jobID, "batchSize", len(req.Items), "callbackUrl", req.CallbackURL)
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

	// The HTTP request context is already finished by the time this runs.
	response := h.runner.process(context.Background(), items, log)

	elapsed := time.Since(start)
	log.Info("asyncBatch.processing.complete", "duration", elapsed.String(), "count", len(items))

	// Build callback items (preserves original request for each UUID)
	callbackItems := make([]callbackItem, len(items))
	for i, item := range items {
		callbackItems[i] = callbackItem{
			UUID:        item.UUID,
			URL:         item.URL,
			ContentType: item.ContentType,
			Params:      item.Params,
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
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; EdgeImage/1.0)")

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
