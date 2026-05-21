package cache

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/cockroachdb/pebble"
	"github.com/cockroachdb/pebble/bloom"
	"github.com/dgraph-io/ristretto/v2"
)

type Entry struct {
	Buffer      []byte
	ContentType string
}

type Cache struct {
	mem      *ristretto.Cache[string, *Entry]
	db       *pebble.DB
	maxBytes int64
	log      *slog.Logger
}

func New(maxMemoryMB, maxDiskGB int, cacheDir string, log *slog.Logger) (*Cache, error) {
	c := &Cache{
		log: log,
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
		db, err := pebble.Open(cacheDir, &pebble.Options{
			DisableWAL: true,
			Levels: []pebble.LevelOptions{
				{FilterPolicy: bloom.FilterPolicy(10)},
			},
			Logger: pebble.DefaultLogger,
		})
		if err != nil {
			return nil, fmt.Errorf("open pebble: %w", err)
		}
		c.db = db
	}

	return c, nil
}

func (c *Cache) Get(key string) (*Entry, bool) {
	if c.mem != nil {
		if entry, found := c.mem.Get(key); found && entry != nil {
			return entry, true
		}
	}

	if c.db != nil {
		val, closer, err := c.db.Get([]byte(key))
		if err == nil {
			entry, ok := decodeEntry(val)
			closer.Close()
			if ok {
				if c.mem != nil {
					c.mem.Set(key, entry, int64(len(entry.Buffer)))
				}
				return entry, true
			}
		}
	}

	return nil, false
}

func (c *Cache) Set(key string, entry *Entry) {
	if c.db != nil {
		data := encodeEntry(entry)
		if err := c.db.Set([]byte(key), data, pebble.NoSync); err != nil {
			c.log.Warn("cache: pebble write failed", "error", err)
			return
		}
	}

	if c.mem != nil {
		c.mem.Set(key, entry, int64(len(entry.Buffer)))
	}
}

func (c *Cache) Cleanup() {
	if c.db == nil || c.maxBytes <= 0 {
		return
	}

	usage := c.db.Metrics().DiskSpaceUsage()
	if usage <= uint64(c.maxBytes) {
		return
	}

	type entryInfo struct {
		key       []byte
		size      int64
		timestamp int64
	}

	var entries []entryInfo
	iter := c.db.NewIter(&pebble.IterOptions{
		LowerBound: []byte{0},
		UpperBound: []byte{0xff},
	})
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

	targetBytes := c.maxBytes * 9 / 10 // reclaim to 90%
	var freed int64
	for _, e := range entries {
		if usage-uint64(freed) <= uint64(targetBytes) {
			break
		}
		if err := c.db.Delete(e.key, pebble.NoSync); err != nil {
			c.log.Warn("cache: cleanup delete failed", "error", err)
			continue
		}
		freed += e.size
	}

	if freed > 0 {
		c.log.Info("cache: cleanup completed", "freedMB", freed/1024/1024)
		c.db.Compact([]byte{0}, []byte{0xff}, true)
	}
}

func (c *Cache) Close() {
	if c.mem != nil {
		c.mem.Close()
	}
	if c.db != nil {
		c.db.Close()
	}
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
