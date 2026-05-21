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
	"time"

	"github.com/dgraph-io/ristretto/v2"
	bolt "go.etcd.io/bbolt"
)

var bucketName = []byte("cache")

type Entry struct {
	Buffer      []byte            `json:"b"`
	ContentType string            `json:"ct"`
	Header      map[string]string `json:"h,omitempty"`
}

type Cache struct {
	mem  *ristretto.Cache[string, *Entry]
	db   *bolt.DB
	path string
	log  *slog.Logger
}

func New(maxMemoryMB, maxDiskGB int, cacheDir string, log *slog.Logger) (*Cache, error) {
	c := &Cache{
		path: cacheDir,
		log:  log,
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
		if err := os.MkdirAll(cacheDir, 0o755); err != nil {
			log.Warn("cache: disk dir creation failed, disk cache disabled", "error", err)
		} else {
			dbPath := filepath.Join(cacheDir, "cache.db")
			db, err := bolt.Open(dbPath, 0o600, &bolt.Options{Timeout: 2 * time.Second})
			if err != nil {
				log.Warn("cache: bolt open failed, disk cache disabled", "error", err)
			} else {
				c.db = db
				db.Update(func(tx *bolt.Tx) error {
					_, err := tx.CreateBucketIfNotExists(bucketName)
					return err
				})
			}
		}
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
		var entry *Entry
		err := c.db.View(func(tx *bolt.Tx) error {
			b := tx.Bucket(bucketName)
			if b == nil {
				return nil
			}
			data := b.Get([]byte(key))
			if data == nil {
				return nil
			}
			entry = &Entry{}
			return json.Unmarshal(data, entry)
		})
		if err == nil && entry != nil {
			if c.mem != nil {
				c.mem.Set(key, entry, int64(len(entry.Buffer)))
			}
			return entry, true
		}
	}

	return nil, false
}

func (c *Cache) Set(key string, entry *Entry) {
	if c.db != nil {
		data, err := json.Marshal(entry)
		if err != nil {
			c.log.Warn("cache: marshal failed", "error", err)
			return
		}
		err = c.db.Update(func(tx *bolt.Tx) error {
			b, err := tx.CreateBucketIfNotExists(bucketName)
			if err != nil {
				return err
			}
			return b.Put([]byte(key), data)
		})
		if err != nil {
			c.log.Warn("cache: disk write failed", "error", err)
			return
		}
	}

	if c.mem != nil {
		c.mem.Set(key, entry, int64(len(entry.Buffer)))
	}
}

func (c *Cache) Cleanup(maxDiskGB int) {
	if c.db == nil || maxDiskGB <= 0 {
		return
	}

	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			c.cleanupOnce(maxDiskGB)
		}
	}()
}

func (c *Cache) cleanupOnce(maxDiskGB int) {
	entries, err := os.ReadDir(c.path)
	if err != nil {
		return
	}

	type fileInfo struct {
		path    string
		size    int64
		modTime time.Time
	}

	var files []fileInfo
	var totalSize int64

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, fileInfo{
			path:    filepath.Join(c.path, entry.Name()),
			size:    info.Size(),
			modTime: info.ModTime(),
		})
		totalSize += info.Size()
	}

	maxBytes := int64(maxDiskGB) * 1024 * 1024 * 1024
	if totalSize <= maxBytes {
		return
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].modTime.Before(files[j].modTime)
	})

	for _, f := range files {
		if totalSize <= maxBytes {
			break
		}
		os.Remove(f.path)
		totalSize -= f.size
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
