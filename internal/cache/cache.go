package cache

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cockroachdb/pebble/v2"
	"github.com/cockroachdb/pebble/v2/bloom"
	"github.com/dgraph-io/ristretto/v2"
)

type Entry struct {
	Buffer      []byte
	ContentType string
}

type writeReq struct {
	key   string
	entry *Entry
}

type Cache struct {
	mem       *ristretto.Cache[string, *Entry]
	db        *pebble.DB
	cacheDir  string
	maxBytes  int64
	log       *slog.Logger
	mu        sync.RWMutex
	rebuildMu sync.Mutex

	// write-back buffer
	pending  chan writeReq
	done     chan struct{}
	flushWg  sync.WaitGroup // waits for flushLoop to exit
}

func New(maxMemoryMB, maxDiskGB int, cacheDir string, log *slog.Logger) (*Cache, error) {
	c := &Cache{
		log:     log,
		pending: make(chan writeReq, 1024),
		done:    make(chan struct{}),
	}

	if maxMemoryMB > 0 {
		mem, err := ristretto.NewCache(&ristretto.Config[string, *Entry]{
			NumCounters: int64(maxMemoryMB * 10),
			MaxCost:     int64(maxMemoryMB) * 1024 * 1024,
			BufferItems: 64,
		})
		if err != nil {
			return nil, fmt.Errorf("create memory cache: %w", err)
		}
		c.mem = mem
	}

	if maxDiskGB > 0 && cacheDir != "" {
		c.maxBytes = int64(maxDiskGB) * 1024 * 1024 * 1024
		c.cacheDir = cacheDir
		db, err := c.openPebble(cacheDir)
		if err != nil {
			c.log.Warn("cache: pebble open failed, attempting targeted recovery", "error", err)

			// Strategy 1: remove only WAL/manifest files, keep SST data
			cleanPebbleMeta(cacheDir)
			db, err = c.openPebble(cacheDir)
			if err != nil {
				c.log.Warn("cache: pebble open failed after meta cleanup, removing entire dir", "error", err)

				// Strategy 2: full cleanup as last resort
				if rmErr := os.RemoveAll(cacheDir); rmErr != nil {
					return nil, fmt.Errorf("remove corrupt pebble dir: %w", rmErr)
				}
				db, err = c.openPebble(cacheDir)
				if err != nil {
					return nil, fmt.Errorf("open pebble after cleanup: %w", err)
				}
				c.log.Info("cache: pebble rebuilt after full cleanup")
			} else {
				c.log.Info("cache: pebble recovered after meta cleanup (SST data preserved)")
			}
		}
		c.db = db
		c.flushWg.Add(1)
		go c.flushLoop()
	}

	return c, nil
}

func (c *Cache) openPebble(dir string) (*pebble.DB, error) {
	return pebble.Open(dir, &pebble.Options{
		FormatMajorVersion: pebble.FormatColumnarBlocks,
		Levels: [7]pebble.LevelOptions{
			{FilterPolicy: bloom.FilterPolicy(10)},
		},
		Logger: pebble.DefaultLogger,
		EventListener: &pebble.EventListener{
			DataCorruption: func(info pebble.DataCorruptionInfo) {
				c.log.Error("pebble: data corruption detected",
					"path", info.Path,
					"details", info.Details)
				go c.triggerRebuild()
			},
		},
	})
}

// cleanPebbleMeta removes only WAL, MANIFEST, and CURRENT files from a Pebble
// directory, preserving SST data files. This allows Pebble to attempt a fresh
// open while keeping the bulk of cached data intact.
func cleanPebbleMeta(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".log") ||
			name == "MANIFEST" || name == "CURRENT" || name == "OPTIONS" {
			os.Remove(filepath.Join(dir, name))
		}
	}
}

// flushLoop periodically drains the pending channel and writes entries
// to Pebble in a single batch, reducing fsync calls from N to 1.
func (c *Cache) flushLoop() {
	defer c.flushWg.Done()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			c.drainAndFlush()
		case <-c.done:
			// Final drain before shutdown
			c.drainAndFlush()
			return
		}
	}
}

func (c *Cache) drainAndFlush() {
	// Drain all pending entries (non-blocking)
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

	c.mu.RLock()
	db := c.db
	c.mu.RUnlock()

	if db == nil {
		return
	}

	// Write all entries in a single Pebble batch = 1 fsync
	pebBatch := db.NewBatch()
	for _, req := range batch {
		data := encodeEntry(req.entry)
		pebBatch.Set([]byte(req.key), data, nil)
	}

	if err := pebBatch.Commit(pebble.Sync); err != nil {
		c.log.Warn("cache: batch flush failed", "count", len(batch), "error", err)
		if corruptionErr(err) {
			c.triggerRebuild()
		}
		return
	}

	c.log.Debug("cache: batch flushed", "count", len(batch))
}

// corruptionErr checks whether a pebble error is a corruption error.
func corruptionErr(err error) bool {
	if err == nil {
		return false
	}
	// pebble marks corruption errors with "pebble: corruption" prefix
	return strings.Contains(err.Error(), "pebble: corruption") ||
		strings.Contains(err.Error(), "checksum mismatch")
}

func (c *Cache) Get(key string) (*Entry, bool) {
	if c.mem != nil {
		if entry, found := c.mem.Get(key); found && entry != nil {
			return entry, true
		}
	}

	c.mu.RLock()
	db := c.db
	c.mu.RUnlock()

	if db != nil {
		val, closer, err := db.Get([]byte(key))
		if err == nil {
			entry, ok := decodeEntry(val)
			closer.Close()
			if ok {
				if c.mem != nil {
					c.mem.Set(key, entry, int64(len(entry.Buffer)))
				}
				return entry, true
			}
		} else if err != pebble.ErrNotFound {
			c.log.Warn("cache: pebble read error", "key", key, "error", err)
			if corruptionErr(err) {
				c.triggerRebuild()
			}
		}
	}

	return nil, false
}

func (c *Cache) Set(key string, entry *Entry) {
	// Always update memory cache immediately (fast path, reads see it instantly)
	if c.mem != nil {
		c.mem.Set(key, entry, int64(len(entry.Buffer)))
	}

	// Enqueue for batch write to disk (non-blocking)
	if c.db != nil {
		select {
		case c.pending <- writeReq{key: key, entry: entry}:
		default:
			// Channel full — drop disk write, memory cache still has it
			c.log.Warn("cache: write-back buffer full, dropping disk write")
		}
	}
}

func (c *Cache) Cleanup() {
	c.mu.RLock()
	db := c.db
	maxBytes := c.maxBytes
	c.mu.RUnlock()

	if db == nil || maxBytes <= 0 {
		return
	}

	usage := db.Metrics().DiskSpaceUsage()
	if usage <= uint64(maxBytes) {
		return
	}

	type entryInfo struct {
		key       []byte
		size      int64
		timestamp int64
	}

	var entries []entryInfo
	iter, err := db.NewIter(&pebble.IterOptions{
		LowerBound: []byte{0},
		UpperBound: []byte{0xff},
	})
	if err != nil {
		c.log.Warn("cache: create iterator failed", "error", err)
		return
	}
	defer iter.Close()

	for iter.First(); iter.Valid(); iter.Next() {
		val := iter.Value()
		ts, ok := decodeTimestamp(val)
		if !ok {
			continue
		}
		key := make([]byte, len(iter.Key()))
		copy(key, iter.Key())
		entries = append(entries, entryInfo{
			key:       key,
			size:      int64(len(val)),
			timestamp: ts,
		})
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].timestamp < entries[j].timestamp
	})

	targetBytes := maxBytes * 9 / 10 // reclaim to 90%
	var freed int64
	for _, e := range entries {
		if usage-uint64(freed) <= uint64(targetBytes) {
			break
		}
		if err := db.Delete(e.key, pebble.Sync); err != nil {
			c.log.Warn("cache: cleanup delete failed", "error", err)
			if corruptionErr(err) {
				c.triggerRebuild()
				return
			}
			continue
		}
		freed += e.size
	}

	if freed > 0 {
		c.log.Info("cache: cleanup completed", "freedMB", freed/1024/1024)
		if err := db.Compact(context.Background(), []byte{0}, []byte{0xff}, true); err != nil {
			c.log.Warn("cache: cleanup compact failed", "error", err)
			if corruptionErr(err) {
				c.triggerRebuild()
			}
		}
	}
}

func (c *Cache) Close() {
	// Signal flush goroutine to stop and wait for it to finish
	select {
	case <-c.done:
	default:
		close(c.done)
	}
	c.flushWg.Wait() // ensures final drain completes before we touch db

	if c.mem != nil {
		c.mem.Close()
	}
	c.mu.Lock()
	db := c.db
	c.db = nil
	c.mu.Unlock()

	if db != nil {
		if err := db.Flush(); err != nil {
			c.log.Warn("cache: pebble flush failed", "error", err)
		}
		if err := db.Close(); err != nil {
			c.log.Warn("cache: pebble close failed", "error", err)
		}
	}
}

func (c *Cache) triggerRebuild() {
	if c.cacheDir == "" {
		return
	}
	c.rebuildMu.Lock()
	defer c.rebuildMu.Unlock()

	// Double-check: another goroutine may have already rebuilt
	c.mu.RLock()
	db := c.db
	c.mu.RUnlock()
	if db == nil {
		return // already rebuilding or rebuilt
	}

	c.log.Warn("cache: triggering rebuild due to corruption", "dir", c.cacheDir)

	// Drain pending writes — they target the corrupted DB, discard them
	drained := 0
	for {
		select {
		case <-c.pending:
			drained++
		default:
			goto rebuild
		}
	}

rebuild:
	if drained > 0 {
		c.log.Warn("cache: discarded pending writes during rebuild", "count", drained)
	}

	c.mu.Lock()
	oldDB := c.db
	c.db = nil
	c.mu.Unlock()

	if oldDB != nil {
		// Corruption-tolerant close: log but don't block on failure.
		// A corrupted DB's Close() can hang or fail; we don't need it
		// to succeed since we're about to RemoveAll the directory.
		done := make(chan error, 1)
		go func() { done <- oldDB.Close() }()
		select {
		case err := <-done:
			if err != nil {
				c.log.Warn("cache: old db close error (non-fatal)", "error", err)
			}
		case <-time.After(5 * time.Second):
			c.log.Warn("cache: old db close timed out, proceeding with rebuild")
		}
	}

	// Strategy 1: remove only WAL/manifest, keep SST data
	cleanPebbleMeta(c.cacheDir)
	db2, err := c.openPebble(c.cacheDir)
	if err != nil {
		c.log.Warn("cache: pebble open failed after meta cleanup, removing entire dir", "error", err)

		// Strategy 2: full cleanup as last resort
		if err := os.RemoveAll(c.cacheDir); err != nil {
			c.log.Error("cache: failed to remove corrupt dir", "error", err)
			return
		}
		db2, err = c.openPebble(c.cacheDir)
		if err != nil {
			c.log.Error("cache: failed to reopen pebble after rebuild", "error", err)
			return
		}
		c.log.Info("cache: pebble rebuilt after full cleanup")
	} else {
		c.log.Info("cache: pebble recovered after meta cleanup (SST data preserved)")
	}
	c.mu.Lock()
	c.db = db2
	c.mu.Unlock()
	c.log.Info("cache: pebble rebuilt successfully")
}

// encodeEntry serializes an Entry to binary format:
// [4 bytes: uint32 buffer length][N bytes: buffer][8 bytes: int64 unix timestamp][remaining: contentType]
func encodeEntry(entry *Entry) []byte {
	ctBytes := []byte(entry.ContentType)
	buf := make([]byte, 4+len(entry.Buffer)+8+len(ctBytes))
	binary.LittleEndian.PutUint32(buf[0:4], uint32(len(entry.Buffer)))
	copy(buf[4:], entry.Buffer)
	binary.LittleEndian.PutUint64(buf[4+len(entry.Buffer):], uint64(time.Now().Unix()))
	copy(buf[4+len(entry.Buffer)+8:], ctBytes)
	return buf
}

// decodeEntry deserializes an Entry from binary format.
func decodeEntry(data []byte) (*Entry, bool) {
	if len(data) < 12 { // 4 + 8 minimum
		return nil, false
	}
	bufLen := binary.LittleEndian.Uint32(data[0:4])
	if len(data) < int(4+bufLen+8) {
		return nil, false
	}
	buffer := make([]byte, bufLen)
	copy(buffer, data[4:4+bufLen])
	ctStart := 4 + bufLen + 8
	contentType := string(data[ctStart:])
	return &Entry{Buffer: buffer, ContentType: contentType}, true
}

// decodeTimestamp extracts the unix timestamp from an encoded entry.
func decodeTimestamp(data []byte) (int64, bool) {
	if len(data) < 12 {
		return 0, false
	}
	bufLen := binary.LittleEndian.Uint32(data[0:4])
	if len(data) < int(4+bufLen+8) {
		return 0, false
	}
	ts := int64(binary.LittleEndian.Uint64(data[4+bufLen : 4+bufLen+8]))
	return ts, true
}

func BuildCacheKey(keyType, url string, params ...string) string {
	urlHash := sha256Hex(url)

	switch keyType {
	case "source":
		return "source:" + urlHash
	case "meta":
		return "meta:" + urlHash
	case "processed":
		paramStr := ""
		for i, p := range params {
			if i > 0 {
				paramStr += "|"
			}
			paramStr += p
		}
		paramHash := sha256Hex(paramStr)[:16]
		return "processed:" + urlHash + "_" + paramHash
	default:
		return keyType + ":" + urlHash
	}
}

func sha256Hex(data string) string {
	h := sha256.Sum256([]byte(data))
	return hex.EncodeToString(h[:])
}
