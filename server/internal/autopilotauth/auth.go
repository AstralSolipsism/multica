// Package autopilotauth holds the ONE predicate that decides whether a
// workspace member may write to (or execute) an automation: workspace
// owner/admin, the automation's creator, or a granted collaborator.
//
// Both surfaces that spend that authority share this function — the HTTP
// gate (handler.memberCanWriteAutopilot) and the message-delivery send gate
// (worker-side continuous-authorization re-check) — so a permission change
// can never land on one surface and silently miss the other (review S4).
// The HTTP side keeps its own acting-member resolution and refusal codes;
// this package is only the predicate.
package autopilotauth

import (
	"context"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Querier is the read surface the collaborator grant check needs; both
// *db.Queries and transaction-bound wrappers satisfy it.
type Querier interface {
	IsAutopilotCollaborator(ctx context.Context, arg db.IsAutopilotCollaboratorParams) (bool, error)
}

// CanWriteAutopilot reports whether the member may perform write or execute
// operations on the automation — editing it, triggering runs, configuring
// delivery rules for it. The same predicate gates the CONTINUOUS execution
// authorization of already-saved delivery rules: a rule spends the
// authority of the member who last saved it, re-checked at send time.
func CanWriteAutopilot(ctx context.Context, q Querier, ap db.Autopilot, member db.Member) bool {
	if member.Role == "owner" || member.Role == "admin" {
		return true
	}
	if ap.CreatedByType == "member" && ap.CreatedByID == member.UserID {
		return true
	}
	granted, err := q.IsAutopilotCollaborator(ctx, db.IsAutopilotCollaboratorParams{
		AutopilotID: ap.ID,
		UserID:      member.UserID,
	})
	return err == nil && granted
}
