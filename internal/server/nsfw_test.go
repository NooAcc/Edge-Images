package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"log/slog"
	"os"
	"sync"
	"testing"

	"edge-image/internal/cache"
	"edge-image/internal/nsfw"
	"edge-image/internal/processor"
)

func TestMain(m *testing.M) {
	processor.InitVips()
	code := m.Run()
	processor.ShutdownVips()
	os.Exit(code)
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func testPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type fakeClassifier struct {
	mu    sync.Mutex
	preds *nsfw.Predictions
	err   error
	calls int
}

func (f *fakeClassifier) Classify(context.Context, []byte, int, int) (*nsfw.Predictions, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	return f.preds, nil
}

func (f *fakeClassifier) ModelID() string    { return "fake-model" }
func (f *fakeClassifier) Threshold() float32 { return 0.5 }
func (f *fakeClassifier) Close() error       { return nil }

func (f *fakeClassifier) Calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func testPreds() *nsfw.Predictions {
	return &nsfw.Predictions{
		Drawing: 0.02, Hentai: 0.01, Safe: 0.91, Porn: 0.03, Sexy: 0.03, IsNsfw: false,
	}
}

func TestNSFWServiceUnavailable(t *testing.T) {
	svc := newNSFWService(nil, nil, testLogger(), 2)
	_, err := svc.ClassifySource(context.Background(), "https://e/x", testPNG(t))
	if !errors.Is(err, ErrNSFWUnavailable) {
		t.Fatalf("err = %v, want ErrNSFWUnavailable", err)
	}
}

func TestNSFWServiceClassifiesAndCaches(t *testing.T) {
	c, err := cache.New(0, 1, t.TempDir(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	fake := &fakeClassifier{preds: testPreds()}
	svc := newNSFWService(fake, c, testLogger(), 2)
	source := testPNG(t)

	first, err := svc.ClassifySource(context.Background(), "https://e/x", source)
	if err != nil {
		t.Fatal(err)
	}
	if first.Safe != 0.91 {
		t.Fatalf("first = %+v", first)
	}
	if fake.Calls() != 1 {
		t.Fatalf("calls = %d, want 1", fake.Calls())
	}

	second, err := svc.ClassifySource(context.Background(), "https://e/x", source)
	if err != nil {
		t.Fatal(err)
	}
	if second.Safe != first.Safe {
		t.Fatalf("second = %+v, want %+v", second, first)
	}
	if fake.Calls() != 1 {
		t.Fatalf("calls = %d, want 1 (cache hit)", fake.Calls())
	}

	if _, ok := svc.Lookup("https://e/x"); !ok {
		t.Fatal("Lookup missed a cached prediction")
	}
}

func TestNSFWServiceWithoutCacheCallsEveryTime(t *testing.T) {
	fake := &fakeClassifier{preds: testPreds()}
	svc := newNSFWService(fake, nil, testLogger(), 2)
	source := testPNG(t)

	if _, err := svc.ClassifySource(context.Background(), "https://e/x", source); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ClassifySource(context.Background(), "https://e/x", source); err != nil {
		t.Fatal(err)
	}
	if fake.Calls() != 2 {
		t.Fatalf("calls = %d, want 2", fake.Calls())
	}
}

func TestNSFWServiceClassifierError(t *testing.T) {
	fake := &fakeClassifier{preds: testPreds(), err: errors.New("boom")}
	svc := newNSFWService(fake, nil, testLogger(), 2)

	_, err := svc.ClassifySource(context.Background(), "https://e/x", testPNG(t))
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrNSFWUnavailable) && !bytes.Contains([]byte(err.Error()), []byte("nsfw:")) {
		t.Fatalf("err = %q, want nsfw: prefix", err)
	}
}

func TestNSFWServiceCachedLookup(t *testing.T) {
	c, err := cache.New(0, 1, t.TempDir(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	fake := &fakeClassifier{preds: testPreds()}
	data, _ := json.Marshal(testPreds())
	c.Set(nsfwCacheKey(fake, "https://e/x"), &cache.Entry{Buffer: data, ContentType: "application/json"})

	svc := newNSFWService(fake, c, testLogger(), 2)
	got, ok := svc.Lookup("https://e/x")
	if !ok {
		t.Fatal("Lookup missed")
	}
	if got.Safe != 0.91 {
		t.Fatalf("got = %+v", got)
	}
}

func TestBuildNSFWImageResponse(t *testing.T) {
	buffer := []byte("image-bytes")
	preds := testPreds()

	body, err := buildNSFWImageResponse(buffer, "image/webp", "webp", 800, 600, preds)
	if err != nil {
		t.Fatal(err)
	}

	var resp nsfwImageResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Width != 800 || resp.Height != 600 || resp.Format != "webp" || resp.ContentType != "image/webp" {
		t.Fatalf("resp = %+v", resp)
	}
	decoded, err := base64.StdEncoding.DecodeString(resp.Image)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decoded, buffer) {
		t.Fatalf("decoded = %q", decoded)
	}
	if resp.NSFW == nil || resp.NSFW.Safe != 0.91 {
		t.Fatalf("nsfw = %+v", resp.NSFW)
	}
}
