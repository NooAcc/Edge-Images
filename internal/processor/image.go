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
	Width              int
	Height             int
	Fit                string
	Quality            int
	Format             string
	Rotate             int
	Flip               string
	Background         [3]uint8
	MaxDimension       int
	SourceContentType  string
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
	vips.Startup(&vips.Config{
		MaxCacheFiles: 0,
		MaxCacheSize:  0,
		MaxCacheMem:   0,
	})
}

func ShutdownVips() {
	vips.Shutdown()
}

func ProcessImage(source []byte, params ImageParams, log *slog.Logger) (*ImageResult, error) {
	log.Info("image.process.start",
		"sourceBytes", len(source),
		"width", params.Width,
		"height", params.Height,
		"fit", params.Fit,
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
		if err := resizeImage(image, params.Width, params.Height, params.Fit, params.Background); err != nil {
			return nil, fmt.Errorf("resize: %w", err)
		}
	}

	exportParams := &vips.ExportParams{
		Quality:       params.Quality,
		StripMetadata: true,
	}

	var buf []byte
	switch params.Format {
	case "webp":
		buf, _, err = image.ExportWebp(exportParams)
	case "jpeg":
		buf, _, err = image.ExportJpeg(exportParams)
	case "png":
		buf, _, err = image.ExportPng(exportParams)
	case "avif":
		buf, _, err = image.ExportAvif(exportParams)
	default:
		buf, _, err = image.ExportWebp(exportParams)
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

func resizeImage(image *vips.ImageRef, width, height int, fit string, bg [3]uint8) error {
	if width == 0 && height == 0 {
		return nil
	}

	srcW := float64(image.Width())
	srcH := float64(image.Height())

	targetW := float64(width)
	targetH := float64(height)

	if targetW == 0 {
		targetW = srcW * targetH / srcH
	}
	if targetH == 0 {
		targetH = srcH * targetW / srcW
	}

	scaleX := targetW / srcW
	scaleY := targetH / srcH

	var scale float64
	switch fit {
	case "cover":
		if scaleX > scaleY {
			scale = scaleX
		} else {
			scale = scaleY
		}
	case "contain", "inside":
		if scaleX < scaleY {
			scale = scaleX
		} else {
			scale = scaleY
		}
	case "fill":
		return image.ResizeWithKernel(scaleX, vips.KernelLanczos3, vips.KernelAuto)
	case "outside":
		if scaleX > scaleY {
			scale = scaleX
		} else {
			scale = scaleY
		}
	default:
		if scaleX < scaleY {
			scale = scaleX
		} else {
			scale = scaleY
		}
	}

	if scale >= 1.0 {
		return nil
	}

	kernel := vips.KernelLanczos3
	if scale < 0.5 {
		kernel = vips.KernelLinear
	}

	return image.ResizeWithKernel(scale, kernel, vips.KernelAuto)
}
