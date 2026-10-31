package service

import (
	"context"
	"errors"
	"sync"
	"time"
)

const chatSendCacheTTL = 10 * time.Minute
const chatSendCacheLimit = 1024

var ErrChatSendConflict = errors.New("client_message_id was already used for another message")
var ErrChatSendCacheFull = errors.New("chat send idempotency cache is full")

type chatSendEntry struct {
	fingerprint [32]byte
	done        chan struct{}
	result      *DirectChatSendResult
	err         error
	expiresAt   time.Time
}

// ChatSendCache coalesces in-flight requests and retains successful sends for
// short retries. It is process-local: restarts and other replicas do not share
// receipts. The zero value is ready to use. Failed sends are never retained.
type ChatSendCache struct {
	mu      sync.Mutex
	entries map[string]*chatSendEntry
}

func (c *ChatSendCache) Do(ctx context.Context, key string, fingerprint [32]byte, send func() (*DirectChatSendResult, error)) (*DirectChatSendResult, bool, error) {
	if key == "" {
		result, err := send()
		return result, false, err
	}
	c.mu.Lock()
	now := time.Now()
	for k, entry := range c.entries {
		if !entry.expiresAt.IsZero() && !now.Before(entry.expiresAt) {
			delete(c.entries, k)
		}
	}
	if entry := c.entries[key]; entry != nil {
		c.mu.Unlock()
		if entry.fingerprint != fingerprint {
			return nil, false, ErrChatSendConflict
		}
		select {
		case <-ctx.Done():
			return nil, false, ctx.Err()
		case <-entry.done:
			return entry.result, true, entry.err
		}
	}
	// Do not evict live receipts to admit new work: that could run a retry twice.
	if len(c.entries) >= chatSendCacheLimit {
		c.mu.Unlock()
		return nil, false, ErrChatSendCacheFull
	}
	if c.entries == nil {
		c.entries = make(map[string]*chatSendEntry)
	}
	entry := &chatSendEntry{fingerprint: fingerprint, done: make(chan struct{})}
	c.entries[key] = entry
	c.mu.Unlock()

	// Also release waiters if the owner panics; the HTTP recovery middleware
	// handles the panic, and the next request may retry instead of hanging.
	err := errors.New("chat send interrupted")
	var result *DirectChatSendResult
	defer func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		entry.result, entry.err = result, err
		if err != nil {
			delete(c.entries, key)
		} else {
			entry.expiresAt = time.Now().Add(chatSendCacheTTL)
		}
		close(entry.done)
	}()
	result, err = send()
	return result, false, err
}
