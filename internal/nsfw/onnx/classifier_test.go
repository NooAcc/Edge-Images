package onnx

import (
	"context"
	"log/slog"
	"math"
	"os"
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

func TestLayoutForDims(t *testing.T) {
	cases := []struct {
		name    string
		dims    ort.Shape
		want    layout
		wantErr bool
	}{
		{"nhwc", ort.NewShape(1, 224, 224, 3), layoutNHWC, false},
		{"nhwc dynamic batch", ort.NewShape(-1, 224, 224, 3), layoutNHWC, false},
		{"nchw", ort.NewShape(1, 3, 224, 224), layoutNCHW, false},
		{"nchw dynamic batch", ort.NewShape(-1, 3, 224, 224), layoutNCHW, false},
		{"bad channels", ort.NewShape(1, 4, 224, 224), 0, true},
		{"bad rank", ort.NewShape(1, 3, 224), 0, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := layoutForDims(tc.dims)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got layout %v", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("layout = %v, want %v", got, tc.want)
			}
		})
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

	rgb := make([]byte, 224*224*3)
	for i := range rgb {
		rgb[i] = 128
	}

	p, err := c.Classify(context.Background(), rgb, 224, 224)
	if err != nil {
		t.Fatal(err)
	}

	sum := p.Drawing + p.Hentai + p.Neutral + p.Porn + p.Sexy
	if math.Abs(float64(sum-1)) > 1e-3 {
		t.Fatalf("probability sum = %v", sum)
	}
	if p.IsNsfw {
		t.Fatalf("uniform grey classified as NSFW: %+v", p)
	}
	if p.Neutral < p.Drawing || p.Neutral < p.Hentai || p.Neutral < p.Porn || p.Neutral < p.Sexy {
		t.Fatalf("Neutral should be the largest class for a grey image: %+v", p)
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
