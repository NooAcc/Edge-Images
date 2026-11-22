package params

import (
	"net/url"
	"strings"
	"testing"

	"edge-image/internal/allowlist"
	"edge-image/internal/config"
)

func TestParseNSFWJS(t *testing.T) {
	cases := []struct {
		raw     string
		want    bool
		wantErr bool
	}{
		{"", false, false},      // parameter absent
		{"nsfwjs", true, false}, // present but empty
		{"nsfwjs=", true, false},
		{"nsfwjs=1", true, false},
		{"nsfwjs=TRUE", true, false},
		{"nsfwjs=yes", true, false},
		{"nsfwjs=on", true, false},
		{"nsfwjs=0", false, false},
		{"nsfwjs=false", false, false},
		{"nsfwjs=no", false, false},
		{"nsfwjs=off", false, false},
		{"nsfwjs=maybe", false, true},
	}

	for _, tc := range cases {
		t.Run(tc.raw, func(t *testing.T) {
			query, err := url.ParseQuery(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			got, err := parseNSFWJS(query)
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
				t.Fatalf("parseNSFWJS = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestParseNSFWJSONConflict(t *testing.T) {
	t.Setenv("IMAGE_URL_ALLOWLIST", "")

	query, _ := url.ParseQuery("format=json&nsfwjs=1")
	if _, err := Parse("https://example.com/x.png", query, config.PlatformConfig{}, allowlist.NewFromEnv()); err == nil {
		t.Fatal("expected error for format=json with nsfwjs enabled")
	} else if !strings.Contains(err.Error(), "format=json") {
		t.Fatalf("error = %q, want mention of format=json", err)
	}

	query, _ = url.ParseQuery("format=json&nsfwjs=0")
	p, err := Parse("https://example.com/x.png", query, config.PlatformConfig{}, allowlist.NewFromEnv())
	if err != nil {
		t.Fatal(err)
	}
	if p.NSFWJS {
		t.Fatal("NSFWJS = true, want false")
	}
	if p.Format != "json" {
		t.Fatalf("format = %q, want json", p.Format)
	}
}

func TestParseSetsNSFWJS(t *testing.T) {
	t.Setenv("IMAGE_URL_ALLOWLIST", "")

	query, _ := url.ParseQuery("nsfwjs=yes")
	p, err := Parse("https://example.com/x.png", query, config.PlatformConfig{}, allowlist.NewFromEnv())
	if err != nil {
		t.Fatal(err)
	}
	if !p.NSFWJS {
		t.Fatal("NSFWJS = false, want true")
	}
}
