package handler

import (
	"container/list"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

const (
	labrastroBlobCacheBytes   = 64 << 20
	labrastroBlobCacheTTL     = 30 * time.Minute
	labrastroBlobCacheEntries = 16384
)

var labrastroPackageBlobs = newLabrastroBlobCache(labrastroBlobCacheBytes, labrastroBlobCacheTTL)

type labrastroBlobKey struct {
	workspace, repository, sha string
}

type labrastroCachedBlob struct {
	key     labrastroBlobKey
	body    []byte
	expires time.Time
}

type labrastroBlobFlight struct {
	done chan struct{}
	body []byte
	err  error
}

// The byte budget covers immutable raw bodies. The entry cap also bounds LRU
// metadata, including empty blobs. Neither refs nor candidate results are cached.
type labrastroBlobCache struct {
	mu       sync.Mutex
	entries  map[labrastroBlobKey]*list.Element
	lru      list.List
	flights  map[labrastroBlobKey]*labrastroBlobFlight
	bytes    int
	maxBytes int
	ttl      time.Duration
	now      func() time.Time
}

func newLabrastroBlobCache(maxBytes int, ttl time.Duration) *labrastroBlobCache {
	return &labrastroBlobCache{entries: make(map[labrastroBlobKey]*list.Element), flights: make(map[labrastroBlobKey]*labrastroBlobFlight), maxBytes: maxBytes, ttl: ttl, now: time.Now}
}

func labrastroGitBlobSHA(body []byte) string {
	h := sha1.New() // Git's blob identity includes its type, length and NUL header.
	fmt.Fprintf(h, "blob %d\x00", len(body))
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil))
}

func (c *labrastroBlobCache) remove(e *list.Element) {
	blob := e.Value.(labrastroCachedBlob)
	delete(c.entries, blob.key)
	c.bytes -= len(blob.body)
	c.lru.Remove(e)
}

// get singleflights a miss without detaching network work from its request.
// Waiters can cancel independently; if the downloading request is canceled,
// all waiters see that failure and a later request can try again. Errors are
// never cached, and callers must treat returned bodies as immutable.
func (c *labrastroBlobCache) get(ctx context.Context, key labrastroBlobKey, download func() ([]byte, error)) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	if e := c.entries[key]; e != nil {
		blob := e.Value.(labrastroCachedBlob)
		if c.now().Before(blob.expires) {
			c.lru.MoveToFront(e)
			c.mu.Unlock()
			return blob.body, nil
		}
		c.remove(e)
	}
	if f := c.flights[key]; f != nil {
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-f.done:
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			return f.body, f.err
		}
	}
	f := &labrastroBlobFlight{done: make(chan struct{})}
	c.flights[key] = f
	c.mu.Unlock()

	f.body, f.err = download()
	if f.err == nil {
		f.err = ctx.Err()
	}
	if f.err == nil && labrastroGitBlobSHA(f.body) != key.sha {
		f.err = fmt.Errorf("source blob hash does not match repository tree")
	}
	if f.err != nil {
		f.body = nil
	}
	c.mu.Lock()
	if f.err == nil && len(f.body) <= c.maxBytes && c.maxBytes > 0 {
		for c.bytes+len(f.body) > c.maxBytes || c.lru.Len() >= labrastroBlobCacheEntries {
			c.remove(c.lru.Back())
		}
		c.entries[key] = c.lru.PushFront(labrastroCachedBlob{key, f.body, c.now().Add(c.ttl)})
		c.bytes += len(f.body)
	}
	delete(c.flights, key)
	close(f.done)
	c.mu.Unlock()
	return f.body, f.err
}
