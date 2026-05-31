package cache

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dgraph-io/ristretto/v2"
	_ "github.com/mattn/go-sqlite3"
)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const (
	cleanupInterval = 10 * time.Minute // disk-usage check period
	dbFilename      = "cache.db"       // SQLite数据库文件名
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Entry holds a cached response body and its MIME type.
type Entry struct {
	Buffer      []byte
	ContentType string
}

// cacheEntry represents a row in the SQLite cache_entries table.
type cacheEntry struct {
	Key         string
	ContentType string
	FilePath    string
	Size        int64
	CreatedAt   int64
	AccessedAt  int64
}

// Cache is a two-tier (memory + disk) cache.
// Memory tier: Ristretto (TinyLFU).  Disk tier: SQLite + filesystem.
type Cache struct {
	mem       *ristretto.Cache[string, *Entry]
	db        *sql.DB
	basePath  string // base storage path for SQLite db + cache files
	maxBytes  int64
	log       *slog.Logger
	mu        sync.RWMutex // guards db pointer

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
	if maxDiskGB > 0 && basePath != "" {
		c.maxBytes = int64(maxDiskGB) * 1024 * 1024 * 1024

		if err := c.openDisk(); err != nil {
			log.Error("cache: disk open failed, disabling disk tier", "error", err)
			// Don't fail — just run memory-only
		}
	}

	// Start cleanup loop
	c.closeWg.Add(1)
	go c.cleanupLoop()

	log.Info("cache: initialized",
		"memoryMB", maxMemoryMB,
		"diskGB", maxDiskGB,
		"diskEnabled", c.db != nil)

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
			return e, true
		}
	}

	// slow path — disk
	c.mu.RLock()
	db := c.db
	c.mu.RUnlock()
	if db == nil {
		return nil, false
	}

	var entry cacheEntry
	err := db.QueryRow(`
		SELECT key, content_type, file_path, size, created_at, accessed_at
		FROM cache_entries WHERE key = ?
	`, key).Scan(
		&entry.Key, &entry.ContentType, &entry.FilePath,
		&entry.Size, &entry.CreatedAt, &entry.AccessedAt,
	)
	if err != nil {
		if err != sql.ErrNoRows {
			c.log.Warn("cache: sqlite read error", "key", key, "error", err)
		}
		return nil, false
	}

	// Read file from filesystem
	buffer, err := os.ReadFile(entry.FilePath)
	if err != nil {
		c.log.Warn("cache: file read error", "key", key, "path", entry.FilePath, "error", err)
		// Remove invalid entry from database
		c.deleteEntry(key)
		return nil, false
	}

	result := &Entry{
		Buffer:      buffer,
		ContentType: entry.ContentType,
	}

	// Update accessed_at timestamp (async)
	go c.updateAccessTime(key)

	// promote to memory
	if c.mem != nil {
		c.mem.Set(key, result, int64(len(result.Buffer)))
	}
	return result, true
}

// Set stores entry under key in both memory and disk tiers.
// Disk write is synchronous and transactional.
func (c *Cache) Set(key string, entry *Entry) {
	if c.mem != nil {
		c.mem.Set(key, entry, int64(len(entry.Buffer)))
	}

	c.mu.RLock()
	db := c.db
	c.mu.RUnlock()
	if db == nil {
		return
	}

	// Determine file path based on key type
	filePath := c.buildFilePath(key)

	// Ensure directory exists
	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		c.log.Warn("cache: create dir failed", "path", dir, "error", err)
		return
	}

	// Write file to filesystem
	if err := os.WriteFile(filePath, entry.Buffer, 0644); err != nil {
		c.log.Warn("cache: file write failed", "key", key, "error", err)
		return
	}

	// Insert or replace entry in SQLite
	now := time.Now().Unix()
	_, err := db.Exec(`
		INSERT OR REPLACE INTO cache_entries
		(key, content_type, file_path, size, created_at, accessed_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`, key, entry.ContentType, filePath, int64(len(entry.Buffer)), now, now)
	if err != nil {
		c.log.Warn("cache: sqlite write failed", "key", key, "error", err)
		// Clean up file if database write failed
		os.Remove(filePath)
	}
}

// Close closes disk and memory tiers.
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

	c.mu.Lock()
	db := c.db
	c.db = nil
	c.mu.Unlock()

	if db != nil {
		if err := db.Close(); err != nil {
			c.log.Warn("cache: db close failed", "error", err)
		}
	}
}

// ---------------------------------------------------------------------------
// Disk management
// ---------------------------------------------------------------------------

// openDisk opens (or creates) the SQLite database and sets c.db.
func (c *Cache) openDisk() error {
	// Create base directory if it doesn't exist
	if err := os.MkdirAll(c.basePath, 0755); err != nil {
		return fmt.Errorf("create cache dir: %w", err)
	}

	dbPath := filepath.Join(c.basePath, dbFilename)
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=ON")
	if err != nil {
		return fmt.Errorf("open sqlite: %w", err)
	}

	// Verify connection
	if err := db.Ping(); err != nil {
		db.Close()
		return fmt.Errorf("ping sqlite: %w", err)
	}

	// Create cache_entries table if it doesn't exist
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS cache_entries (
			key TEXT PRIMARY KEY,
			content_type TEXT NOT NULL,
			file_path TEXT NOT NULL,
			size INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			accessed_at INTEGER NOT NULL
		)
	`); err != nil {
		db.Close()
		return fmt.Errorf("create table: %w", err)
	}

	// Create indexes for efficient cleanup queries
	if _, err := db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_created_at ON cache_entries(created_at)
	`); err != nil {
		db.Close()
		return fmt.Errorf("create index: %w", err)
	}

	if _, err := db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_accessed_at ON cache_entries(accessed_at)
	`); err != nil {
		db.Close()
		return fmt.Errorf("create index: %w", err)
	}

	c.mu.Lock()
	c.db = db
	c.mu.Unlock()
	return nil
}

// buildFilePath constructs the filesystem path for a cache key.
func (c *Cache) buildFilePath(key string) string {
	// Extract key type (source, meta, processed)
	parts := strings.SplitN(key, ":", 2)
	keyType := "other"
	hash := key
	if len(parts) == 2 {
		keyType = parts[0]
		hash = parts[1]
	}

	// Create directory structure: basePath/files/keyType/hash
	// Split hash into 2-char prefix directories for better filesystem distribution
	prefix := ""
	if len(hash) >= 2 {
		prefix = hash[:2]
	}
	return filepath.Join(c.basePath, "files", keyType, prefix, hash)
}

// deleteEntry removes an entry from the database and filesystem.
func (c *Cache) deleteEntry(key string) {
	c.mu.RLock()
	db := c.db
	c.mu.RUnlock()
	if db == nil {
		return
	}

	var filePath string
	err := db.QueryRow("SELECT file_path FROM cache_entries WHERE key = ?", key).Scan(&filePath)
	if err != nil {
		return
	}

	// Delete from database
	if _, err := db.Exec("DELETE FROM cache_entries WHERE key = ?", key); err != nil {
		c.log.Warn("cache: delete from db failed", "key", key, "error", err)
	}

	// Delete file
	if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
		c.log.Warn("cache: delete file failed", "key", key, "path", filePath, "error", err)
	}
}

// updateAccessTime updates the accessed_at timestamp for a key.
func (c *Cache) updateAccessTime(key string) {
	c.mu.RLock()
	db := c.db
	c.mu.RUnlock()
	if db == nil {
		return
	}

	_, err := db.Exec("UPDATE cache_entries SET accessed_at = ? WHERE key = ?", time.Now().Unix(), key)
	if err != nil {
		c.log.Warn("cache: update access time failed", "key", key, "error", err)
	}
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

// Cleanup evicts the oldest entries when disk usage exceeds the configured
// limit, reclaiming down to 90%.
func (c *Cache) Cleanup() {
	c.mu.RLock()
	db := c.db
	maxBytes := c.maxBytes
	c.mu.RUnlock()

	if db == nil || maxBytes <= 0 {
		return
	}

	// Calculate current disk usage from database
	usage, err := c.calculateDiskUsage()
	if err != nil {
		c.log.Warn("cache: calculate disk usage failed", "error", err)
		return
	}

	if usage <= maxBytes {
		return
	}

	target := maxBytes * 9 / 10
	var freed int64

	// Get oldest entries by created_at
	rows, err := db.Query(`
		SELECT key, file_path, size
		FROM cache_entries
		ORDER BY created_at ASC
	`)
	if err != nil {
		c.log.Warn("cache: cleanup query failed", "error", err)
		return
	}
	defer rows.Close()

	for rows.Next() {
		if usage-freed <= target {
			break
		}

		var key, filePath string
		var size int64
		if err := rows.Scan(&key, &filePath, &size); err != nil {
			c.log.Warn("cache: cleanup scan failed", "error", err)
			continue
		}

		// Delete from database
		if _, err := db.Exec("DELETE FROM cache_entries WHERE key = ?", key); err != nil {
			c.log.Warn("cache: cleanup delete from db failed", "key", key, "error", err)
			continue
		}

		// Delete file
		if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
			c.log.Warn("cache: cleanup delete file failed", "key", key, "path", filePath, "error", err)
		}

		freed += size
	}

	if freed > 0 {
		c.log.Info("cache: cleanup done", "freedMB", freed/1024/1024)
	}
}

// calculateDiskUsage calculates the total size of all cached files from the database.
func (c *Cache) calculateDiskUsage() (int64, error) {
	c.mu.RLock()
	db := c.db
	c.mu.RUnlock()
	if db == nil {
		return 0, nil
	}

	var totalSize int64
	err := db.QueryRow("SELECT COALESCE(SUM(size), 0) FROM cache_entries").Scan(&totalSize)
	if err != nil {
		return 0, err
	}
	return totalSize, nil
}

// GetStats returns cache statistics.
func (c *Cache) GetStats() (diskEntries int64, diskSize int64, err error) {
	c.mu.RLock()
	db := c.db
	c.mu.RUnlock()

	if db != nil {
		err = db.QueryRow("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM cache_entries").Scan(&diskEntries, &diskSize)
		if err != nil {
			return 0, 0, err
		}
	}

	return diskEntries, diskSize, nil
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
