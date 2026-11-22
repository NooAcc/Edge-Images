package cache

import (
	"strings"
	"testing"
)

func TestBuildCacheKeyNSFW(t *testing.T) {
	a := BuildCacheKey("nsfw", "https://e/x", "modelA", "0.5000")
	if !strings.HasPrefix(a, "nsfw:") {
		t.Fatal(a)
	}
	if a != BuildCacheKey("nsfw", "https://e/x", "modelA", "0.5000") {
		t.Fatal("key is not stable")
	}
	if a == BuildCacheKey("nsfw", "https://e/x", "modelB", "0.5000") {
		t.Fatal("model ID is not part of the key")
	}
	if a == BuildCacheKey("nsfw", "https://e/x", "modelA", "0.6000") {
		t.Fatal("threshold is not part of the key")
	}
	if a == BuildCacheKey("nsfw", "https://e/y", "modelA", "0.5000") {
		t.Fatal("URL is not part of the key")
	}
}

func TestBuildCacheKeyProcessedUnchanged(t *testing.T) {
	got := BuildCacheKey("processed", "https://e/x", "800", "600")
	if !strings.HasPrefix(got, "processed:") {
		t.Fatal(got)
	}
	if got == BuildCacheKey("processed", "https://e/x", "400", "600") {
		t.Fatal("processed params are not part of the key")
	}
}
