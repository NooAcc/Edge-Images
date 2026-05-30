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
	"sync/atomic"
	"time"

	"github.com/cockroachdb/pebble/v2"
	"github.com/cockroachdb/pebble/v2/bloom"
	"github.com/dgraph-io/ristretto/v2"
)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const (
	pendingBufSize   = 1024              // write-back channel capacity
	flushInterval    = 5 * time.Second   // drain-and-flush period
	cleanupInterval  = 10 * time.Minute  // disk-usage check period
	rebuildWindow    = 2 * time.Minute   // circuit-breaker sliding window
	maxRebuildsInWin = 5                 // max rebuilds before disabling disk
	entryVersion     = byte(1)           // binary encoding version tag
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Entry holds a cached response body and its MIME type.
type Entry struct {
	Buffer      []byte
	ContentType string
}

type writeReq struct {
	key   string
	entry *Entry
}

// Cache is a two-tier (memory + disk) write-back cache.
// Memory tier: Ristretto (TinyLFU).  Disk tier: PebbleDB (LSM).
type Cache struct {
	mem      *ristretto.Cache[string, *Entry]
	db       *pebble.DB
	cacheDir string
	maxBytes int64
	log      *slog.Logger
	mu       sync.RWMutex // guards db pointer

	// write-back buffer
	pending chan writeReq
	done    chan struct{}
	flushWg sync.WaitGroup

	// rebuild coordination
	rebuildMu    sync.Mutex
	rebuildTimes []time.Time   // timestamps of recent rebuilds
	diskDisabled atomic.Bool   // permanently disables disk tier

	// corruption tracking — full path of the last corrupted file reported by
	// Pebble (EventListener) or parsed from a Get error.  Used by targeted
	// recovery to remove only the bad SST instead of wiping everything.
	corruptedPath atomic.Value // string
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

// New creates a Cache.  Memory tier is created when maxMemoryMB > 0.
// Disk tier is created when maxDiskGB > 0 and cacheDir is non-empty.
// On disk-open failure the directory is wiped and retried once; if that also
// fails the disk tier is silently disabled and the cache runs memory-only.
func New(maxMemoryMB, maxDiskGB int, cacheDir string, log *slog.Logger) (*Cache, error) {
	c := &Cache{
		log:     log,
		pending: make(chan writeReq, pendingBufSize),
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
	if maxDiskGB > 0 && cacheDir != "" {
		c.maxBytes = int64(maxDiskGB) * 1024 * 1024 * 1024
		c.cacheDir = cacheDir

		if err := c.openDisk(); err != nil {
			log.Warn("cache: disk open failed, wiping and retrying", "error", err)
			os.RemoveAll(cacheDir)
			if err := c.openDisk(); err != nil {
				log.Error("cache: disk open failed after wipe, disabling disk tier", "error", err)
				c.diskDisabled.Store(true)
			}
		}
	}

	// Always start background loop — no-ops when disk is nil.
	c.flushWg.Add(1)
	go c.backgroundLoop()

	log.Info("cache: initialized",
		"memoryMB", maxMemoryMB,
		"diskGB", maxDiskGB,
		"diskEnabled", !c.diskDisabled.Load())

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

	val, closer, err := db.Get([]byte(key))
	if err != nil {
		if err != pebble.ErrNotFound {
			c.log.Warn("cache: pebble read error", "key", key, "error", err)
			if corruptionErr(err) {
				// Parse corrupted SST path from the error message so targeted
				// recovery knows which file to remove.
				if p := parseCorruptedPath(err.Error(), c.cacheDir); p != "" {
					c.corruptedPath.Store(p)
				}
				go c.rebuildDisk()
			}
		}
		return nil, false
	}
	defer closer.Close()

	entry, ok := decodeEntry(val)
	if !ok {
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
// limit, reclaiming down to 90 %.
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

	type ei struct {
		key  []byte
		size int64
		ts   int64
	}

	var entries []ei
	iter, err := db.NewIter(&pebble.IterOptions{
		LowerBound: []byte{0},
		UpperBound: []byte{0xff},
	})
	if err != nil {
		c.log.Warn("cache: cleanup iter failed", "error", err)
		return
	}
	defer iter.Close()

	for iter.First(); iter.Valid(); iter.Next() {
		v := iter.Value()
		ts, ok := decodeTimestamp(v)
		if !ok {
			continue
		}
		k := make([]byte, len(iter.Key()))
		copy(k, iter.Key())
		entries = append(entries, ei{key: k, size: int64(len(v)), ts: ts})
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].ts < entries[j].ts })

	target := maxBytes * 9 / 10
	var freed int64
	for _, e := range entries {
		if usage-uint64(freed) <= uint64(target) {
			break
		}
		if err := db.Delete(e.key, pebble.Sync); err != nil {
			c.log.Warn("cache: cleanup delete failed", "error", err)
			if corruptionErr(err) {
				if p := parseCorruptedPath(err.Error(), c.cacheDir); p != "" {
					c.corruptedPath.Store(p)
				}
				go c.rebuildDisk()
				return
			}
			continue
		}
		freed += e.size
	}

	if freed > 0 {
		c.log.Info("cache: cleanup done", "freedMB", freed/1024/1024)
		if err := db.Compact(context.Background(), []byte{0}, []byte{0xff}, true); err != nil {
			c.log.Warn("cache: cleanup compact failed", "error", err)
			if corruptionErr(err) {
				go c.rebuildDisk()
			}
		}
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
		if err := db.Flush(); err != nil {
			c.log.Warn("cache: db flush failed", "error", err)
		}
		if err := db.Close(); err != nil {
			c.log.Warn("cache: db close failed", "error", err)
		}
	}
}

// ---------------------------------------------------------------------------
// Disk management
// ---------------------------------------------------------------------------

// openDisk opens (or creates) the PebbleDB directory and sets c.db.
func (c *Cache) openDisk() error {
	db, err := pebble.Open(c.cacheDir, &pebble.Options{
		FormatMajorVersion: pebble.FormatColumnarBlocks,
		Levels: [7]pebble.LevelOptions{
			{FilterPolicy: bloom.FilterPolicy(10)},
		},
		Logger: pebble.DefaultLogger,
		EventListener: &pebble.EventListener{
			DataCorruption: func(info pebble.DataCorruptionInfo) {
				c.log.Error("pebble: corruption detected",
					"path", info.Path, "details", info.Details)
				// Store the exact corrupted file path for targeted recovery.
				if info.Path != "" {
					c.corruptedPath.Store(info.Path)
				}
				go c.rebuildDisk()
			},
		},
	})
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.db = db
	c.mu.Unlock()
	return nil
}

// closeDisk nils and closes c.db.  Safe to call when already nil.
func (c *Cache) closeDisk() {
	c.mu.Lock()
	db := c.db
	c.db = nil
	c.mu.Unlock()

	if db == nil {
		return
	}
	done := make(chan error, 1)
	go func() { done <- db.Close() }()
	select {
	case err := <-done:
		if err != nil {
			c.log.Warn("cache: close error (non-fatal)", "error", err)
		}
	case <-time.After(5 * time.Second):
		c.log.Warn("cache: close timed out, proceeding")
	}
}

// rebuildDisk repairs the disk cache after corruption.  Recovery is attempted
// in two tiers:
//
//  1. Targeted: remove only the corrupted SST file + Pebble meta files
//     (MANIFEST, CURRENT, OPTIONS, WAL).  All other SSTs are preserved.
//  2. Full wipe: remove the entire directory (last resort).
//
// If both fail, scheduleReopen retries with exponential backoff.
func (c *Cache) rebuildDisk() {
	if c.diskDisabled.Load() {
		return
	}

	c.rebuildMu.Lock()
	defer c.rebuildMu.Unlock()

	// ---- circuit breaker ----
	now := time.Now()
	c.rebuildTimes = append(c.rebuildTimes, now)
	cutoff := now.Add(-rebuildWindow)
	keep := c.rebuildTimes[:0]
	for _, t := range c.rebuildTimes {
		if t.After(cutoff) {
			keep = append(keep, t)
		}
	}
	c.rebuildTimes = keep
	if len(keep) >= maxRebuildsInWin {
		c.log.Error("cache: rebuild circuit breaker tripped, disabling disk",
			"count", len(keep), "window", rebuildWindow)
		c.closeDisk()
		c.diskDisabled.Store(true)
		return
	}

	// double-check: already nil?
	c.mu.RLock()
	db := c.db
	c.mu.RUnlock()
	if db == nil {
		return
	}

	// ---- tier 1: targeted recovery (preserve valid SSTs) ----
	if c.tryTargetedRecovery() {
		return
	}

	// ---- tier 2: full wipe ----
	c.log.Warn("cache: targeted recovery failed, doing full wipe")
	c.closeDisk()
	if err := os.RemoveAll(c.cacheDir); err != nil {
		c.log.Error("cache: remove dir failed", "error", err)
		c.scheduleReopen()
		return
	}
	if err := c.openDisk(); err != nil {
		c.log.Error("cache: reopen after full wipe failed", "error", err)
		c.scheduleReopen()
		return
	}
	c.log.Info("cache: recovered (full wipe)")
}

// tryTargetedRecovery removes only the corrupted SST and Pebble meta files,
// preserving all other SST data.  Returns true if Pebble reopens successfully.
func (c *Cache) tryTargetedRecovery() bool {
	// 1. Close current db
	c.closeDisk()

	// 2. Remove the specific corrupted SST file (if known)
	if v := c.corruptedPath.Load(); v != nil {
		corrupted := v.(string)
		if err := os.Remove(corrupted); err != nil {
			if !os.IsNotExist(err) {
				c.log.Warn("cache: failed to remove corrupted file",
					"path", corrupted, "error", err)
			}
		} else {
			c.log.Info("cache: removed corrupted file", "path", corrupted)
		}
	}

	// 3. Remove meta files (MANIFEST, CURRENT, OPTIONS, WAL) so Pebble
	//    rebuilds its state from the remaining SSTs.
	c.cleanMetaFiles()

	// 4. Try to reopen
	if err := c.openDisk(); err != nil {
		c.log.Warn("cache: targeted recovery open failed", "error", err)
		return false
	}

	c.log.Info("cache: recovered (targeted SST removal)")
	return true
}

// cleanMetaFiles removes Pebble meta files (MANIFEST, CURRENT, OPTIONS) and
// WAL files from cacheDir, but leaves SST data files untouched.
func (c *Cache) cleanMetaFiles() {
	entries, err := os.ReadDir(c.cacheDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		path := filepath.Join(c.cacheDir, name)
		if strings.HasSuffix(name, ".log") ||
			name == "MANIFEST" || name == "CURRENT" || name == "OPTIONS" {
			os.Remove(path) // best-effort
		}
	}
}

// scheduleReopen retries openDisk with exponential backoff.  Each attempt
// wipes the directory first to guarantee a clean slate.  Runs in its own
// goroutine.
func (c *Cache) scheduleReopen() {
	go func() {
		for attempt := 1; attempt <= 10; attempt++ {
			delay := time.Duration(attempt*5) * time.Second
			c.log.Info("cache: reopen scheduled", "attempt", attempt, "delay", delay)
			time.Sleep(delay)

			if c.diskDisabled.Load() {
				return
			}
			c.mu.RLock()
			db := c.db
			c.mu.RUnlock()
			if db != nil {
				return // recovered by another goroutine
			}

			os.RemoveAll(c.cacheDir) // clean slate, ignore error
			if err := c.openDisk(); err != nil {
				c.log.Warn("cache: reopen failed", "attempt", attempt, "error", err)
				continue
			}
			c.log.Info("cache: disk reopened", "attempt", attempt)
			return
		}

		c.log.Error("cache: reopen exhausted after 10 attempts, disabling disk")
		c.diskDisabled.Store(true)
	}()
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
// in a single Pebble batch (one fsync).  Checks db availability BEFORE
// draining so items stay in the channel when db is nil (e.g. during rebuild).
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

	pebBatch := db.NewBatch()
	for _, r := range batch {
		pebBatch.Set([]byte(r.key), encodeEntry(r.entry), nil)
	}
	if err := pebBatch.Commit(pebble.Sync); err != nil {
		c.log.Warn("cache: flush failed", "count", len(batch), "error", err)
		if corruptionErr(err) {
			go c.rebuildDisk()
		}
		return
	}
	c.log.Debug("cache: flushed", "count", len(batch))
}

// ---------------------------------------------------------------------------
// Binary encoding
//
// Format: [1B version][4B buf-len LE][NB buffer][8B unix-ts LE][NB content-type]
// ---------------------------------------------------------------------------

func encodeEntry(e *Entry) []byte {
	ct := []byte(e.ContentType)
	buf := make([]byte, 1+4+len(e.Buffer)+8+len(ct))
	buf[0] = entryVersion
	binary.LittleEndian.PutUint32(buf[1:5], uint32(len(e.Buffer)))
	copy(buf[5:], e.Buffer)
	binary.LittleEndian.PutUint64(buf[5+len(e.Buffer):], uint64(time.Now().Unix()))
	copy(buf[5+len(e.Buffer)+8:], ct)
	return buf
}

func decodeEntry(data []byte) (*Entry, bool) {
	if len(data) < 13 || data[0] != entryVersion { // 1+4+8 min
		return nil, false
	}
	n := binary.LittleEndian.Uint32(data[1:5])
	if len(data) < int(5+n+8) {
		return nil, false
	}
	buf := make([]byte, n)
	copy(buf, data[5:5+n])
	ct := string(data[5+n+8:])
	return &Entry{Buffer: buf, ContentType: ct}, true
}

func decodeTimestamp(data []byte) (int64, bool) {
	if len(data) < 13 || data[0] != entryVersion {
		return 0, false
	}
	n := binary.LittleEndian.Uint32(data[1:5])
	if len(data) < int(5+n+8) {
		return 0, false
	}
	return int64(binary.LittleEndian.Uint64(data[5+n : 5+n+8])), true
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func corruptionErr(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "pebble: corruption") ||
		strings.Contains(s, "checksum mismatch") ||
		strings.Contains(s, "file is not a table")
}

// parseCorruptedPath extracts the corrupted SST file path from a Pebble error
// message.  Typical format:
//
//	"pebble: file 000015: block 0/22989: crc32c checksum mismatch ..."
//
// Returns the full path (<cacheDir>/000015.sst) or "" if unparseable.
func parseCorruptedPath(errMsg string, cacheDir string) string {
	const prefix = "pebble: file "
	idx := strings.Index(errMsg, prefix)
	if idx < 0 {
		return ""
	}
	rest := errMsg[idx+len(prefix):]
	colonIdx := strings.Index(rest, ":")
	if colonIdx <= 0 {
		return ""
	}
	fileNum := rest[:colonIdx]
	return filepath.Join(cacheDir, fileNum+".sst")
}
