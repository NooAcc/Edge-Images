package params

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"edge-image/internal/allowlist"
	"edge-image/internal/config"
)

var supportedCrops = map[string]bool{
	"none": true, "centre": true, "attention": true, "entropy": true,
}

var supportedSizes = map[string]bool{
	"both": true, "down": true, "up": true, "force": true,
}

var supportedFormats = map[string]bool{
	"webp": true, "jpeg": true, "png": true, "avif": true, "json": true,
}

var supportedRotations = map[int]bool{
	90: true, 180: true, 270: true,
}

var supportedFlips = map[string]bool{
	"h": true, "v": true, "hv": true,
}

type Params struct {
	URL           string
	Width         int
	Height        int
	Crop          string
	Size          string
	Quality       int
	Format        string
	Background    [3]uint8
	BackgroundHex string
	Rotate        int
	Flip          string
	MaxDimension  int
	NSFWJS        bool
}

func Parse(sourceURL string, query url.Values, cfg config.PlatformConfig, al *allowlist.Allowlist) (*Params, error) {
	if sourceURL == "" {
		return nil, fmt.Errorf("missing required source URL path segment")
	}

	parsedURL, err := parseSourceURL(sourceURL)
	if err != nil {
		return nil, err
	}

	host := parsedURL.Hostname()
	if !al.IsAllowed(host) {
		return nil, fmt.Errorf("url host is not allowed by IMAGE_URL_ALLOWLIST")
	}

	return parseParams(parsedURL.String(), query, cfg)
}

// ParseInline parses params for an inline (base64) source. sourceKey identifies
// the source for caching; it is not URL-validated or allowlist-checked.
func ParseInline(sourceKey string, query url.Values, cfg config.PlatformConfig) (*Params, error) {
	if sourceKey == "" {
		return nil, fmt.Errorf("missing inline source key")
	}

	return parseParams(sourceKey, query, cfg)
}

func parseParams(source string, query url.Values, cfg config.PlatformConfig) (*Params, error) {
	maxDimension := cfg.MaxDimension
	if maxDimension == 0 {
		maxDimension = 2048
	}
	defaultQuality := cfg.DefaultQuality
	if defaultQuality == 0 {
		defaultQuality = 90
	}

	width := parseDimension(query.Get("width"), maxDimension)
	height := parseDimension(query.Get("height"), maxDimension)
	crop := parseCrop(query.Get("crop"))
	size := parseSize(query.Get("size"))
	quality := parseQuality(query.Get("quality"), defaultQuality)
	format := parseFormat(query.Get("format"))
	background := parseBackground(query.Get("background"))
	rotate := parseRotation(query.Get("rotate"))
	flip := parseFlip(query.Get("flip"))

	nsfwjs, err := parseNSFWJS(query)
	if err != nil {
		return nil, err
	}
	if format == "json" && nsfwjs {
		return nil, fmt.Errorf("nsfwjs is not supported with format=json")
	}

	return &Params{
		URL:           source,
		Width:         width,
		Height:        height,
		Crop:          crop,
		Size:          size,
		Quality:       quality,
		Format:        format,
		Background:    background.rgb,
		BackgroundHex: background.hex,
		Rotate:        rotate,
		Flip:          flip,
		MaxDimension:  maxDimension,
		NSFWJS:        nsfwjs,
	}, nil
}

func parseSourceURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("url must be an absolute HTTP or HTTPS URL")
	}

	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("url must use http or https")
	}

	return parsed, nil
}

func parseDimension(raw string, maxDimension int) int {
	if raw == "" {
		return 0
	}

	v, err := strconv.Atoi(raw)
	if err != nil || v <= 0 {
		return 0
	}

	if v > maxDimension {
		return maxDimension
	}
	return v
}

func parseCrop(raw string) string {
	if raw == "" {
		return "none"
	}

	v := strings.ToLower(raw)
	if supportedCrops[v] {
		return v
	}
	return "none"
}

func parseSize(raw string) string {
	if raw == "" {
		return "both"
	}

	v := strings.ToLower(raw)
	if supportedSizes[v] {
		return v
	}
	return "both"
}

func parseQuality(raw string, defaultQuality int) int {
	if raw == "" {
		return defaultQuality
	}

	v, err := strconv.Atoi(raw)
	if err != nil {
		return defaultQuality
	}

	if v < 1 {
		return 1
	}
	if v > 100 {
		return 100
	}
	return v
}

func parseFormat(raw string) string {
	if raw == "" {
		return "webp"
	}

	v := strings.ToLower(raw)
	if supportedFormats[v] {
		return v
	}
	return "webp"
}

type background struct {
	rgb [3]uint8
	hex string
}

func parseBackground(raw string) background {
	if raw == "" {
		return background{rgb: [3]uint8{255, 255, 255}, hex: "FFFFFF"}
	}

	normalized := strings.TrimPrefix(strings.ToUpper(strings.TrimSpace(raw)), "#")
	if len(normalized) != 6 {
		return background{rgb: [3]uint8{255, 255, 255}, hex: "FFFFFF"}
	}

	for _, c := range normalized {
		if !((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) {
			return background{rgb: [3]uint8{255, 255, 255}, hex: "FFFFFF"}
		}
	}

	r, _ := strconv.ParseUint(normalized[0:2], 16, 8)
	g, _ := strconv.ParseUint(normalized[2:4], 16, 8)
	b, _ := strconv.ParseUint(normalized[4:6], 16, 8)

	return background{
		rgb: [3]uint8{uint8(r), uint8(g), uint8(b)},
		hex: normalized,
	}
}

func parseRotation(raw string) int {
	if raw == "" {
		return 0
	}

	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0
	}

	if supportedRotations[v] {
		return v
	}
	return 0
}

func parseFlip(raw string) string {
	if raw == "" {
		return ""
	}

	v := strings.ToLower(raw)
	if supportedFlips[v] {
		return v
	}
	return ""
}

// parseNSFWJS parses the optional nsfwjs flag. The parameter's presence means
// it is enabled, so "?nsfwjs" and "?nsfwjs=" both turn classification on.
func parseNSFWJS(query url.Values) (bool, error) {
	if !query.Has("nsfwjs") {
		return false, nil
	}

	v := strings.ToLower(strings.TrimSpace(query.Get("nsfwjs")))
	switch v {
	case "", "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("invalid nsfwjs value %q", v)
	}
}
