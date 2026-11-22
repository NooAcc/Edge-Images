package nsfw

import (
	"encoding/json"
	"math"
	"os"
	"slices"
	"testing"
)

func TestPreprocessRGBRejectsBadLength(t *testing.T) {
	_, err := PreprocessRGB(make([]byte, 10), 2, 2) // want 12 bytes
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestPreprocessRGBRejectsNonPositiveDimensions(t *testing.T) {
	for _, tc := range []struct{ w, h int }{{0, 1}, {1, 0}, {-1, 2}} {
		if _, err := PreprocessRGB([]byte{0, 0, 0}, tc.w, tc.h); err == nil {
			t.Fatalf("dimensions %dx%d: expected error", tc.w, tc.h)
		}
	}
}

func TestNearestIndices(t *testing.T) {
	cases := []struct {
		src, dst int
		want     []int
	}{
		{5, 3, []int{0, 2, 4}},
		{7, 4, []int{0, 2, 4, 6}},
		{4, 2, []int{1, 3}},
		{2, 7, []int{0, 0, 0, 0, 1, 1, 1}},
	}
	for _, tc := range cases {
		got := nearestIndices(tc.src, tc.dst)
		if !slices.Equal(got, tc.want) {
			t.Fatalf("nearestIndices(%d,%d) = %v, want %v", tc.src, tc.dst, got, tc.want)
		}
	}
}

func TestPreprocessRGBOnePixel(t *testing.T) {
	out, err := PreprocessRGB([]byte{255, 128, 0}, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	const spatial = ModelInputSize * ModelInputSize
	if len(out) != 3*spatial {
		t.Fatalf("len = %d, want %d", len(out), 3*spatial)
	}
	mean := [3]float64{0.485, 0.456, 0.406}
	std := [3]float64{0.47853944, 0.4732864, 0.47434163}
	px := [3]float64{255, 128, 0}
	for c := 0; c < 3; c++ {
		want := ((px[c]*0.00392156862745098 - mean[c]) / std[c]) / std[c]
		for i := 0; i < spatial; i++ {
			if math.Abs(float64(out[c*spatial+i])-want) > 1e-6 {
				t.Fatalf("channel %d pixel %d = %v, want %v", c, i, out[c*spatial+i], want)
			}
		}
	}
}

func TestPreprocessRGBDegenerateDimensions(t *testing.T) {
	for _, tc := range []struct{ w, h int }{{1, 1}, {1, 1000}, {1000, 1}, {2, 2}} {
		rgb := make([]byte, tc.w*tc.h*3)
		out, err := PreprocessRGB(rgb, tc.w, tc.h)
		if err != nil {
			t.Fatalf("%dx%d: %v", tc.w, tc.h, err)
		}
		if len(out) != 3*ModelInputSize*ModelInputSize {
			t.Fatalf("%dx%d: len = %d", tc.w, tc.h, len(out))
		}
		for _, v := range out {
			if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
				t.Fatalf("%dx%d: non-finite value", tc.w, tc.h)
			}
		}
	}
}

type goldenFile struct {
	InputSize int `json:"inputSize"`
	Cases     []struct {
		Name    string `json:"name"`
		Width   int    `json:"width"`
		Height  int    `json:"height"`
		Samples []struct {
			Index int     `json:"index"`
			Value float32 `json:"value"`
		} `json:"samples"`
	} `json:"cases"`
}

func TestPreprocessRGBGolden(t *testing.T) {
	data, err := os.ReadFile("testdata/preprocess_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(data, &g); err != nil {
		t.Fatal(err)
	}
	if g.InputSize != ModelInputSize {
		t.Fatalf("inputSize = %d, want %d", g.InputSize, ModelInputSize)
	}
	for _, tc := range g.Cases {
		rgb := make([]byte, tc.Width*tc.Height*3)
		for y := 0; y < tc.Height; y++ {
			for x := 0; x < tc.Width; x++ {
				for c := 0; c < 3; c++ {
					rgb[(y*tc.Width+x)*3+c] = byte((x*7 + y*13 + c*29) & 0xFF)
				}
			}
		}
		out, err := PreprocessRGB(rgb, tc.Width, tc.Height)
		if err != nil {
			t.Fatalf("%s: %v", tc.Name, err)
		}
		for _, s := range tc.Samples {
			if math.Abs(float64(out[s.Index]-s.Value)) > 2e-6 {
				t.Fatalf("%s sample %d = %v, want %v", tc.Name, s.Index, out[s.Index], s.Value)
			}
		}
	}
}
