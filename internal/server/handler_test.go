package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"edge-image/internal/allowlist"
	"edge-image/internal/cache"
	"edge-image/internal/config"
	"edge-image/internal/fetcher"
	"edge-image/internal/nsfw"
	"edge-image/internal/params"
	"edge-image/internal/processor"
)

var errTest = errors.New("fake failure")

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type testEnv struct {
	handler   *Handler
	cache     *cache.Cache
	hits      *atomic.Int64
	sourceURL string
}

func testConfig() config.PlatformConfig {
	return config.PlatformConfig{MaxDimension: 2048, DefaultQuality: 90}
}

func newHandlerEnv(t *testing.T, classifier nsfw.Classifier) *testEnv {
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

	al := allowlist.NewFromEnv()
	f := fetcher.New(testLogger())
	h := NewHandler(testConfig(), al, c, f, classifier, testLogger())

	return &testEnv{
		handler:   h,
		cache:     c,
		hits:      &hits,
		sourceURL: srv.URL + "/img.png",
	}
}

func (e *testEnv) get(t *testing.T, query string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/media/"+url.QueryEscape(e.sourceURL)+query, nil)
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return rec
}

func parseTestParams(t *testing.T, sourceURL, rawQuery string) *params.Params {
	t.Helper()
	q, err := url.ParseQuery(rawQuery)
	if err != nil {
		t.Fatal(err)
	}
	p, err := params.Parse(sourceURL, q, testConfig(), allowlist.NewFromEnv())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestHandlerNSFWDisabled(t *testing.T) {
	fake := &fakeClassifier{preds: testPreds()}
	env := newHandlerEnv(t, fake)

	rec := env.get(t, "?format=png")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if fake.Calls() != 0 {
		t.Fatalf("classifier calls = %d, want 0", fake.Calls())
	}
	if _, err := png.Decode(bytes.NewReader(rec.Body.Bytes())); err != nil {
		t.Fatalf("body is not a PNG: %v", err)
	}
}

func TestHandlerNSFWEnabled(t *testing.T) {
	fake := &fakeClassifier{preds: testPreds()}
	env := newHandlerEnv(t, fake)

	rec := env.get(t, "?format=png&nsfw=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}

	var resp nsfwImageResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Width != 4 || resp.Height != 4 || resp.Format != "png" || resp.ContentType != "image/png" {
		t.Fatalf("resp = %+v", resp)
	}
	if _, err := base64.StdEncoding.DecodeString(resp.Image); err != nil {
		t.Fatalf("image is not base64: %v", err)
	}
	if resp.NSFW == nil || resp.NSFW.Safe != 0.91 {
		t.Fatalf("nsfw = %+v", resp.NSFW)
	}
	if fake.Calls() != 1 {
		t.Fatalf("classifier calls = %d, want 1", fake.Calls())
	}
	if got := rec.Header().Get("X-Image-Width"); got != "4" {
		t.Fatalf("X-Image-Width = %q", got)
	}
	if got := rec.Header().Get("X-Image-Format"); got != "png" {
		t.Fatalf("X-Image-Format = %q", got)
	}
}

func TestHandlerNSFWClassifierUnavailable(t *testing.T) {
	env := newHandlerEnv(t, nil)

	rec := env.get(t, "?format=png&nsfw=1")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "nsfw classifier is not available") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestHandlerNSFWClassificationError(t *testing.T) {
	fake := &fakeClassifier{preds: testPreds(), err: errTest}
	env := newHandlerEnv(t, fake)

	rec := env.get(t, "?format=png&nsfw=1")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "nsfw:") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestHandlerNSFWProcessedCacheStillFetchesSource(t *testing.T) {
	fake := &fakeClassifier{preds: testPreds()}
	env := newHandlerEnv(t, fake)

	p := parseTestParams(t, env.sourceURL, "format=png&nsfw=1")
	env.cache.Set(buildProcessedCacheKey(p), &cache.Entry{
		Buffer:      pngBytes(t, 4, 4),
		ContentType: "image/png",
	})

	rec := env.get(t, "?format=png&nsfw=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if env.hits.Load() != 1 {
		t.Fatalf("source fetches = %d, want 1", env.hits.Load())
	}
	if fake.Calls() != 1 {
		t.Fatalf("classifier calls = %d, want 1", fake.Calls())
	}
	if got := rec.Header().Get("X-Cache"); got != "HIT" {
		t.Fatalf("X-Cache = %q, want HIT", got)
	}

	var resp nsfwImageResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Width != 4 || resp.Height != 4 || resp.Format != "png" {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestHandlerNSFWCacheHitSkipsSource(t *testing.T) {
	fake := &fakeClassifier{preds: testPreds()}
	env := newHandlerEnv(t, fake)

	p := parseTestParams(t, env.sourceURL, "format=png&nsfw=1")
	env.cache.Set(buildProcessedCacheKey(p), &cache.Entry{
		Buffer:      pngBytes(t, 4, 4),
		ContentType: "image/png",
	})
	data, _ := json.Marshal(testPreds())
	env.cache.Set(nsfwCacheKey(fake, env.sourceURL), &cache.Entry{
		Buffer:      data,
		ContentType: "application/json",
	})

	rec := env.get(t, "?format=png&nsfw=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if env.hits.Load() != 0 {
		t.Fatalf("source fetches = %d, want 0", env.hits.Load())
	}
	if fake.Calls() != 0 {
		t.Fatalf("classifier calls = %d, want 0", fake.Calls())
	}

	var resp nsfwImageResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.NSFW == nil || resp.NSFW.Safe != 0.91 {
		t.Fatalf("nsfw = %+v", resp.NSFW)
	}
}

func TestHandlerNSFWJSONConflict(t *testing.T) {
	env := newHandlerEnv(t, &fakeClassifier{preds: testPreds()})

	rec := env.get(t, "?format=json&nsfw=1")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// Regression: a processing failure with a cold nsfw cache must return the
// original image as JSON, not panic after the classification call clears err.
func TestHandlerNSFWProcessingFallback(t *testing.T) {
	fake := &fakeClassifier{preds: testPreds()}
	env := newHandlerEnv(t, fake)
	env.handler.processImage = func([]byte, processor.ImageParams, *slog.Logger) (*processor.ImageResult, error) {
		return nil, errors.New("simulated processing failure")
	}

	rec := env.get(t, "?format=png&nsfw=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if errHeader := rec.Header().Get("X-Processing-Error"); !strings.Contains(errHeader, "simulated") {
		t.Fatalf("X-Processing-Error = %q", errHeader)
	}

	var resp nsfwImageResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.ContentType != "image/png" || resp.Width != 4 || resp.Height != 4 {
		t.Fatalf("resp = %+v", resp)
	}
	if resp.NSFW == nil || resp.NSFW.Safe != 0.91 {
		t.Fatalf("nsfw = %+v", resp.NSFW)
	}
	if fake.Calls() != 1 {
		t.Fatalf("classifier calls = %d, want 1", fake.Calls())
	}
}
