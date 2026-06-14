package processor

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/davidbyttow/govips/v2/vips"
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

func InitVips() {
	err := vips.Startup(&vips.Config{
		MaxCacheFiles:    0,
		MaxCacheSize:     0,
		MaxCacheMem:      0,
		ConcurrencyLevel: 0, // 0 = auto-detect (libvips uses nproc)
	})
	if err != nil {
		panic(fmt.Sprintf("failed to start vips: %v", err))
	}
}

func ShutdownVips() {
	vips.Shutdown()
}

// ---------------------------------------------------------------------------
// ProcessImage — main entry point
// ---------------------------------------------------------------------------

// ProcessImage processes a source image buffer according to params.
//
// Two paths:
//   - Shrink-on-load: when resize is needed and no rotation/flip is requested.
//     Uses vips_thumbnail_buffer which decodes at reduced resolution (especially
//     beneficial for AVIF/HEIF with grid encoding). Memory: ~6 MB per operation.
//   - Full decode: when rotation/flip is requested, or no resize needed.
//     Uses vips_image_new_from_buffer → transform → thumbnail_image → export.
//     Memory: ~96 MB per operation for a 4000×3000 source.
func ProcessImage(source []byte, params ImageParams, log *slog.Logger) (*ImageResult, error) {
	log.Info("image.process.start",
		"sourceBytes", len(source),
		"width", params.Width,
		"height", params.Height,
		"crop", params.Crop,
		"size", params.Size,
		"quality", params.Quality,
		"format", params.Format,
		"rotate", params.Rotate,
		"flip", params.Flip,
	)

	needsResize := params.Width > 0 || params.Height > 0
	needsTransform := params.Rotate > 0 || params.Flip != ""

	var image *vips.ImageRef
	var err error

	if needsResize && !needsTransform {
		// Shrink-on-load: decode + resize in a single vips pipeline.
		// For AVIF with grid encoding, libheif decodes tiles at reduced resolution.
		image, err = loadThumbnail(source, params)
	} else {
		// Full decode: needed for rotation/flip, or when only format conversion.
		image, err = vips.NewImageFromBuffer(source)
		if err == nil {
			if err = applyTransforms(image, params); err == nil && needsResize {
				err = applyResize(image, params)
			}
		}
	}

	if err != nil {
		return nil, fmt.Errorf("load image: %w", err)
	}
	defer image.Close()

	return exportImage(image, params, log)
}

// ---------------------------------------------------------------------------
// Shrink-on-load path
// ---------------------------------------------------------------------------

// loadThumbnail loads and resizes in one step via vips_thumbnail_buffer.
// This is the most memory-efficient path: the decoder scales down during
// decompression rather than decoding the full image first.
func loadThumbnail(source []byte, params ImageParams) (*vips.ImageRef, error) {
	targetW, targetH := targetDimensions(params)

	image, err := vips.NewThumbnailWithSizeFromBuffer(
		source, targetW, targetH,
		mapCropToInteresting(params.Crop),
		mapSizeToSize(params.Size),
	)
	if err != nil {
		return nil, err
	}

	if embedErr := applyBackgroundEmbed(image, params); embedErr != nil {
		image.Close()
		return nil, embedErr
	}

	return image, nil
}

// ---------------------------------------------------------------------------
// Full-decode path
// ---------------------------------------------------------------------------

// applyTransforms applies rotation and flip to an already-loaded image.
func applyTransforms(image *vips.ImageRef, params ImageParams) error {
	if params.Rotate > 0 {
		var angle vips.Angle
		switch params.Rotate {
		case 90:
			angle = vips.Angle90
		case 180:
			angle = vips.Angle180
		case 270:
			angle = vips.Angle270
		default:
			return fmt.Errorf("unsupported rotate angle: %d", params.Rotate)
		}
		if err := image.Rotate(angle); err != nil {
			return fmt.Errorf("rotate: %w", err)
		}
	}

	if params.Flip != "" {
		for _, c := range params.Flip {
			switch c {
			case 'v':
				if err := image.Flip(vips.DirectionVertical); err != nil {
					return fmt.Errorf("flip vertical: %w", err)
				}
			case 'h':
				if err := image.Flip(vips.DirectionHorizontal); err != nil {
					return fmt.Errorf("flip horizontal: %w", err)
				}
			default:
				return fmt.Errorf("unsupported flip direction: %c", c)
			}
		}
	}

	return nil
}

// applyResize resizes an already-loaded image via vips_thumbnail_image.
// Used only in the full-decode path (when rotation/flip is also needed).
func applyResize(image *vips.ImageRef, params ImageParams) error {
	targetW, targetH := targetDimensions(params)

	if err := image.ThumbnailWithSize(targetW, targetH,
		mapCropToInteresting(params.Crop),
		mapSizeToSize(params.Size),
	); err != nil {
		return fmt.Errorf("thumbnail: %w", err)
	}

	return applyBackgroundEmbed(image, params)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// targetDimensions computes the actual pixel dimensions for thumbnail,
// substituting MaxDimension when only one axis is specified.
func targetDimensions(params ImageParams) (int, int) {
	w := params.Width
	h := params.Height
	if w == 0 {
		w = params.MaxDimension
	}
	if h == 0 {
		h = params.MaxDimension
	}
	return w, h
}

// applyBackgroundEmbed pads the image canvas with a background colour
// when crop=none and the resized image does not fill the target area.
func applyBackgroundEmbed(image *vips.ImageRef, params ImageParams) error {
	if params.Crop != "none" {
		return nil
	}
	bg := params.Background
	if bg[0] == 255 && bg[1] == 255 && bg[2] == 255 {
		return nil // default white — no embedding needed
	}

	actualW := image.Width()
	actualH := image.Height()

	canvasW := params.Width
	canvasH := params.Height
	if canvasW == 0 {
		canvasW = actualW
	}
	if canvasH == 0 {
		canvasH = actualH
	}

	if actualW >= canvasW && actualH >= canvasH {
		return nil
	}

	left := (canvasW - actualW) / 2
	top := (canvasH - actualH) / 2

	if err := image.EmbedBackgroundRGBA(left, top, canvasW, canvasH, &vips.ColorRGBA{
		R: bg[0], G: bg[1], B: bg[2], A: 255,
	}); err != nil {
		return fmt.Errorf("embed background: %w", err)
	}
	return nil
}

// exportImage encodes the processed image to the target format.
func exportImage(image *vips.ImageRef, params ImageParams, log *slog.Logger) (*ImageResult, error) {
	var buf []byte
	var err error

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
	default: // webp
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

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

func ProbeImageMetadata(source []byte, log *slog.Logger) (*ImageMetadata, error) {
	image, err := vips.NewImageFromBuffer(source)
	if err != nil {
		return nil, fmt.Errorf("load image for metadata: %w", err)
	}
	defer image.Close()

	return &ImageMetadata{
		Width:    image.Width(),
		Height:   image.Height(),
		Format:   strings.TrimPrefix(image.Format().FileExt(), "."),
		Channels: 4,
	}, nil
}

// ---------------------------------------------------------------------------
// Enum mappers
// ---------------------------------------------------------------------------

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
