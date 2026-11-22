package config

import (
	"math"
	"os"
	"strconv"
	"strings"
)

type CacheConfig struct {
	Type        string
	MaxMemoryMB int
	MaxDiskGB   int
}

// NSFWConfig configures the optional built-in nsfwjs classifier.
//
// A non-empty DisabledReason means the classifier must not be initialized
// (requests that ask for nsfwjs then receive 503).
type NSFWConfig struct {
	ModelPath          string
	ORTLibPath         string
	Threshold          float32
	Concurrency        int
	DisabledReason     string
	ConcurrencyWarning bool
}

type PlatformConfig struct {
	MaxDimension     int
	DefaultQuality   int
	BatchConcurrency int
	Cache            CacheConfig
	NSFW             NSFWConfig
}

var presets = map[string]PlatformConfig{
	"huggingface": {
		MaxDimension:   2048,
		DefaultQuality: 90,
		Cache: CacheConfig{
			Type:        "lru+disk",
			MaxMemoryMB: 3072,
			MaxDiskGB:   50,
		},
		NSFW: NSFWConfig{
			ModelPath:   "models/nsfwjs_mobilenet_v2.onnx",
			Threshold:   0.5,
			Concurrency: 2,
		},
	},
}

func Load() PlatformConfig {
	platform := envOrDefault("PLATFORM", "huggingface")
	preset, ok := presets[platform]
	if !ok {
		preset = presets["huggingface"]
	}

	if v := envInt("MAX_DIMENSION"); v > 0 {
		preset.MaxDimension = v
	}
	if v := envInt("DEFAULT_QUALITY"); v > 0 {
		preset.DefaultQuality = v
	}
	if v := envInt("CACHE_MAX_MEMORY_MB"); v > 0 {
		preset.Cache.MaxMemoryMB = v
	}
	if v := envInt("CACHE_MAX_DISK_GB"); v > 0 {
		preset.Cache.MaxDiskGB = v
	}

	if v := os.Getenv("NSFW_MODEL_PATH"); v != "" {
		preset.NSFW.ModelPath = v
	}
	preset.NSFW.ORTLibPath = os.Getenv("ONNXRUNTIME_LIB_PATH")

	if raw := os.Getenv("NSFW_THRESHOLD"); raw != "" {
		threshold, ok := envFloat("NSFW_THRESHOLD")
		if !ok || threshold < 0 || threshold > 1 {
			preset.NSFW.Threshold = 0
			preset.NSFW.DisabledReason = "invalid NSFW_THRESHOLD"
		} else {
			preset.NSFW.Threshold = float32(threshold)
		}
	}

	if raw := os.Getenv("NSFW_CONCURRENCY"); raw != "" {
		n, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || n < 1 {
			preset.NSFW.Concurrency = 2
			preset.NSFW.ConcurrencyWarning = true
		} else {
			preset.NSFW.Concurrency = n
		}
	}

	return preset
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string) int {
	v := os.Getenv(key)
	if v == "" {
		return 0
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0
	}
	return n
}

// envFloat parses a finite float. The bool is false when the variable is
// empty or invalid; callers that need to distinguish "unset" from "invalid"
// check os.Getenv themselves.
func envFloat(key string) (float64, bool) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}
