package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestChatSendCacheConcurrentReplay(t *testing.T) {
	var cache ChatSendCache
	var calls atomic.Int32
	result := &DirectChatSendResult{}
	entered, release := make(chan struct{}), make(chan struct{})
	send := func() (*DirectChatSendResult, error) {
		calls.Add(1)
		close(entered)
		<-release
		return result, nil
	}
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, _, err := cache.Do(context.Background(), "session:key", [32]byte{1}, send)
			if err != nil || got != result {
				t.Errorf("replay = %p, %v; want %p", got, err, result)
			}
		}()
	}
	<-entered
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("created %d turns, want 1", calls.Load())
	}
	if _, replayed, err := cache.Do(context.Background(), "session:key", [32]byte{1}, send); !replayed || err != nil {
		t.Fatalf("completed replay = %v, %v", replayed, err)
	}
}

func TestChatSendCacheScopeConflictFailureAndExpiry(t *testing.T) {
	var cache ChatSendCache
	calls := 0
	send := func() (*DirectChatSendResult, error) { calls++; return &DirectChatSendResult{}, nil }
	ctx := context.Background()
	cache.Do(ctx, "one:key", [32]byte{1}, send)
	if _, _, err := cache.Do(ctx, "one:key", [32]byte{2}, send); !errors.Is(err, ErrChatSendConflict) {
		t.Fatalf("changed payload accepted: %v", err)
	}
	cache.Do(ctx, "two:key", [32]byte{1}, send)
	cache.Do(ctx, "one:other-key", [32]byte{1}, send)
	cache.Do(ctx, "", [32]byte{1}, send)
	cache.Do(ctx, "", [32]byte{1}, send)
	if calls != 5 {
		t.Fatalf("different sessions/keys and legacy sends must create turns: %d", calls)
	}
	wantErr := errors.New("transaction rolled back")
	cache.Do(ctx, "failed", [32]byte{}, func() (*DirectChatSendResult, error) { return nil, wantErr })
	if _, replayed, err := cache.Do(ctx, "failed", [32]byte{}, send); replayed || err != nil {
		t.Fatalf("failed send was cached: %v, %v", replayed, err)
	}
	cache.entries["one:key"].expiresAt = time.Now().Add(-time.Second)
	if _, replayed, err := cache.Do(ctx, "one:key", [32]byte{1}, send); replayed || err != nil {
		t.Fatalf("expired receipt was cached: %v, %v", replayed, err)
	}
}

func TestChatSendCacheCancelledWaiterAndCapacity(t *testing.T) {
	var cache ChatSendCache
	entered, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(finished)
		cache.Do(context.Background(), "pending", [32]byte{}, func() (*DirectChatSendResult, error) {
			close(entered)
			<-release
			return &DirectChatSendResult{}, nil
		})
	}()
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := cache.Do(ctx, "pending", [32]byte{}, nil); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled waiter = %v", err)
	}
	close(release)
	<-finished
	for i := 1; i < chatSendCacheLimit; i++ {
		cache.entries[fmt.Sprint(i)] = cache.entries["pending"]
	}
	if _, _, err := cache.Do(context.Background(), "overflow", [32]byte{}, nil); !errors.Is(err, ErrChatSendCacheFull) {
		t.Fatalf("capacity limit = %v", err)
	}
	if _, replayed, err := cache.Do(context.Background(), "pending", [32]byte{}, nil); !replayed || err != nil {
		t.Fatalf("full cache lost existing receipt: %v, %v", replayed, err)
	}
}
