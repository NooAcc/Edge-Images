package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	return map[string]interface{}{"format": "png", "nsfwjs": "true"}
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
	if data.NSFW == nil || data.NSFW.Neutral != 0.91 {
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
		t.Fatal("item that requested nsfwjs should fail")
	}
	if len(resp["with"].Error) == 0 {
		t.Fatal("missing error for nsfwjs item")
	}
	if !bytes.Contains([]byte(resp["with"].Error), []byte("nsfwjs:")) {
		t.Fatalf("error = %q, want nsfwjs: prefix", resp["with"].Error)
	}

	if !resp["without"].Success {
		t.Fatalf("item that did not request nsfwjs failed: %s", resp["without"].Error)
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
