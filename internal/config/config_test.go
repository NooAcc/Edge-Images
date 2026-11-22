package config

import "testing"

func clearNSFWEnv(t *testing.T) {
	t.Helper()
	t.Setenv("NSFW_MODEL_PATH", "")
	t.Setenv("ONNXRUNTIME_LIB_PATH", "")
	t.Setenv("NSFW_THRESHOLD", "")
	t.Setenv("NSFW_CONCURRENCY", "")
}

func TestLoadNSFWDefaults(t *testing.T) {
	clearNSFWEnv(t)

	cfg := Load()
	if cfg.NSFW.ModelPath != "models/nsfwjs_mobilenet_v2.onnx" {
		t.Fatalf("ModelPath = %q", cfg.NSFW.ModelPath)
	}
	if cfg.NSFW.ORTLibPath != "" {
		t.Fatalf("ORTLibPath = %q", cfg.NSFW.ORTLibPath)
	}
	if cfg.NSFW.Threshold != 0.5 {
		t.Fatalf("Threshold = %v", cfg.NSFW.Threshold)
	}
	if cfg.NSFW.Concurrency != 2 {
		t.Fatalf("Concurrency = %d", cfg.NSFW.Concurrency)
	}
	if cfg.NSFW.DisabledReason != "" {
		t.Fatalf("DisabledReason = %q", cfg.NSFW.DisabledReason)
	}
	if cfg.NSFW.ConcurrencyWarning {
		t.Fatal("ConcurrencyWarning = true")
	}
}

func TestLoadNSFWInvalidThreshold(t *testing.T) {
	for _, raw := range []string{"abc", "NaN", "-0.1", "1.1", "Inf"} {
		t.Run(raw, func(t *testing.T) {
			clearNSFWEnv(t)
			t.Setenv("NSFW_THRESHOLD", raw)

			cfg := Load()
			if cfg.NSFW.DisabledReason == "" {
				t.Fatalf("DisabledReason is empty for NSFW_THRESHOLD=%q", raw)
			}
		})
	}
}

func TestLoadNSFWValidThreshold(t *testing.T) {
	clearNSFWEnv(t)
	t.Setenv("NSFW_THRESHOLD", "0.65")

	cfg := Load()
	if cfg.NSFW.DisabledReason != "" {
		t.Fatalf("DisabledReason = %q", cfg.NSFW.DisabledReason)
	}
	if cfg.NSFW.Threshold != 0.65 {
		t.Fatalf("Threshold = %v", cfg.NSFW.Threshold)
	}
}

func TestLoadNSFWInvalidConcurrency(t *testing.T) {
	for _, raw := range []string{"0", "abc", "-2"} {
		t.Run(raw, func(t *testing.T) {
			clearNSFWEnv(t)
			t.Setenv("NSFW_CONCURRENCY", raw)

			cfg := Load()
			if !cfg.NSFW.ConcurrencyWarning {
				t.Fatalf("ConcurrencyWarning = false for NSFW_CONCURRENCY=%q", raw)
			}
			if cfg.NSFW.Concurrency != 2 {
				t.Fatalf("Concurrency = %d, want 2", cfg.NSFW.Concurrency)
			}
		})
	}
}

func TestLoadNSFWValidConcurrency(t *testing.T) {
	clearNSFWEnv(t)
	t.Setenv("NSFW_CONCURRENCY", "4")

	cfg := Load()
	if cfg.NSFW.ConcurrencyWarning {
		t.Fatal("ConcurrencyWarning = true")
	}
	if cfg.NSFW.Concurrency != 4 {
		t.Fatalf("Concurrency = %d, want 4", cfg.NSFW.Concurrency)
	}
}

func TestLoadNSFWPaths(t *testing.T) {
	clearNSFWEnv(t)
	t.Setenv("NSFW_MODEL_PATH", "/x/model.onnx")
	t.Setenv("ONNXRUNTIME_LIB_PATH", "/y/libonnxruntime.so")

	cfg := Load()
	if cfg.NSFW.ModelPath != "/x/model.onnx" {
		t.Fatalf("ModelPath = %q", cfg.NSFW.ModelPath)
	}
	if cfg.NSFW.ORTLibPath != "/y/libonnxruntime.so" {
		t.Fatalf("ORTLibPath = %q", cfg.NSFW.ORTLibPath)
	}
}
