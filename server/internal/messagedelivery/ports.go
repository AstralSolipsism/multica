package messagedelivery

import (
	"context"
	"errors"
	"fmt"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ErrorClass tells the worker how a failed send may be treated.
type ErrorClass int

const (
	// ClassPermanent: the platform refused definitively (invalid target,
	// no visibility, revoked bot). Retrying cannot help; the delivery
	// fails with an explainable code.
	ClassPermanent ErrorClass = iota
	// ClassTransient: rate limit / 5xx / temporary condition. Back off
	// and retry with the same send UUID.
	ClassTransient
	// ClassAmbiguous: the request may or may not have been delivered
	// (timeout, lost response, lost receipt). The delivery becomes
	// "uncertain"; only a manual verify-and-retry resolves it.
	ClassAmbiguous
)

// SendError is the only error shape the Sender returns, so the worker can
// classify outcomes without knowing any channel's error taxonomy.
type SendError struct {
	Class ErrorClass
	// Code is the provider's stable business code when the refusal was
	// definitive (e.g. a Lark error code). Empty otherwise.
	Code string
	Err  error
}

func (e *SendError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("send rejected (code %s): %v", e.Code, e.Err)
	}
	switch e.Class {
	case ClassTransient:
		return fmt.Sprintf("send transient failure: %v", e.Err)
	case ClassAmbiguous:
		return fmt.Sprintf("send outcome unknown: %v", e.Err)
	default:
		return fmt.Sprintf("send rejected: %v", e.Err)
	}
}

func (e *SendError) Unwrap() error { return e.Err }

// SendRequest is one shard going to one resolved target.
type SendRequest struct {
	DeliveryID     string
	SourceURL      string
	WorkspaceID    string
	InstallationID string
	ChannelType    string
	Target         Target
	// Text is this shard's frozen body slice.
	Text string
	// SendUUID is the idempotency key for THIS shard, fixed across
	// retries. The platform's dedup window is finite (about an hour for
	// Lark), so the UUID lowers duplication risk; it is not an
	// end-to-end exactly-once promise.
	SendUUID   string
	ShardIndex int
	ShardTotal int
}

// SendResult carries the platform's message id for an accepted shard.
type SendResult struct {
	ExternalMessageID string
}

// Sender performs the external proactive send. Implemented by the channel
// adapter (lark.DeliverySender); tests substitute fakes. A nil Sender or
// one returning ErrSenderUnavailable fails deliveries with
// ErrorCodeSenderUnavailable instead of silently dropping them.
type Sender interface {
	Send(ctx context.Context, req SendRequest) (SendResult, error)
}

// ErrSenderUnavailable: no transport is wired for this deployment.
var ErrSenderUnavailable = errors.New("delivery sender not configured")

// RunSyncer is the existing terminal-state sync the compensator reuses for
// "the task ended but the run never heard about it". *service.AutopilotService
// satisfies this shape; the module deliberately re-enters the SAME logic
// instead of maintaining a second state machine.
type RunSyncer interface {
	SyncRunFromTask(ctx context.Context, task db.AgentTaskQueue)
	SyncRunFromIssue(ctx context.Context, issue db.Issue)
	// SyncRunFromLinkedIssueTask fails the run of a create_issue automation
	// when its linked issue's terminal task failure has no active retry —
	// the third compensation source (review R12).
	SyncRunFromLinkedIssueTask(ctx context.Context, task db.AgentTaskQueue)
}

// VerifyTargetRequest names one external target to verify against the live
// platform, through one pinned installation.
type VerifyTargetRequest struct {
	WorkspaceID    string
	InstallationID string
	ChannelType    string
	ChatID         string
	MessageID      string
}

// Sentinel verdicts the adapter wraps its verification failures in
// (errors.Is-compatible). ErrTargetUnreachable: a definitive platform
// refusal — unknown chat, bot not a member, outside visibility.
// ErrTargetAnchorMismatch: the anchor message provably lives in a different
// chat than the route declared.
var (
	ErrTargetUnreachable    = errors.New("delivery target unreachable by this bot")
	ErrTargetAnchorMismatch = errors.New("delivery topic anchor belongs to a different chat")
)

// TargetVerifier proves an external target is reachable by the pinned bot
// BEFORE a route referencing it may be saved or sent (review R1). Group
// verification answers "can the bot see this chat"; topic verification
// answers "does this anchor message actually live in the declared chat"
// and returns the VERIFIED chat id — the value the route stores, so a
// declared chat can never redirect a topic reply.
//
// Implemented by the channel adapter (lark.DeliverySender). When nil — a
// deployment without the channel transport — group/topic route saves fail
// closed with TargetUnverifiableError instead of saving unverifiable
// targets.
type TargetVerifier interface {
	VerifyGroupTarget(ctx context.Context, req VerifyTargetRequest) error
	VerifyTopicTarget(ctx context.Context, req VerifyTargetRequest) (verifiedChatID string, err error)
}
