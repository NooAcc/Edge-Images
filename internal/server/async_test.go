package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"edge-image/internal/allowlist"
	"edge-image/internal/cache"
	"edge-image/internal/fetcher"
)

func TestAsyncBatchNSFW(t *testing.T) {
	t.Setenv("IMAGE_URL_ALLOWLIST", "")

	c, err := cache.New(0, 1, t.TempDir(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	payload := pngBytes(t, 4, 4)
	var hits atomic.Int64
	src := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "image/png")
		w.Write(payload)
	}))
	defer src.Close()

	fake := &fakeClassifier{preds: testPreds()}

	var callbackBody atomic.Value
	callback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		callbackBody.Store(string(body))
		w.WriteHeader(http.StatusOK)
	}))
	defer callback.Close()

	h := NewAsyncBatchHandler(testConfig(), allowlist.NewFromEnv(), c, fetcher.New(testLogger()), fake, testLogger())
	items := []batchRequestItem{
		{UUID: "a", URL: src.URL + "/img.png", Params: nsfwParams()},
	}

	h.processAsync("job-1", items, callback.URL, testLogger())

	raw, ok := callbackBody.Load().(string)
	if !ok {
		t.Fatal("callback was not delivered")
	}

	var cb struct {
		Results map[string]decodedBatchItem `json:"results"`
	}
	if err := json.Unmarshal([]byte(raw), &cb); err != nil {
		t.Fatal(err)
	}
	item, ok := cb.Results["a"]
	if !ok {
		t.Fatal("missing result for a")
	}
	if !item.Success {
		t.Fatalf("a failed: %s", item.Error)
	}

	var data imageData
	if err := json.Unmarshal(item.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.NSFW == nil || data.NSFW.Neutral != 0.91 {
		t.Fatalf("nsfw = %+v", data.NSFW)
	}
	if fake.Calls() != 1 {
		t.Fatalf("classifier calls = %d, want 1", fake.Calls())
	}
}

func TestAsyncBatchBase64(t *testing.T) {
	t.Setenv("IMAGE_URL_ALLOWLIST", "")

	c, err := cache.New(0, 1, t.TempDir(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	var callbackBody atomic.Value
	callback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		callbackBody.Store(string(body))
		w.WriteHeader(http.StatusOK)
	}))
	defer callback.Close()

	fake := &fakeClassifier{preds: testPreds()}
	h := NewAsyncBatchHandler(testConfig(), allowlist.NewFromEnv(), c, fetcher.New(testLogger()), fake, testLogger())
	encoded := base64.StdEncoding.EncodeToString(pngBytes(t, 4, 4))
	items := []batchRequestItem{
		{UUID: "a", Base64: encoded, ContentType: "image/png", Params: nsfwParams()},
	}

	h.processAsync("job-1", items, callback.URL, testLogger())

	raw, ok := callbackBody.Load().(string)
	if !ok {
		t.Fatal("callback was not delivered")
	}

	var cb struct {
		Results map[string]decodedBatchItem `json:"results"`
	}
	if err := json.Unmarshal([]byte(raw), &cb); err != nil {
		t.Fatal(err)
	}
	item, ok := cb.Results["a"]
	if !ok {
		t.Fatal("missing result for a")
	}
	if !item.Success {
		t.Fatalf("a failed: %s", item.Error)
	}

	var data imageData
	if err := json.Unmarshal(item.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.NSFW == nil || data.NSFW.Neutral != 0.91 {
		t.Fatalf("nsfw = %+v", data.NSFW)
	}
	if fake.Calls() != 1 {
		t.Fatalf("classifier calls = %d, want 1", fake.Calls())
	}
}

func TestAsyncBatchRejectsURLAndBase64Together(t *testing.T) {
	t.Setenv("IMAGE_URL_ALLOWLIST", "")

	h := NewAsyncBatchHandler(testConfig(), allowlist.NewFromEnv(), nil, fetcher.New(testLogger()), nil, testLogger())
	body, err := json.Marshal(asyncBatchRequest{
		Items: []batchRequestItem{
			{UUID: "a", URL: "https://example.com/a.png", Base64: "abc"},
		},
		CallbackURL: "https://example.com/cb",
	})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/batch/async", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "not both") {
		t.Fatalf("body = %s, want mention of mutual exclusion", rec.Body.String())
	}
}
