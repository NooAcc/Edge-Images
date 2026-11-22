package onnx

import (
	"context"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	ort "github.com/yalue/onnxruntime_go"

	"edge-image/internal/nsfw"
)

func classifierTestConfig(t *testing.T) (Config, bool) {
	t.Helper()
	model := os.Getenv("NSFW_TEST_MODEL")
	lib := os.Getenv("ONNXRUNTIME_LIB_PATH")
	if model == "" || lib == "" {
		return Config{}, false
	}
	return Config{ModelPath: model, ORTLibPath: lib, Threshold: 0.5, Concurrency: 1}, true
}

func TestValidateInputDims(t *testing.T) {
	valid := []ort.Shape{
		ort.NewShape(1, 3, 380, 380),
		ort.NewShape(-1, 3, 380, 380),
	}
	for _, dims := range valid {
		if err := validateInputDims(dims); err != nil {
			t.Fatalf("%v: %v", dims, err)
		}
	}
	invalid := []ort.Shape{
		ort.NewShape(1, 380, 380, 3),
		ort.NewShape(1, 4, 380, 380),
		ort.NewShape(1, 3, 224, 224),
		ort.NewShape(1, 3, 380),
		ort.NewShape(2, 3, 380, 380),
	}
	for _, dims := range invalid {
		if err := validateInputDims(dims); err == nil {
			t.Fatalf("%v: expected error", dims)
		}
	}
}

func TestNewRejectsMissingModel(t *testing.T) {
	_, err := New(Config{
		ModelPath:   filepath.Join(t.TempDir(), "missing.onnx"),
		Threshold:   0.5,
		Concurrency: 1,
	}, slog.Default())
	if err == nil || !strings.Contains(err.Error(), "not readable") {
		t.Fatalf("err = %v, want not readable", err)
	}
}

func TestNewRejectsInvalidConfig(t *testing.T) {
	cases := []Config{
		{ModelPath: "x", Threshold: float32(math.NaN()), Concurrency: 1},
		{ModelPath: "x", Threshold: float32(math.Inf(1)), Concurrency: 1},
		{ModelPath: "x", Threshold: -0.1, Concurrency: 1},
		{ModelPath: "x", Threshold: 1.1, Concurrency: 1},
		{ModelPath: "x", Threshold: 0.5, Concurrency: 0},
	}
	for _, cfg := range cases {
		if _, err := New(cfg, slog.Default()); err == nil {
			t.Fatalf("config %+v: expected error", cfg)
		}
	}
}

func TestClassifyIntegration(t *testing.T) {
	cfg, ok := classifierTestConfig(t)
	if !ok {
		t.Skip("set NSFW_TEST_MODEL and ONNXRUNTIME_LIB_PATH")
	}

	c, err := New(cfg, slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	defer Shutdown()
	defer c.Close()

	rgb := make([]byte, nsfw.ModelInputSize*nsfw.ModelInputSize*3)
	for i := range rgb {
		rgb[i] = 128
	}

	p, err := c.Classify(context.Background(), rgb, nsfw.ModelInputSize, nsfw.ModelInputSize)
	if err != nil {
		t.Fatal(err)
	}

	for _, v := range []float32{p.Drawing, p.Hentai, p.Safe, p.Porn, p.Sexy} {
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			t.Fatalf("non-finite score: %+v", p)
		}
	}
	sum := p.Drawing + p.Hentai + p.Safe + p.Porn + p.Sexy
	if math.Abs(float64(sum-1)) > 1e-3 {
		t.Fatalf("probability sum = %v", sum)
	}
	if p.IsNsfw {
		t.Fatalf("uniform grey classified as NSFW: %+v", p)
	}
}

func TestModelIDAndThreshold(t *testing.T) {
	cfg, ok := classifierTestConfig(t)
	if !ok {
		t.Skip("set NSFW_TEST_MODEL and ONNXRUNTIME_LIB_PATH")
	}

	c, err := New(cfg, slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	defer Shutdown()
	defer c.Close()

	if len(c.ModelID()) != 16 {
		t.Fatalf("ModelID = %q, want 16 hex characters", c.ModelID())
	}
	if c.Threshold() != 0.5 {
		t.Fatalf("threshold = %v", c.Threshold())
	}
}

var _ nsfw.Classifier = (*Classifier)(nil)
