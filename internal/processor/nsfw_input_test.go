package processor

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"testing"
)

func TestMain(m *testing.M) {
	InitVips()
	code := m.Run()
	ShutdownVips()
	os.Exit(code)
}

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestPrepareNSFWInputDropsAlpha(t *testing.T) {
	// NRGBA stores non-premultiplied pixels, which is what PNG encodes.
	// image.RGBA would premultiply and zero out the colour at alpha=0.
	img := image.NewNRGBA(image.Rect(0, 0, 4, 2))
	img.SetNRGBA(0, 0, color.NRGBA{R: 10, G: 20, B: 30, A: 0})
	img.SetNRGBA(3, 1, color.NRGBA{R: 200, G: 100, B: 50, A: 128})

	rgb, w, h, err := PrepareNSFWInput(encodePNG(t, img))
	if err != nil {
		t.Fatal(err)
	}
	if w != 4 || h != 2 {
		t.Fatalf("size = %dx%d, want 4x2", w, h)
	}
	if len(rgb) != 4*2*3 {
		t.Fatalf("len = %d, want 24", len(rgb))
	}
	// Alpha 0 must be dropped, not composited with black.
	if got := rgb[0:3]; got[0] != 10 || got[1] != 20 || got[2] != 30 {
		t.Fatalf("first pixel = %v, want [10 20 30]", got)
	}
	if got := rgb[(1*4+3)*3:]; got[0] != 200 || got[1] != 100 || got[2] != 50 {
		t.Fatalf("last pixel = %v, want [200 100 50]", got)
	}
}

func TestPrepareNSFWInputExpandsGrayscale(t *testing.T) {
	gray := image.NewGray(image.Rect(0, 0, 2, 2))
	gray.SetGray(0, 0, color.Gray{Y: 77})

	rgb, w, h, err := PrepareNSFWInput(encodePNG(t, gray))
	if err != nil {
		t.Fatal(err)
	}
	if w != 2 || h != 2 {
		t.Fatalf("size = %dx%d, want 2x2", w, h)
	}
	if len(rgb) != 2*2*3 {
		t.Fatalf("len = %d, want 12", len(rgb))
	}
	for i := 0; i < 3; i++ {
		if diff := int(rgb[i]) - 77; diff < -1 || diff > 1 {
			t.Fatalf("pixel channel %d = %d, want ~77", i, rgb[i])
		}
	}
}

func TestPrepareNSFWInputRejectsInvalidBytes(t *testing.T) {
	if _, _, _, err := PrepareNSFWInput([]byte("not an image")); err == nil {
		t.Fatal("expected error")
	}
}

func TestPrepareNSFWInputScales16Bit(t *testing.T) {
	img := image.NewRGBA64(image.Rect(0, 0, 2, 1))
	img.SetRGBA64(0, 0, color.RGBA64{R: 65535, G: 65535, B: 65535, A: 65535})
	img.SetRGBA64(1, 0, color.RGBA64{R: 32896, G: 32896, B: 32896, A: 65535})

	rgb, w, h, err := PrepareNSFWInput(encodePNG(t, img))
	if err != nil {
		t.Fatal(err)
	}
	if w != 2 || h != 1 || len(rgb) != 6 {
		t.Fatalf("size = %dx%d len=%d, want 2x1 len=6", w, h, len(rgb))
	}
	for c := 0; c < 3; c++ {
		if rgb[c] < 254 {
			t.Fatalf("white channel %d = %d, want ~255", c, rgb[c])
		}
		if diff := int(rgb[3+c]) - 128; diff < -1 || diff > 1 {
			t.Fatalf("mid channel %d = %d, want ~128", c, rgb[3+c])
		}
	}
}
