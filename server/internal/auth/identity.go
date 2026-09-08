package auth

import (
	"context"
	"time"
)

// Identity is established by authentication middleware, never by client headers.
// CredentialHash is only used for live permission rechecks; it must not be logged.
type Identity struct {
	UserID         string
	AgentID        string
	TaskID         string
	WorkspaceID    string
	CredentialKind string
	CredentialHash string
	ExpiresAt      time.Time
}

type identityKey struct{}

// WithIdentity is for trusted authentication boundaries and test fixtures.
func WithIdentity(ctx context.Context, identity Identity) context.Context {
	return context.WithValue(ctx, identityKey{}, identity)
}

func IdentityFromContext(ctx context.Context) (Identity, bool) {
	identity, ok := ctx.Value(identityKey{}).(Identity)
	return identity, ok && identity.UserID != ""
}
