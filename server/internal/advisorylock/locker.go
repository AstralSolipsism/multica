// Package advisorylock hands out per-workspace advisory locks keyed under a
// caller-chosen key space. The mechanics come from the seat-capacity locker:
// same-process callers queue in Go without pinning a connection, the number
// of pinned connections stays bounded well below the pool, PostgreSQL is
// polled with pg_try_advisory_lock so locks stay coordinated across replicas,
// and a session whose explicit unlock fails is closed instead of returned to
// the pool — an advisory lock is session-scoped and would otherwise leak to
// the next borrower.
package advisorylock

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const lockReleaseTimeout = 3 * time.Second
const defaultCooldown = 75 * time.Millisecond
const lockPollInterval = 25 * time.Millisecond
const maxLockConnections = 4
const lockPoolFraction = 4

type Locker struct {
	pool     *pgxpool.Pool
	keySpace string

	mu         sync.Mutex
	localLocks map[uuid.UUID]*localLock
	// slots bounds the connections this locker pins so its holders cannot
	// consume the primary pool: new callers wait here without a DB
	// connection, using at most one quarter of the pool and never more
	// than 4.
	slots chan struct{}
}

type localLock struct {
	gate chan struct{}
	refs int
}

// New returns a locker for pool whose keys live under keySpace; two lockers
// with different key spaces never block each other. A nil pool yields a nil
// Locker: a router built without a pool has nothing to fence.
func New(pool *pgxpool.Pool, keySpace string) *Locker {
	if pool == nil {
		return nil
	}
	slotCount := int(pool.Config().MaxConns / lockPoolFraction)
	if slotCount < 1 {
		slotCount = 1
	}
	if slotCount > maxLockConnections {
		slotCount = maxLockConnections
	}
	return &Locker{
		pool:       pool,
		keySpace:   keySpace,
		localLocks: make(map[uuid.UUID]*localLock),
		slots:      make(chan struct{}, slotCount),
	}
}

// Lock pins a PostgreSQL session holding the advisory lock for workspaceID
// under the locker's key space, and returns it with its release function.
// The key comes from the parsed UUID, so every spelling of the same
// workspace id shares one lock.
func (l *Locker) Lock(ctx context.Context, workspaceID uuid.UUID) (*pgxpool.Conn, func(), error) {
	releaseLocal, err := l.acquireLocal(ctx, workspaceID)
	if err != nil {
		return nil, nil, fmt.Errorf("queue workspace lock: %w", err)
	}
	select {
	case l.slots <- struct{}{}:
	case <-ctx.Done():
		releaseLocal()
		return nil, nil, fmt.Errorf("queue workspace lock connection: %w", ctx.Err())
	}
	acquired := false
	defer func() {
		if !acquired {
			<-l.slots
			releaseLocal()
		}
	}()

	key := l.key(workspaceID)
	var conn *pgxpool.Conn
	for {
		conn, err = l.pool.Acquire(ctx)
		if err != nil {
			return nil, nil, fmt.Errorf("acquire workspace lock connection: %w", err)
		}
		var locked bool
		if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&locked); err != nil {
			conn.Release()
			return nil, nil, fmt.Errorf("try workspace lock: %w", err)
		}
		if locked {
			break
		}
		conn.Release()
		conn = nil
		timer := time.NewTimer(lockPollInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil, nil, fmt.Errorf("wait for workspace lock: %w", ctx.Err())
		case <-timer.C:
		}
	}
	acquired = true
	var once sync.Once
	return conn, func() {
		once.Do(func() {
			defer releaseLocal()
			defer func() { <-l.slots }()
			timer := time.NewTimer(defaultCooldown)
			<-timer.C
			unlockCtx, cancel := context.WithTimeout(context.Background(), lockReleaseTimeout)
			defer cancel()
			var unlocked bool
			err := conn.QueryRow(unlockCtx, `SELECT pg_advisory_unlock($1)`, key).Scan(&unlocked)
			if err != nil || !unlocked {
				// A session-level lock must never return to the pool if explicit
				// unlock failed. Closing the hijacked connection releases it in
				// PostgreSQL and keeps the next pool borrower isolated.
				_ = conn.Hijack().Close(unlockCtx)
				return
			}
			conn.Release()
		})
	}, nil
}

// acquireLocal makes same-process callers wait in Go instead of each pinning
// one pool connection while another request owns the workspace lock. One
// caller per process polls PostgreSQL so locks remain coordinated across pods.
func (l *Locker) acquireLocal(ctx context.Context, workspaceID uuid.UUID) (func(), error) {
	l.mu.Lock()
	local := l.localLocks[workspaceID]
	if local == nil {
		local = &localLock{gate: make(chan struct{}, 1)}
		local.gate <- struct{}{}
		l.localLocks[workspaceID] = local
	}
	local.refs++
	l.mu.Unlock()

	select {
	case <-ctx.Done():
		l.dropLocalRef(workspaceID, local)
		return nil, ctx.Err()
	case <-local.gate:
		if err := ctx.Err(); err != nil {
			local.gate <- struct{}{}
			l.dropLocalRef(workspaceID, local)
			return nil, err
		}
	}

	var once sync.Once
	return func() {
		once.Do(func() {
			local.gate <- struct{}{}
			l.dropLocalRef(workspaceID, local)
		})
	}, nil
}

func (l *Locker) dropLocalRef(workspaceID uuid.UUID, local *localLock) {
	l.mu.Lock()
	defer l.mu.Unlock()
	local.refs--
	if local.refs == 0 && l.localLocks[workspaceID] == local {
		delete(l.localLocks, workspaceID)
	}
}

func (l *Locker) key(workspaceID uuid.UUID) int64 {
	sum := sha256.Sum256(append([]byte(l.keySpace), workspaceID[:]...))
	return int64(binary.BigEndian.Uint64(sum[:8]))
}
