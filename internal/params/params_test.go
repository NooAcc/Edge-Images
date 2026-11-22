package params

import (
	"net/url"
	"strings"
	"testing"

	"edge-image/internal/allowlist"
	"edge-image/internal/config"
)

func TestParseNSFW(t *testing.T) {
	cases := []struct {
		raw     string
		want    bool
		wantErr bool
	}{
		{"", false, false},    // parameter absent
		{"nsfw", true, false}, // present but empty
		{"nsfw=", true, false},
		{"nsfw=1", true, false},
		{"nsfw=TRUE", true, false},
		{"nsfw=yes", true, false},
		{"nsfw=on", true, false},
		{"nsfw=0", false, false},
		{"nsfw=false", false, false},
		{"nsfw=no", false, false},
		{"nsfw=off", false, false},
		{"nsfw=maybe", false, true},
	}

	for _, tc := range cases {
		t.Run(tc.raw, func(t *testing.T) {
			query, err := url.ParseQuery(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			got, err := parseNSFW(query)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %v", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("parseNSFW = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestParseIgnoresLegacyNSFWJS(t *testing.T) {
	t.Setenv("IMAGE_URL_ALLOWLIST", "")
	query, _ := url.ParseQuery("nsfwjs=1")
	p, err := Parse("https://example.com/x.png", query, config.PlatformConfig{}, allowlist.NewFromEnv())
	if err != nil {
		t.Fatal(err)
	}
	if p.NSFW {
		t.Fatal("legacy nsfwjs must not enable classification")
	}
}

func TestParseNSFWJSONConflict(t *testing.T) {
	t.Setenv("IMAGE_URL_ALLOWLIST", "")

	query, _ := url.ParseQuery("format=json&nsfw=1")
	if _, err := Parse("https://example.com/x.png", query, config.PlatformConfig{}, allowlist.NewFromEnv()); err == nil {
		t.Fatal("expected error for format=json with nsfw enabled")
	} else if !strings.Contains(err.Error(), "format=json") {
		t.Fatalf("error = %q, want mention of format=json", err)
	}

	query, _ = url.ParseQuery("format=json&nsfw=0")
	p, err := Parse("https://example.com/x.png", query, config.PlatformConfig{}, allowlist.NewFromEnv())
	if err != nil {
		t.Fatal(err)
	}
	if p.NSFW {
		t.Fatal("NSFW = true, want false")
	}
	if p.Format != "json" {
		t.Fatalf("format = %q, want json", p.Format)
	}
}

func TestParseInlineSkipsURLValidation(t *testing.T) {
	query, _ := url.ParseQuery("width=100&format=png&nsfw=on")
	p, err := ParseInline("inline:abc123", query, config.PlatformConfig{MaxDimension: 2048, DefaultQuality: 90})
	if err != nil {
		t.Fatal(err)
	}
	if p.URL != "inline:abc123" {
		t.Fatalf("URL = %q, want inline:abc123", p.URL)
	}
	if p.Width != 100 {
		t.Fatalf("width = %d, want 100", p.Width)
	}
	if p.Format != "png" {
		t.Fatalf("format = %q, want png", p.Format)
	}
	if !p.NSFW {
		t.Fatal("NSFW = false, want true")
	}
}

func TestParseInlineRejectsEmptySourceKey(t *testing.T) {
	if _, err := ParseInline("", url.Values{}, config.PlatformConfig{}); err == nil {
		t.Fatal("expected error for empty source key")
	}
}

func TestParseInlineRejectsNSFWWithJSON(t *testing.T) {
	query, _ := url.ParseQuery("format=json&nsfw=1")
	if _, err := ParseInline("inline:abc123", query, config.PlatformConfig{}); err == nil {
		t.Fatal("expected error for format=json with nsfw enabled")
	}
}

func TestParseSetsNSFW(t *testing.T) {
	t.Setenv("IMAGE_URL_ALLOWLIST", "")

	query, _ := url.ParseQuery("nsfw=yes")
	p, err := Parse("https://example.com/x.png", query, config.PlatformConfig{}, allowlist.NewFromEnv())
	if err != nil {
		t.Fatal(err)
	}
	if !p.NSFW {
		t.Fatal("NSFW = false, want true")
	}
}
