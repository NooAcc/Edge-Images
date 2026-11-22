package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"edge-image/internal/allowlist"
	"edge-image/internal/cache"
	"edge-image/internal/fetcher"
	"edge-image/internal/nsfw"
	"edge-image/internal/params"
)

type decodedBatchItem struct {
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   string          `json:"error"`
}

type batchEnv struct {
	handler   *BatchHandler
	cache     *cache.Cache
	hits      *atomic.Int64
	sourceURL string
}

func newBatchEnv(t *testing.T, classifier nsfw.Classifier) *batchEnv {
	t.Helper()
	t.Setenv("IMAGE_URL_ALLOWLIST", "")

	c, err := cache.New(0, 1, t.TempDir(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)

	payload := pngBytes(t, 4, 4)
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "image/png")
		w.Write(payload)
	}))
	t.Cleanup(srv.Close)

	h := NewBatchHandler(testConfig(), allowlist.NewFromEnv(), c, fetcher.New(testLogger()), classifier, testLogger())
	return &batchEnv{
		handler:   h,
		cache:     c,
		hits:      &hits,
		sourceURL: srv.URL + "/img.png",
	}
}

func (e *batchEnv) do(t *testing.T, items []batchRequestItem) map[string]decodedBatchItem {
	t.Helper()
	body, err := json.Marshal(items)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/batch", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var resp map[string]decodedBatchItem
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	return resp
}

func nsfwParams() map[string]interface{} {
	return map[string]interface{}{"format": "png", "nsfw": "true"}
}

// post sends the items and returns the raw recorder so tests can assert on
// non-200 responses.
func (e *batchEnv) post(t *testing.T, items []batchRequestItem) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(items)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/batch", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return rec
}

func encodedPNG(t *testing.T) string {
	t.Helper()
	return base64.StdEncoding.EncodeToString(pngBytes(t, 4, 4))
}

func TestBatchNSFWData(t *testing.T) {
	fake := &fakeClassifier{preds: testPreds()}
	env := newBatchEnv(t, fake)

	resp := env.do(t, []batchRequestItem{
		{UUID: "a", URL: env.sourceURL, Params: nsfwParams()},
	})

	item, ok := resp["a"]
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
	if data.ContentType != "image/png" {
		t.Fatalf("contentType = %q", data.ContentType)
	}
	if _, err := base64.StdEncoding.DecodeString(data.Base64); err != nil {
		t.Fatalf("base64: %v", err)
	}
	if data.NSFW == nil || data.NSFW.Safe != 0.91 {
		t.Fatalf("nsfw = %+v", data.NSFW)
	}
	if fake.Calls() != 1 {
		t.Fatalf("classifier calls = %d, want 1", fake.Calls())
	}
}

func TestBatchNSFWSharedURLClassifiedOnce(t *testing.T) {
	fake := &fakeClassifier{preds: testPreds()}
	env := newBatchEnv(t, fake)

	resp := env.do(t, []batchRequestItem{
		{UUID: "a", URL: env.sourceURL, Params: nsfwParams()},
		{UUID: "b", URL: env.sourceURL, Params: nsfwParams()},
	})

	if !resp["a"].Success || !resp["b"].Success {
		t.Fatalf("resp = %+v", resp)
	}
	if fake.Calls() != 1 {
		t.Fatalf("classifier calls = %d, want 1", fake.Calls())
	}
	if env.hits.Load() != 1 {
		t.Fatalf("source fetches = %d, want 1", env.hits.Load())
	}
}

func TestBatchNSFWPartialFailure(t *testing.T) {
	fake := &fakeClassifier{preds: testPreds(), err: errTest}
	env := newBatchEnv(t, fake)

	resp := env.do(t, []batchRequestItem{
		{UUID: "with", URL: env.sourceURL, Params: nsfwParams()},
		{UUID: "without", URL: env.sourceURL, Params: map[string]interface{}{"format": "png"}},
	})

	if resp["with"].Success {
		t.Fatal("item that requested nsfw should fail")
	}
	if len(resp["with"].Error) == 0 {
		t.Fatal("missing error for nsfw item")
	}
	if !bytes.Contains([]byte(resp["with"].Error), []byte("nsfw:")) {
		t.Fatalf("error = %q, want nsfw: prefix", resp["with"].Error)
	}

	if !resp["without"].Success {
		t.Fatalf("item that did not request nsfw failed: %s", resp["without"].Error)
	}
}

func TestBatchNSFWProcessedCacheStillFetchesSource(t *testing.T) {
	fake := &fakeClassifier{preds: testPreds()}
	env := newBatchEnv(t, fake)

	item := batchRequestItem{UUID: "a", URL: env.sourceURL, Params: nsfwParams()}
	p, err := params.Parse(item.URL, buildQueryFromParams(item.Params), testConfig(), allowlist.NewFromEnv())
	if err != nil {
		t.Fatal(err)
	}
	env.cache.Set(buildProcessedCacheKey(p), &cache.Entry{
		Buffer:      pngBytes(t, 4, 4),
		ContentType: "image/png",
	})

	resp := env.do(t, []batchRequestItem{item})
	if !resp["a"].Success {
		t.Fatalf("a failed: %s", resp["a"].Error)
	}
	if env.hits.Load() != 1 {
		t.Fatalf("source fetches = %d, want 1", env.hits.Load())
	}
	if fake.Calls() != 1 {
		t.Fatalf("classifier calls = %d, want 1", fake.Calls())
	}

	var data imageData
	if err := json.Unmarshal(resp["a"].Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.NSFW == nil {
		t.Fatal("missing nsfw")
	}
}

func TestBatchWithoutNSFWShape(t *testing.T) {
	env := newBatchEnv(t, &fakeClassifier{preds: testPreds()})

	resp := env.do(t, []batchRequestItem{
		{UUID: "a", URL: env.sourceURL, Params: map[string]interface{}{"format": "png"}},
	})
	if !resp["a"].Success {
		t.Fatalf("a failed: %s", resp["a"].Error)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(resp["a"].Data, &raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw["nsfw"]; ok {
		t.Fatal("nsfw field present for a request that did not ask for it")
	}
	if _, ok := raw["base64"]; !ok {
		t.Fatal("missing base64")
	}
	if _, ok := raw["contentType"]; !ok {
		t.Fatal("missing contentType")
	}
}

func TestBatchNSFWClassifierUnavailableSkipsSource(t *testing.T) {
	env := newBatchEnv(t, nil)

	resp := env.do(t, []batchRequestItem{
		// Distinct URLs: only the non-nsfw item should cause a fetch.
		{UUID: "a", URL: env.sourceURL + "?a", Params: nsfwParams()},
		{UUID: "b", URL: env.sourceURL + "?b", Params: map[string]interface{}{"format": "png"}},
	})

	if resp["a"].Success {
		t.Fatal("nsfw item should fail when the classifier is unavailable")
	}
	if !strings.Contains(resp["a"].Error, "nsfw:") {
		t.Fatalf("error = %q, want nsfw: prefix", resp["a"].Error)
	}
	if !resp["b"].Success {
		t.Fatalf("non-nsfw item failed: %s", resp["b"].Error)
	}
	if env.hits.Load() != 1 {
		t.Fatalf("source fetches = %d, want 1 (nsfw item must not fetch)", env.hits.Load())
	}
}

func TestBatchBase64Source(t *testing.T) {
	env := newBatchEnv(t, nil)

	resp := env.do(t, []batchRequestItem{
		{UUID: "a", Base64: encodedPNG(t), ContentType: "image/png", Params: map[string]interface{}{"format": "png"}},
	})

	item := resp["a"]
	if !item.Success {
		t.Fatalf("a failed: %s", item.Error)
	}

	var data imageData
	if err := json.Unmarshal(item.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.ContentType != "image/png" {
		t.Fatalf("contentType = %q, want image/png", data.ContentType)
	}
	out, err := base64.StdEncoding.DecodeString(data.Base64)
	if err != nil {
		t.Fatalf("base64: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("empty output")
	}
	if env.hits.Load() != 0 {
		t.Fatalf("source fetches = %d, want 0", env.hits.Load())
	}
}

func TestBatchBase64BypassesAllowlist(t *testing.T) {
	t.Setenv("IMAGE_URL_ALLOWLIST", "allowed.example")

	c, err := cache.New(0, 1, t.TempDir(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)

	h := NewBatchHandler(testConfig(), allowlist.NewFromEnv(), c, fetcher.New(testLogger()), nil, testLogger())
	env := &batchEnv{handler: h, cache: c, hits: &atomic.Int64{}}

	resp := env.do(t, []batchRequestItem{
		{UUID: "a", Base64: encodedPNG(t), Params: map[string]interface{}{"format": "png"}},
	})

	if !resp["a"].Success {
		t.Fatalf("a failed: %s", resp["a"].Error)
	}
}

func TestBatchBase64InfersContentTypeForMetadata(t *testing.T) {
	env := newBatchEnv(t, nil)
	payload := pngBytes(t, 4, 4)

	resp := env.do(t, []batchRequestItem{
		{UUID: "a", Base64: base64.StdEncoding.EncodeToString(payload), Params: map[string]interface{}{"format": "json"}},
	})

	item := resp["a"]
	if !item.Success {
		t.Fatalf("a failed: %s", item.Error)
	}

	var data map[string]interface{}
	if err := json.Unmarshal(item.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data["sourceContentType"] != "image/png" {
		t.Fatalf("sourceContentType = %v, want image/png", data["sourceContentType"])
	}
	if data["sourceUrl"] != "inline" {
		t.Fatalf("sourceUrl = %v, want inline", data["sourceUrl"])
	}
	if data["sourceSize"].(float64) != float64(len(payload)) {
		t.Fatalf("sourceSize = %v, want %d", data["sourceSize"], len(payload))
	}
	if data["width"].(float64) != 4 || data["height"].(float64) != 4 {
		t.Fatalf("dimensions = %vx%v, want 4x4", data["width"], data["height"])
	}
	if env.hits.Load() != 0 {
		t.Fatalf("source fetches = %d, want 0", env.hits.Load())
	}
}

func TestBatchBase64AcceptsDataURIPrefix(t *testing.T) {
	env := newBatchEnv(t, nil)
	payload := pngBytes(t, 4, 4)
	encoded := "data:image/png;base64," + base64.StdEncoding.EncodeToString(payload)

	resp := env.do(t, []batchRequestItem{
		{UUID: "a", Base64: encoded, Params: map[string]interface{}{"format": "json"}},
	})

	item := resp["a"]
	if !item.Success {
		t.Fatalf("a failed: %s", item.Error)
	}

	var data map[string]interface{}
	if err := json.Unmarshal(item.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data["sourceContentType"] != "image/png" {
		t.Fatalf("sourceContentType = %v, want image/png", data["sourceContentType"])
	}
}

func TestBatchRejectsURLAndBase64Together(t *testing.T) {
	env := newBatchEnv(t, nil)

	rec := env.post(t, []batchRequestItem{
		{UUID: "a", URL: env.sourceURL, Base64: encodedPNG(t)},
	})

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "not both") {
		t.Fatalf("body = %s, want mention of mutual exclusion", rec.Body.String())
	}
	if env.hits.Load() != 0 {
		t.Fatalf("source fetches = %d, want 0", env.hits.Load())
	}
}

func TestBatchRejectsMissingSource(t *testing.T) {
	env := newBatchEnv(t, nil)

	rec := env.post(t, []batchRequestItem{{UUID: "a"}})

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "url or base64") {
		t.Fatalf("body = %s, want mention of url or base64", rec.Body.String())
	}
}

func TestBatchRejectsInvalidBase64(t *testing.T) {
	env := newBatchEnv(t, nil)

	resp := env.do(t, []batchRequestItem{
		{UUID: "a", Base64: "not*valid*base64", Params: map[string]interface{}{"format": "png"}},
	})

	if resp["a"].Success {
		t.Fatal("item with invalid base64 should fail")
	}
	if !strings.Contains(strings.ToLower(resp["a"].Error), "base64") {
		t.Fatalf("error = %q, want mention of base64", resp["a"].Error)
	}
	if env.hits.Load() != 0 {
		t.Fatalf("source fetches = %d, want 0", env.hits.Load())
	}
}

func TestBatchBase64SharedContentClassifiedOnce(t *testing.T) {
	fake := &fakeClassifier{preds: testPreds()}
	env := newBatchEnv(t, fake)
	encoded := encodedPNG(t)

	resp := env.do(t, []batchRequestItem{
		{UUID: "a", Base64: encoded, Params: nsfwParams()},
		{UUID: "b", Base64: encoded, Params: nsfwParams()},
	})

	if !resp["a"].Success || !resp["b"].Success {
		t.Fatalf("resp = %+v", resp)
	}
	if fake.Calls() != 1 {
		t.Fatalf("classifier calls = %d, want 1", fake.Calls())
	}
	if env.hits.Load() != 0 {
		t.Fatalf("source fetches = %d, want 0", env.hits.Load())
	}

	var data imageData
	if err := json.Unmarshal(resp["a"].Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.NSFW == nil {
		t.Fatal("missing nsfw")
	}
}

func TestDecodeInlineSourceRejectsOversized(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString(make([]byte, 16))

	_, _, err := decodeInlineSource(encoded, "", 8)
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("err = %v, want size limit error", err)
	}
}
