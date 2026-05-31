package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dgraph-io/ristretto/v2"
	bolt "go.etcd.io/bbolt"
)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const (
	flushInterval   = 5 * time.Second  // drain-and-flush period
	cleanupInterval = 10 * time.Minute // disk-usage check period
	cacheBucket     = "cache"          // bbolt bucket name
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Entry holds a cached response body and its MIME type.
type Entry struct {
	Buffer      []byte
	ContentType string
}

// diskEntry is the JSON-serializable format stored in bbolt.
type diskEntry struct {
	Buffer      []byte `json:"b"`
	ContentType string `json:"c"`
	CreatedAt   int64  `json:"t"`
	Size        int64  `json:"s"`
}

type writeReq struct {
	key   string
	entry *Entry
}

// Cache is a two-tier (memory + disk) write-back cache.
// Memory tier: Ristretto (TinyLFU).  Disk tier: bbolt (B+ tree).
type Cache struct {
	mem      *ristretto.Cache[string, *Entry]
	db       *bolt.DB
	dbPath   string
	maxBytes int64
	log      *slog.Logger
	mu       sync.RWMutex // guards db pointer

	// write-back buffer
	pending chan writeReq
	done    chan struct{}
	flushWg sync.WaitGroup
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

// New creates a Cache.  Memory tier is created when maxMemoryMB > 0.
// Disk tier is created when maxDiskGB > 0 and dbPath is non-empty.
// On disk-open failure the disk tier is silently disabled and the cache runs
// memory-only.
func New(maxMemoryMB, maxDiskGB int, dbPath string, log *slog.Logger) (*Cache, error) {
	c := &Cache{
		log:     log,
		pending: make(chan writeReq, 1024),
		done:    make(chan struct{}),
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
	if maxDiskGB > 0 && dbPath != "" {
		c.maxBytes = int64(maxDiskGB) * 1024 * 1024 * 1024
		c.dbPath = dbPath

		if err := c.openDisk(); err != nil {
			log.Error("cache: disk open failed, disabling disk tier", "error", err)
			// Don't fail — just run memory-only
		}
	}

	// Always start background loop — no-ops when disk is nil.
	c.flushWg.Add(1)
	go c.backgroundLoop()

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

	var entry *Entry
	err := db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(cacheBucket))
		if b == nil {
			return nil
		}
		v := b.Get([]byte(key))
		if v == nil {
			return nil
		}
		var de diskEntry
		if err := json.Unmarshal(v, &de); err != nil {
			return err
		}
		entry = &Entry{
			Buffer:      de.Buffer,
			ContentType: de.ContentType,
		}
		return nil
	})
	if err != nil {
		c.log.Warn("cache: bbolt read error", "key", key, "error", err)
		return nil, false
	}
	if entry == nil {
		return nil, false
	}

	// promote to memory
	if c.mem != nil {
		c.mem.Set(key, entry, int64(len(entry.Buffer)))
	}
	return entry, true
}

// Set stores entry under key.  Memory update is synchronous; disk write is
// asynchronous via the write-back buffer.
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

	select {
	case c.pending <- writeReq{key: key, entry: entry}:
	default:
		c.log.Warn("cache: write-back buffer full, dropping disk write")
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

	// Estimate disk usage by file size
	dbPath := c.dbPath
	fi, err := os.Stat(dbPath)
	if err != nil {
		return
	}
	usage := fi.Size()
	if usage <= maxBytes {
		return
	}

	type ei struct {
		key  []byte
		size int64
		ts   int64
	}

	var entries []ei
	err = db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(cacheBucket))
		if b == nil {
			return nil
		}
		return b.ForEach(func(k, v []byte) error {
			var de diskEntry
			if err := json.Unmarshal(v, &de); err != nil {
				return nil // skip malformed entries
			}
			keyCopy := make([]byte, len(k))
			copy(keyCopy, k)
			entries = append(entries, ei{
				key:  keyCopy,
				size: int64(len(v)),
				ts:   de.CreatedAt,
			})
			return nil
		})
	})
	if err != nil {
		c.log.Warn("cache: cleanup scan failed", "error", err)
		return
	}

	// Sort by creation time (oldest first)
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].ts < entries[j].ts
	})

	target := maxBytes * 9 / 10
	var freed int64
	for _, e := range entries {
		if usage-freed <= target {
			break
		}
		err := db.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket([]byte(cacheBucket))
			if b == nil {
				return nil
			}
			return b.Delete(e.key)
		})
		if err != nil {
			c.log.Warn("cache: cleanup delete failed", "error", err)
			continue
		}
		freed += e.size
	}

	if freed > 0 {
		c.log.Info("cache: cleanup done", "freedMB", freed/1024/1024)
	}
}

// Close performs a final flush, then closes disk and memory tiers.
func (c *Cache) Close() {
	select {
	case <-c.done:
	default:
		close(c.done)
	}
	c.flushWg.Wait() // final drainAndFlush completes here

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

// openDisk opens (or creates) the bbolt database and sets c.db.
func (c *Cache) openDisk() error {
	// Ensure parent directory exists
	dir := filepath.Dir(c.dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create cache dir: %w", err)
	}

	db, err := bolt.Open(c.dbPath, 0600, &bolt.Options{
		Timeout:      5 * time.Second,
		FreelistType: bolt.FreelistMapType, // faster freelist
	})
	if err != nil {
		return err
	}

	// Ensure bucket exists
	err = db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists([]byte(cacheBucket))
		return err
	})
	if err != nil {
		db.Close()
		return err
	}

	c.mu.Lock()
	c.db = db
	c.mu.Unlock()
	return nil
}

// ---------------------------------------------------------------------------
// Background loop
// ---------------------------------------------------------------------------

func (c *Cache) backgroundLoop() {
	defer c.flushWg.Done()

	ft := time.NewTicker(flushInterval)
	ct := time.NewTicker(cleanupInterval)
	defer ft.Stop()
	defer ct.Stop()

	for {
		select {
		case <-ft.C:
			c.drainAndFlush()
		case <-ct.C:
			c.Cleanup()
		case <-c.done:
			c.drainAndFlush() // final drain
			return
		}
	}
}

// drainAndFlush drains the pending write-back channel and commits all entries
// in a single bbolt transaction.  Checks db availability BEFORE draining so
// items stay in the channel when db is nil.
func (c *Cache) drainAndFlush() {
	c.mu.RLock()
	db := c.db
	c.mu.RUnlock()
	if db == nil {
		return // don't drain — keep items in channel for later
	}

	// drain all pending entries (non-blocking)
	var batch []writeReq
	for {
		select {
		case req := <-c.pending:
			batch = append(batch, req)
		default:
			goto flush
		}
	}

flush:
	if len(batch) == 0 {
		return
	}

	err := db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(cacheBucket))
		for _, r := range batch {
			de := diskEntry{
				Buffer:      r.entry.Buffer,
				ContentType: r.entry.ContentType,
				CreatedAt:   time.Now().Unix(),
				Size:        int64(len(r.entry.Buffer)),
			}
			data, err := json.Marshal(de)
			if err != nil {
				return err
			}
			if err := b.Put([]byte(r.key), data); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		c.log.Warn("cache: flush failed", "count", len(batch), "error", err)
		return
	}
	c.log.Debug("cache: flushed", "count", len(batch))
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
