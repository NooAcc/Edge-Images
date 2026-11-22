package nsfw

import (
	"fmt"
	"math"
)

// PreprocessRGB converts a full-resolution packed RGB buffer into the
// float32 NHWC tensor expected by the nsfwjs model.
//
// nsfwjs does: toFloat().div(255) followed by
// tf.image.resizeBilinear(..., alignCorners=true). libvips resize/thumbnail
// uses a different sampling grid, so the resize is implemented here.
func PreprocessRGB(rgb []byte, width, height int) ([]float32, error) {
	if width <= 0 || height <= 0 {
		return nil, fmt.Errorf("invalid input dimensions %dx%d", width, height)
	}
	if len(rgb) != width*height*3 {
		return nil, fmt.Errorf("expected %d RGB bytes for %dx%d, got %d",
			width*height*3, width, height, len(rgb))
	}

	return resizeBilinearAlignCorners(rgb, width, height, ModelInputSize, ModelInputSize), nil
}

// resizeBilinearAlignCorners performs bilinear sampling with the alignment
// used by TensorFlow's resizeBilinear(alignCorners=true):
//
//	srcY = y * (height - 1) / (outHeight - 1)
//	srcX = x * (width  - 1) / (outWidth  - 1)
//
// The source is packed RGB; the output is NHWC float32 scaled to [0, 1].
func resizeBilinearAlignCorners(src []byte, width, height, outWidth, outHeight int) []float32 {
	out := make([]float32, outWidth*outHeight*3)
	if width <= 0 || height <= 0 || outWidth <= 0 || outHeight <= 0 {
		return out
	}

	for y := 0; y < outHeight; y++ {
		srcY := 0.0
		if outHeight > 1 {
			srcY = float64(y) * float64(height-1) / float64(outHeight-1)
		}
		y0 := int(math.Floor(srcY))
		if y0 >= height {
			y0 = height - 1
		}
		if y0 < 0 {
			y0 = 0
		}
		y1 := y0 + 1
		if y1 >= height {
			y1 = height - 1
		}
		fy := srcY - float64(y0)

		for x := 0; x < outWidth; x++ {
			srcX := 0.0
			if outWidth > 1 {
				srcX = float64(x) * float64(width-1) / float64(outWidth-1)
			}
			x0 := int(math.Floor(srcX))
			if x0 >= width {
				x0 = width - 1
			}
			if x0 < 0 {
				x0 = 0
			}
			x1 := x0 + 1
			if x1 >= width {
				x1 = width - 1
			}
			fx := srcX - float64(x0)

			dst := (y*outWidth + x) * 3
			p00 := (y0*width + x0) * 3
			p01 := (y0*width + x1) * 3
			p10 := (y1*width + x0) * 3
			p11 := (y1*width + x1) * 3

			for c := 0; c < 3; c++ {
				top := float64(src[p00+c]) + (float64(src[p01+c])-float64(src[p00+c]))*fx
				bottom := float64(src[p10+c]) + (float64(src[p11+c])-float64(src[p10+c]))*fx
				value := top + (bottom-top)*fy
				out[dst+c] = float32(value / 255.0)
			}
		}
	}

	return out
}
