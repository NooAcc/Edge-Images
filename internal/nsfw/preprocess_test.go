package nsfw

import (
	"math"
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

func TestPreprocessRGBAcceptsOnePixel(t *testing.T) {
	out, err := PreprocessRGB([]byte{255, 128, 0}, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != ModelInputSize*ModelInputSize*3 {
		t.Fatalf("len=%d", len(out))
	}
	for i := 0; i < len(out); i += 3 {
		want := []float32{1, 128.0 / 255.0, 0}
		for c := 0; c < 3; c++ {
			if math.Abs(float64(out[i+c]-want[c])) > 1e-6 {
				t.Fatalf("pixel %d channel %d = %v, want %v", i/3, c, out[i+c], want[c])
			}
		}
	}
}

// Reference values produced by the alignCorners=true bilinear formula used by
// tf.image.resizeBilinear (see nsfwjs src/core.ts), applied to a 2x2 image.
func TestResizeBilinearAlignCorners2x2To4x4(t *testing.T) {
	src := []byte{
		0, 0, 0, // (0,0)
		255, 0, 0, // (1,0)
		0, 255, 0, // (0,1)
		255, 255, 255, // (1,1)
	}

	want := [][3]float32{
		{0, 0, 0}, {1.0 / 3, 0, 0}, {2.0 / 3, 0, 0}, {1, 0, 0},
		{0, 1.0 / 3, 0}, {1.0 / 3, 1.0 / 3, 1.0 / 9}, {2.0 / 3, 1.0 / 3, 2.0 / 9}, {1, 1.0 / 3, 1.0 / 3},
		{0, 2.0 / 3, 0}, {1.0 / 3, 2.0 / 3, 2.0 / 9}, {2.0 / 3, 2.0 / 3, 4.0 / 9}, {1, 2.0 / 3, 2.0 / 3},
		{0, 1, 0}, {1.0 / 3, 1, 1.0 / 3}, {2.0 / 3, 1, 2.0 / 3}, {1, 1, 1},
	}

	out := resizeBilinearAlignCorners(src, 2, 2, 4, 4)
	if len(out) != len(want)*3 {
		t.Fatalf("len=%d, want %d", len(out), len(want)*3)
	}

	for i, px := range want {
		for c := 0; c < 3; c++ {
			got := out[i*3+c]
			if math.Abs(float64(got-px[c])) > 1e-6 {
				t.Fatalf("pixel %d channel %d = %v, want %v", i, c, got, px[c])
			}
		}
	}
}
