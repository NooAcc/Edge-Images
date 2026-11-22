package processor

import (
	"fmt"

	"github.com/davidbyttow/govips/v2/vips"
)

// PrepareNSFWInput decodes a source image and returns packed full-resolution
// RGB bytes (no alpha) plus the image dimensions.
//
// It applies EXIF auto-rotation and converts to sRGB, matching what a browser
// would show. Scaling is intentionally left to nsfw.PreprocessRGB, which
// implements nsfwjs's alignCorners sampling.
func PrepareNSFWInput(source []byte) (rgb []byte, width, height int, err error) {
	img, err := vips.NewImageFromBuffer(source)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("nsfw: load image: %w", err)
	}
	defer img.Close()

	if err := img.AutoRotate(); err != nil {
		return nil, 0, 0, fmt.Errorf("nsfw: auto rotate: %w", err)
	}
	if err := img.ToColorSpace(vips.InterpretationSRGB); err != nil {
		return nil, 0, 0, fmt.Errorf("nsfw: convert to sRGB: %w", err)
	}

	switch bands := img.Bands(); {
	case bands == 1:
		if err := replicateSingleBand(img); err != nil {
			return nil, 0, 0, fmt.Errorf("nsfw: expand grayscale: %w", err)
		}
	case bands == 2:
		// Greyscale plus alpha: keep the colour band and expand it to RGB.
		if err := img.ExtractBand(0, 1); err != nil {
			return nil, 0, 0, fmt.Errorf("nsfw: extract greyscale band: %w", err)
		}
		if err := replicateSingleBand(img); err != nil {
			return nil, 0, 0, fmt.Errorf("nsfw: expand grayscale: %w", err)
		}
	case bands >= 4:
		// Drop alpha (and any extra bands) without compositing.
		if err := img.ExtractBand(0, 3); err != nil {
			return nil, 0, 0, fmt.Errorf("nsfw: drop alpha: %w", err)
		}
	}

	if img.Bands() != 3 {
		return nil, 0, 0, fmt.Errorf("nsfw: expected 3 colour bands, got %d", img.Bands())
	}

	if err := img.Cast(vips.BandFormatUchar); err != nil {
		return nil, 0, 0, fmt.Errorf("nsfw: cast to uchar: %w", err)
	}

	data, err := img.ToBytes()
	if err != nil {
		return nil, 0, 0, fmt.Errorf("nsfw: read pixels: %w", err)
	}

	w, h := img.Width(), img.Height()
	if len(data) != w*h*3 {
		return nil, 0, 0, fmt.Errorf("nsfw: unexpected RGB size %d for %dx%d", len(data), w, h)
	}

	return data, w, h, nil
}

// replicateSingleBand turns a 1-band image into a 3-band image by joining two
// copies of itself. libvips's BW2sRGB conversion does the same (bandjoin of
// the grey band three times); this covers the path where the source is not
// tagged as B_W and ToColorSpace left it single-band.
func replicateSingleBand(img *vips.ImageRef) error {
	first, err := img.Copy()
	if err != nil {
		return err
	}
	defer first.Close()

	second, err := img.Copy()
	if err != nil {
		return err
	}
	defer second.Close()

	return img.BandJoin(first, second)
}
