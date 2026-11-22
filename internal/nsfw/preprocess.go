package nsfw

import (
	"fmt"
)

const rescaleFactor = 0.00392156862745098

var (
	imageMean = [3]float64{0.485, 0.456, 0.406}
	imageStd  = [3]float64{0.47853944, 0.4732864, 0.47434163}
)

// PreprocessRGB converts a full-resolution packed RGB buffer into the NCHW
// float32 tensor expected by nsfw-detection-2-mini.
//
// It reproduces the upstream EfficientNetImageProcessorPil (use_fast=False):
// Pillow NEAREST resize to 380x380, rescale by 1/255, ImageNet normalization,
// and the extra include_top division by std.
func PreprocessRGB(rgb []byte, width, height int) ([]float32, error) {
	if width <= 0 || height <= 0 {
		return nil, fmt.Errorf("invalid input dimensions %dx%d", width, height)
	}
	if len(rgb) != width*height*3 {
		return nil, fmt.Errorf("expected %d RGB bytes for %dx%d, got %d",
			width*height*3, width, height, len(rgb))
	}
	const spatial = ModelInputSize * ModelInputSize
	xTab := nearestIndices(width, ModelInputSize)
	yTab := nearestIndices(height, ModelInputSize)
	out := make([]float32, 3*spatial)
	for y := 0; y < ModelInputSize; y++ {
		srcY := yTab[y]
		for x := 0; x < ModelInputSize; x++ {
			srcX := xTab[x]
			srcOff := (srcY*width + srcX) * 3
			dstOff := y*ModelInputSize + x
			for c := 0; c < 3; c++ {
				v := float64(rgb[srcOff+c]) * rescaleFactor
				v = (v - imageMean[c]) / imageStd[c]
				v = v / imageStd[c]
				out[c*spatial+dstOff] = float32(v)
			}
		}
	}
	return out, nil
}

// nearestIndices reproduces Pillow's NEAREST sampling centres. Pillow walks a
// source position that starts at scale*0.5 and advances by scale per output
// pixel; the index is the truncated position, clamped to the source bounds.
func nearestIndices(srcSize, dstSize int) []int {
	out := make([]int, dstSize)
	if srcSize <= 0 || dstSize <= 0 {
		return out
	}
	scale := float64(srcSize) / float64(dstSize)
	pos := scale * 0.5
	for i := range out {
		idx := int(pos)
		if idx < 0 {
			idx = 0
		}
		if idx >= srcSize {
			idx = srcSize - 1
		}
		out[i] = idx
		pos += scale
	}
	return out
}
