package seatcapacity

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	db "github.com/multica-ai/multica/server/pkg/db/generated"

	"github.com/multica-ai/multica/server/internal/advisorylock"
)

// The seat-capacity key space, unchanged from when the lock mechanics lived
// here: running deployments must keep coordinating on the same keys.
const workspaceLockKeySpace = "multica-seat-capacity:"

type WorkspaceLocker interface {
	Lock(context.Context, uuid.UUID) (db.DBTX, func(), error)
}

// postgresWorkspaceLocker serializes Cloud capacity calls for one workspace
// across API replicas, running them on the pinned locked session. The lock
// mechanics live in package advisorylock, shared with other key spaces.
type postgresWorkspaceLocker struct {
	locker *advisorylock.Locker
}

func NewWorkspaceLocker(pool *pgxpool.Pool) WorkspaceLocker {
	if pool == nil {
		return nil
	}
	return postgresWorkspaceLocker{locker: advisorylock.New(pool, workspaceLockKeySpace)}
}

func (l postgresWorkspaceLocker) Lock(ctx context.Context, workspaceID uuid.UUID) (db.DBTX, func(), error) {
	conn, release, err := l.locker.Lock(ctx, workspaceID)
	if err != nil {
		return nil, nil, err
	}
	return conn, release, nil
}
