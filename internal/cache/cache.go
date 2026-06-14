package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dgraph-io/ristretto/v2"
)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const (
	cleanupInterval = 10 * time.Minute // disk-usage check period
	metaExt         = ".meta"          // sidecar metadata extension
	filesDir        = "files"          // subdirectory for cached files
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Entry holds a cached response body and its MIME type.
type Entry struct {
	Buffer      []byte
	ContentType string
}

// metaFile is the JSON structure stored in .meta sidecar files.
type metaFile struct {
	ContentType string `json:"ct"`
}

// fileEntry tracks a discovered file during cleanup walks.
type fileEntry struct {
	dataPath string
	size     int64
	mtime    time.Time
}

// Cache is a two-tier (memory + disk) cache.
// Memory tier: Ristretto (TinyLFU).  Disk tier: pure filesystem (no database).
type Cache struct {
	mem      *ristretto.Cache[string, *Entry]
	basePath string // base storage path for cache files
	maxBytes int64
	log      *slog.Logger

	done    chan struct{}
	closeWg sync.WaitGroup
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

// New creates a Cache.  Memory tier is created when maxMemoryMB > 0.
// Disk tier is created when maxDiskGB > 0 and basePath is non-empty.
// On disk-open failure the disk tier is silently disabled and the cache runs
// memory-only.
func New(maxMemoryMB, maxDiskGB int, basePath string, log *slog.Logger) (*Cache, error) {
	c := &Cache{
		log:      log,
		done:     make(chan struct{}),
		basePath: basePath,
	}

	// ---- memory tier ----
	if maxMemoryMB > 0 {
		mem, err := ristretto.NewCache(&ristretto.Config[string, *Entry]{
			NumCounters: int64(maxMemoryMB) * 10,
			MaxCost:     int64(maxMemoryMB) * 1024 * 1024,
			BufferItems: 64,
		})
		if err != nil {
			return nil, fmt.Errorf("create memory cache: %w", err)
		}
		c.mem = mem
	}

	// ---- disk tier ----
	diskEnabled := false
	if maxDiskGB > 0 && basePath != "" {
		c.maxBytes = int64(maxDiskGB) * 1024 * 1024 * 1024

		if err := c.initDisk(); err != nil {
			log.Error("cache: disk init failed, disabling disk tier", "error", err)
		} else {
			diskEnabled = true
		}
	}

	// Start cleanup loop
	c.closeWg.Add(1)
	go c.cleanupLoop()

	log.Info("cache: initialized",
		"memoryMB", maxMemoryMB,
		"diskGB", maxDiskGB,
		"diskEnabled", diskEnabled)

	return c, nil
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Get returns the cached entry for key, or (nil, false) on miss.
// Memory tier is checked first; a disk hit is promoted to memory.
func (c *Cache) Get(key string) (*Entry, bool) {
	// fast path — memory
	if c.mem != nil {
		if e, ok := c.mem.Get(key); ok && e != nil {
			c.log.Info("cache: mem hit", "key", key, "bytes", len(e.Buffer))
			return e, true
		}
	}

	// slow path — disk
	if c.maxBytes <= 0 {
		return nil, false
	}

	dataPath := c.buildFilePath(key)
	buffer, err := os.ReadFile(dataPath)
	if err != nil {
		return nil, false
	}

	ct := c.readMeta(key)

	// Update mtime so cleanup sees this as recently used
	_ = os.Chtimes(dataPath, time.Now(), time.Now())

	result := &Entry{
		Buffer:      buffer,
		ContentType: ct,
	}

	// promote to memory
	if c.mem != nil {
		c.mem.Set(key, result, int64(len(result.Buffer)))
	}

	c.log.Info("cache: disk hit", "key", key, "bytes", len(result.Buffer), "path", dataPath)
	return result, true
}

// Set stores entry under key in both memory and disk tiers.
func (c *Cache) Set(key string, entry *Entry) {
	if c.mem != nil {
		c.mem.Set(key, entry, int64(len(entry.Buffer)))
	}

	if c.maxBytes <= 0 {
		return
	}

	dataPath := c.buildFilePath(key)

	// Ensure parent directory exists
	dir := filepath.Dir(dataPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		c.log.Warn("cache: create dir failed", "path", dir, "error", err)
		return
	}

	// Write data file
	if err := os.WriteFile(dataPath, entry.Buffer, 0644); err != nil {
		c.log.Warn("cache: file write failed", "key", key, "error", err)
		return
	}

	// Write sidecar metadata
	c.writeMeta(key, entry.ContentType)

	c.log.Info("cache: disk write", "key", key, "bytes", len(entry.Buffer), "path", dataPath)
}

// Close stops the cleanup loop. Memory tier is closed by the caller if needed.
func (c *Cache) Close() {
	select {
	case <-c.done:
	default:
		close(c.done)
	}
	c.closeWg.Wait()

	if c.mem != nil {
		c.mem.Close()
	}
}

// GetStats returns cache statistics by walking the filesystem.
func (c *Cache) GetStats() (diskEntries int64, diskSize int64, err error) {
	if c.maxBytes <= 0 {
		return 0, 0, nil
	}

	filesDir := filepath.Join(c.basePath, filesDir)
	err = filepath.WalkDir(filesDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil // skip inaccessible entries
		}
		if d.IsDir() || filepath.Ext(path) == metaExt {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		diskEntries++
		diskSize += info.Size()
		return nil
	})

	return diskEntries, diskSize, err
}

// ---------------------------------------------------------------------------
// Disk management
// ---------------------------------------------------------------------------

// initDisk ensures the base cache directory structure exists.
func (c *Cache) initDisk() error {
	if err := os.MkdirAll(c.basePath, 0755); err != nil {
		return fmt.Errorf("create cache dir: %w", err)
	}
	filesPath := filepath.Join(c.basePath, filesDir)
	if err := os.MkdirAll(filesPath, 0755); err != nil {
		return fmt.Errorf("create files dir: %w", err)
	}
	return nil
}

// buildFilePath constructs the filesystem path for a cache key.
//
//	<basePath>/files/<keyType>/<hash[:2]>/<hash>
func (c *Cache) buildFilePath(key string) string {
	parts := strings.SplitN(key, ":", 2)
	keyType := "other"
	hash := key
	if len(parts) == 2 {
		keyType = parts[0]
		hash = parts[1]
	}

	prefix := ""
	if len(hash) >= 2 {
		prefix = hash[:2]
	}
	return filepath.Join(c.basePath, filesDir, keyType, prefix, hash)
}

// metaPath returns the sidecar .meta file path for a given key.
func (c *Cache) metaPath(key string) string {
	return c.buildFilePath(key) + metaExt
}

// readMeta reads the content type from the .meta sidecar file.
// Returns "application/octet-stream" if the file is missing or unreadable.
func (c *Cache) readMeta(key string) string {
	mp := c.metaPath(key)
	data, err := os.ReadFile(mp)
	if err != nil {
		return "application/octet-stream"
	}
	var m metaFile
	if err := json.Unmarshal(data, &m); err != nil || m.ContentType == "" {
		return "application/octet-stream"
	}
	return m.ContentType
}

// writeMeta writes the content type to the .meta sidecar file.
func (c *Cache) writeMeta(key string, contentType string) {
	mp := c.metaPath(key)
	data, _ := json.Marshal(metaFile{ContentType: contentType})
	if err := os.WriteFile(mp, data, 0644); err != nil {
		c.log.Warn("cache: meta write failed", "key", key, "error", err)
	}
}

// deleteEntry removes a cached file and its sidecar from the filesystem.
func (c *Cache) deleteEntry(key string) {
	dp := c.buildFilePath(key)
	mp := c.metaPath(key)
	_ = os.Remove(dp)
	_ = os.Remove(mp)
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

func (c *Cache) cleanupLoop() {
	defer c.closeWg.Done()

	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			c.Cleanup()
		case <-c.done:
			return
		}
	}
}

// Cleanup evicts the oldest entries (by mtime) when disk usage exceeds the
// configured limit, reclaiming down to 90%.
func (c *Cache) Cleanup() {
	if c.maxBytes <= 0 {
		return
	}

	entries, totalSize, err := c.collectFiles()
	if err != nil {
		c.log.Warn("cache: cleanup walk failed", "error", err)
		return
	}

	if totalSize <= c.maxBytes {
		return
	}

	target := c.maxBytes * 9 / 10

	// Sort oldest first (by mtime ascending)
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].mtime.Before(entries[j].mtime)
	})

	var freed int64
	for _, e := range entries {
		if totalSize-freed <= target {
			break
		}

		// Remove data file
		if err := os.Remove(e.dataPath); err != nil && !os.IsNotExist(err) {
			c.log.Warn("cache: cleanup delete file failed", "path", e.dataPath, "error", err)
			continue
		}
		// Remove sidecar meta file (ignore if absent)
		_ = os.Remove(e.dataPath + metaExt)

		freed += e.size
	}

	if freed > 0 {
		c.log.Info("cache: cleanup done", "freedMB", freed/1024/1024, "entries", len(entries))
	}
}

// collectFiles walks the cache files directory and returns all data files
// (excluding .meta sidecars) with their sizes and modification times.
func (c *Cache) collectFiles() ([]fileEntry, int64, error) {
	var entries []fileEntry
	var totalSize int64

	root := filepath.Join(c.basePath, filesDir)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil // skip inaccessible entries
		}
		if d.IsDir() {
			return nil
		}
		// Skip .meta sidecar files
		if filepath.Ext(path) == metaExt {
			return nil
		}

		info, err := d.Info()
		if err != nil {
			return nil
		}

		entries = append(entries, fileEntry{
			dataPath: path,
			size:     info.Size(),
			mtime:    info.ModTime(),
		})
		totalSize += info.Size()
		return nil
	})

	return entries, totalSize, err
}

// ---------------------------------------------------------------------------
// Cache keys
// ---------------------------------------------------------------------------

// BuildCacheKey returns a deterministic cache key.
//
//	"source:<sha256(url)>"
//	"meta:<sha256(url)>"
//	"processed:<sha256(url)>_<sha256(params)[:16]>"
func BuildCacheKey(keyType, url string, params ...string) string {
	h := sha256Hex(url)
	switch keyType {
	case "source":
		return "source:" + h
	case "meta":
		return "meta:" + h
	case "processed":
		ps := strings.Join(params, "|")
		return "processed:" + h + "_" + sha256Hex(ps)[:16]
	default:
		return keyType + ":" + h
	}
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
