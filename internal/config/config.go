package config

import (
	"os"
	"strconv"
)

type CacheConfig struct {
	Type        string
	MaxMemoryMB int
	MaxDiskGB   int
}

type PlatformConfig struct {
	MaxDimension    int
	DefaultQuality  int
	BatchConcurrency int
	Cache           CacheConfig
}

var presets = map[string]PlatformConfig{
	"huggingface": {
		MaxDimension:   2048,
		DefaultQuality: 90,
		Cache: CacheConfig{
			Type:        "lru+disk",
			MaxMemoryMB: 4096,
			MaxDiskGB:   50,
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
