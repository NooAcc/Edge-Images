package allowlist

import (
	"os"
	"strings"
)

type Allowlist struct {
	allowed map[string]bool
	all     bool
}

func NewFromEnv() *Allowlist {
	raw := os.Getenv("IMAGE_URL_ALLOWLIST")
	if raw == "" {
		return &Allowlist{all: true}
	}

	entries := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' '
	})

	allowed := make(map[string]bool, len(entries))
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "*" {
			return &Allowlist{all: true}
		}
		if entry != "" {
			allowed[strings.ToLower(entry)] = true
		}
	}

	return &Allowlist{allowed: allowed}
}

func (a *Allowlist) IsAllowed(host string) bool {
	if a.all {
		return true
	}

	host = strings.ToLower(host)

	if a.allowed[host] {
		return true
	}

	for {
		idx := strings.Index(host, ".")
		if idx < 0 {
			break
		}
		host = host[idx+1:]
		if a.allowed[host] {
			return true
		}
	}

	return false
}
