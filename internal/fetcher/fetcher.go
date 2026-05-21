package fetcher

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultTimeout    = 20 * time.Second
	DefaultMaxBytes   = 50 * 1024 * 1024
	DefaultMetaRange  = 64 * 1024
	DefaultRetryCount = 3
	VideoRangeSize    = 512 * 1024
	VideoTimeout      = 30 * time.Second
)

var retryDelays = []time.Duration{500 * time.Millisecond, 1 * time.Second, 2 * time.Second}

var retryableStatuses = map[int]bool{
	403: true, 429: true, 500: true, 502: true, 503: true, 504: true,
}

type Result struct {
	Buffer      []byte
	ContentType string
	SourceSize  int64
}

type Fetcher struct {
	client   *http.Client
	log      *slog.Logger
	maxBytes int64
}

func New(log *slog.Logger) *Fetcher {
	return &Fetcher{
		client: &http.Client{
			Timeout: DefaultTimeout,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
			},
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 10 {
					return fmt.Errorf("too many redirects")
				}
				return nil
			},
		},
		log:      log,
		maxBytes: DefaultMaxBytes,
	}
}

func (f *Fetcher) FetchImage(url string) (*Result, error) {
	return f.fetchWithRetry(url, "", DefaultTimeout, f.maxBytes)
}

func (f *Fetcher) FetchImageRange(url string, rangeSize int) (*Result, error) {
	rangeHeader := fmt.Sprintf("bytes=0-%d", rangeSize-1)
	return f.fetchWithRetry(url, rangeHeader, DefaultTimeout, int64(rangeSize))
}

func (f *Fetcher) FetchVideoRange(url string) (*Result, error) {
	rangeHeader := fmt.Sprintf("bytes=0-%d", VideoRangeSize-1)
	return f.fetchWithRetry(url, rangeHeader, VideoTimeout, int64(VideoRangeSize))
}

func (f *Fetcher) FetchVideoFull(url string) (*Result, error) {
	return f.fetchWithRetry(url, "", VideoTimeout, 0)
}

func (f *Fetcher) fetchWithRetry(url, rangeHeader string, timeout time.Duration, maxBytes int64) (*Result, error) {
	var lastErr error

	for attempt := 0; attempt <= DefaultRetryCount; attempt++ {
		if attempt > 0 {
			delay := retryDelays[attempt-1]
			if attempt > len(retryDelays) {
				delay = retryDelays[len(retryDelays)-1]
			}
			time.Sleep(delay)
			f.log.Warn("fetcher: retry", "url", url, "attempt", attempt, "error", lastErr)
		}

		result, err := f.fetchOnce(url, rangeHeader, timeout, maxBytes)
		if err == nil {
			return result, nil
		}

		lastErr = err

		if fe, ok := err.(*FetchError); ok && !fe.Retryable {
			return nil, err
		}
	}

	return nil, fmt.Errorf("fetch exhausted after %d retries: %w", DefaultRetryCount, lastErr)
}

func (f *Fetcher) fetchOnce(url, rangeHeader string, timeout time.Duration, maxBytes int64) (*Result, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, &FetchError{Message: "failed to create request", Retryable: true}
	}

	setHeaders(req, rangeHeader)

	resp, err := f.client.Do(req)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, &FetchError{Message: "fetch timed out", Retryable: true}
		}
		return nil, &FetchError{Message: err.Error(), Retryable: true}
	}
	defer resp.Body.Close()

	if fe := checkStatus(resp); fe != nil {
		return nil, fe
	}

	contentType := parseContentType(resp.Header.Get("Content-Type"))
	sourceSize := parseSourceSize(resp.Header, rangeHeader != "")

	if maxBytes > 0 {
		if cl := resp.Header.Get("Content-Length"); cl != "" {
			if size, err := strconv.ParseInt(cl, 10, 64); err == nil && size > maxBytes {
				return nil, &FetchError{Message: fmt.Sprintf("source exceeds %d bytes", maxBytes)}
			}
		}
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, &FetchError{Message: "body read timed out", Retryable: true}
		}
		return nil, &FetchError{Message: "body read failed", Retryable: true}
	}

	if maxBytes > 0 && int64(len(body)) > maxBytes {
		return nil, &FetchError{Message: fmt.Sprintf("source exceeds %d bytes", maxBytes)}
	}

	return &Result{
		Buffer:      body,
		ContentType: contentType,
		SourceSize:  sourceSize,
	}, nil
}

func setHeaders(req *http.Request, rangeHeader string) {
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")

	if origin := getOrigin(req.URL.String()); origin != "" {
		req.Header.Set("Referer", origin+"/")
	}

	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
}

func getOrigin(rawURL string) string {
	idx := strings.Index(rawURL, "://")
	if idx < 0 {
		return ""
	}
	rest := rawURL[idx+3:]
	slashIdx := strings.Index(rest, "/")
	if slashIdx < 0 {
		return rawURL
	}
	return rawURL[:idx+3+slashIdx]
}

func checkStatus(resp *http.Response) *FetchError {
	if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusPartialContent {
		return nil
	}

	return &FetchError{
		Message:    fmt.Sprintf("source returned HTTP %d", resp.StatusCode),
		StatusCode: resp.StatusCode,
		Retryable:  retryableStatuses[resp.StatusCode],
	}
}

func parseContentType(raw string) string {
	if idx := strings.Index(raw, ";"); idx >= 0 {
		return strings.TrimSpace(raw[:idx])
	}
	return strings.TrimSpace(raw)
}

func parseSourceSize(header http.Header, allowContentLength bool) int64 {
	cr := header.Get("Content-Range")
	if cr != "" {
		parts := strings.Split(cr, "/")
		if len(parts) == 2 && parts[1] != "*" {
			if size, err := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64); err == nil {
				return size
			}
		}
	}

	if allowContentLength {
		cl := header.Get("Content-Length")
		if cl != "" {
			if size, err := strconv.ParseInt(cl, 10, 64); err == nil {
				return size
			}
		}
	}

	return 0
}

type FetchError struct {
	Message    string
	StatusCode int
	Retryable  bool
}

func (e *FetchError) Error() string {
	return e.Message
}
