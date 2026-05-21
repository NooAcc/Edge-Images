package processor

import (
	"fmt"
	"log/slog"

	"github.com/davidbyttow/govips/v2/vips"
)

var FormatContentTypes = map[string]string{
	"webp": "image/webp",
	"jpeg": "image/jpeg",
	"png":  "image/png",
	"avif": "image/avif",
}

type ImageParams struct {
	Width             int
	Height            int
	Crop              string
	Size              string
	Quality           int
	Format            string
	Rotate            int
	Flip              string
	Background        [3]uint8
	MaxDimension      int
	SourceContentType string
}

type ImageResult struct {
	Buffer   []byte
	Width    int
	Height   int
	Format   string
	Size     int
	Channels int
}

type ImageMetadata struct {
	Width             int
	Height            int
	Format            string
	Channels          int
	SourceContentType string
	SourceSize        int64
}

func InitVips() {
	err := vips.Startup(&vips.Config{
		MaxCacheFiles: 0,
		MaxCacheSize:  0,
		MaxCacheMem:   0,
	})
	if err != nil {
		panic(fmt.Sprintf("failed to start vips: %v", err))
	}
}

func ShutdownVips() {
	vips.Shutdown()
}

func ProcessImage(source []byte, params ImageParams, log *slog.Logger) (*ImageResult, error) {
	log.Info("image.process.start",
		"sourceBytes", len(source),
		"width", params.Width,
		"height", params.Height,
		"crop", params.Crop,
		"size", params.Size,
		"quality", params.Quality,
		"format", params.Format,
	)

	image, err := vips.NewImageFromBuffer(source)
	if err != nil {
		return nil, fmt.Errorf("load image: %w", err)
	}
	defer image.Close()

	if params.Rotate > 0 {
		var angle vips.Angle
		switch params.Rotate {
		case 90:
			angle = vips.Angle90
		case 180:
			angle = vips.Angle180
		case 270:
			angle = vips.Angle270
		}
		if err := image.Rotate(angle); err != nil {
			return nil, fmt.Errorf("rotate: %w", err)
		}
	}

	if params.Flip != "" {
		for _, c := range params.Flip {
			switch c {
			case 'v':
				if err := image.Flip(vips.DirectionVertical); err != nil {
					return nil, fmt.Errorf("flip vertical: %w", err)
				}
			case 'h':
				if err := image.Flip(vips.DirectionHorizontal); err != nil {
					return nil, fmt.Errorf("flip horizontal: %w", err)
				}
			}
		}
	}

	if params.Width > 0 || params.Height > 0 {
		if err := resizeImage(image, params.Width, params.Height, params.Crop, params.Size, params.Background, params.MaxDimension); err != nil {
			return nil, fmt.Errorf("resize: %w", err)
		}
	}

	var buf []byte
	switch params.Format {
	case "jpeg":
		buf, _, err = image.ExportJpeg(&vips.JpegExportParams{
			Quality:            params.Quality,
			StripMetadata:      true,
			Interlace:          true,
			OptimizeCoding:     true,
			SubsampleMode:      vips.VipsForeignSubsampleAuto,
			TrellisQuant:       true,
			OvershootDeringing: true,
			OptimizeScans:      true,
		})
	case "png":
		buf, _, err = image.ExportPng(&vips.PngExportParams{
			StripMetadata: true,
			Compression:   6,
			Interlace:     false,
			Filter:        vips.PngFilterNone,
			Palette:       false,
		})
	case "avif":
		buf, _, err = image.ExportAvif(&vips.AvifExportParams{
			Quality:       params.Quality,
			StripMetadata: true,
			Effort:        4,
			Bitdepth:      8,
		})
	default:
		buf, _, err = image.ExportWebp(&vips.WebpExportParams{
			Quality:         params.Quality,
			StripMetadata:   true,
			ReductionEffort: 4,
			MinSize:         true,
		})
	}

	if err != nil {
		return nil, fmt.Errorf("export %s: %w", params.Format, err)
	}

	log.Info("image.process.done",
		"outputBytes", len(buf),
		"width", image.Width(),
		"height", image.Height(),
	)

	return &ImageResult{
		Buffer:   buf,
		Width:    image.Width(),
		Height:   image.Height(),
		Format:   params.Format,
		Size:     len(buf),
		Channels: 4,
	}, nil
}

func ProbeImageMetadata(source []byte, log *slog.Logger) (*ImageMetadata, error) {
	image, err := vips.NewImageFromBuffer(source)
	if err != nil {
		return nil, fmt.Errorf("load image for metadata: %w", err)
	}
	defer image.Close()

	return &ImageMetadata{
		Width:    image.Width(),
		Height:   image.Height(),
		Format:   string(image.Format()),
		Channels: 4,
	}, nil
}

func resizeImage(image *vips.ImageRef, width, height int, crop, size string, bg [3]uint8, maxDimension int) error {
	if width == 0 && height == 0 {
		return nil
	}

	targetW := width
	targetH := height

	if targetW == 0 {
		targetW = maxDimension
	}
	if targetH == 0 {
		targetH = maxDimension
	}

	interesting := mapCropToInteresting(crop)
	sizeMode := mapSizeToSize(size)

	if err := image.ThumbnailWithSize(targetW, targetH, interesting, sizeMode); err != nil {
		return fmt.Errorf("thumbnail: %w", err)
	}

	if crop == "none" && (bg[0] != 255 || bg[1] != 255 || bg[2] != 255) {
		actualW := image.Width()
		actualH := image.Height()

		canvasW := width
		if canvasW == 0 {
			canvasW = actualW
		}
		canvasH := height
		if canvasH == 0 {
			canvasH = actualH
		}

		if actualW < canvasW || actualH < canvasH {
			left := (canvasW - actualW) / 2
			top := (canvasH - actualH) / 2
			if err := image.EmbedBackgroundRGBA(left, top, canvasW, canvasH, &vips.ColorRGBA{
				R: bg[0], G: bg[1], B: bg[2], A: 255,
			}); err != nil {
				return fmt.Errorf("embed background: %w", err)
			}
		}
	}

	return nil
}

func mapCropToInteresting(crop string) vips.Interesting {
	switch crop {
	case "centre":
		return vips.InterestingCentre
	case "attention":
		return vips.InterestingAttention
	case "entropy":
		return vips.InterestingEntropy
	default:
		return vips.InterestingNone
	}
}

func mapSizeToSize(size string) vips.Size {
	switch size {
	case "down":
		return vips.SizeDown
	case "up":
		return vips.SizeUp
	case "force":
		return vips.SizeForce
	default:
		return vips.SizeBoth
	}
}
