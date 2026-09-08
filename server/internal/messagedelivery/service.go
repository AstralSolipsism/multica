package messagedelivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// txStarter starts the transactions parent-integrity-guarded writes run in.
type txStarter interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Service owns the Labrastro message-delivery module: route configuration,
// delivery decisions, the send worker and the compensation scanner. HTTP
// handlers and the server assembly share ONE instance so a decision created
// by any path (API test send, event wakeup, compensator) lands in the same
// queue the worker drains.
type Service struct {
	Queries *db.Queries
	// Tx starts transactions for parent-integrity-guarded writes (the
	// workspace FOR SHARE lock around decision/receipt inserts, review
	// R3). The server assembly passes the pool; tests do the same.
	Tx txStarter
	// Sender performs the external send. nil (or a transport-less
	// deployment) fails sends with ErrorCodeSenderUnavailable.
	Sender Sender
	// Verifier proves external group/topic targets against the live
	// platform before a route referencing them may be saved or sent
	// (review R1). nil fails such saves closed with
	// TargetUnverifiableError — an unverifiable target is never stored.
	Verifier TargetVerifier
	// Syncer re-runs the EXISTING run-terminal sync for sources whose
	// completion event was lost. nil disables that compensation half.
	Syncer RunSyncer
	// AppURL is the browser origin used for task links in create_issue
	// cards. Empty omits the link (self-host without MULTICA_APP_URL).
	AppURL string
	// Log receives operational events. Content text, target addresses and
	// credentials are never logged.
	Log *slog.Logger
	// Now is injectable for tests; production uses time.Now.
	Now func() time.Time

	// ScanEvery is the compensator cadence. Zero defaults to 30s.
	ScanEvery time.Duration
	// MaxSendAttempts caps automatic retries before a delivery fails.
	// Zero defaults to 5.
	MaxSendAttempts int

	notify chan struct{}
	done   chan struct{}
}

// New builds the module. Call Run to start the worker and compensator.
func New(queries *db.Queries) *Service {
	return &Service{
		Queries: queries,
		Log:     slog.Default(),
		Now:     time.Now,
		notify:  make(chan struct{}, 1),
		done:    make(chan struct{}),
	}
}

func (s *Service) logger() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

func (s *Service) maxAttempts() int {
	if s.MaxSendAttempts > 0 {
		return s.MaxSendAttempts
	}
	return 5
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// ---- route configuration ----

// RouteInput is the create/update payload. Zero values are invalid where a
// field is required; Enabled defaults to true on create and to "unchanged"
// on update when nil.
type RouteInput struct {
	InstallationID  string
	TargetType      string
	TargetUserID    string
	TargetChatID    string
	TargetMessageID string
	TargetThreadID  string
	Conditions      string
	ContentMode     string
	Enabled         *bool
}

// resolvedTarget is the validated outcome of a RouteInput: the installation
// row plus the canonical target pieces a decision (and the route row) need.
type resolvedTarget struct {
	installation db.ChannelInstallation
	targetType   string
	userID       pgtype.UUID
	chatID       pgtype.Text
	messageID    pgtype.Text
	threadID     pgtype.Text
	targetKey    string
	openID       string // member targets: the live bound platform id
}

// ResolveTarget validates a route payload against current state: the bot
// installation must exist, be active and belong to this workspace; a member
// target must be a current member AND hold a binding on THIS installation
// (never "some recent binding of the channel"); group/topic targets must
// carry addressable anchors.
func (s *Service) ResolveTarget(ctx context.Context, workspaceID pgtype.UUID, in RouteInput) (resolvedTarget, error) {
	if !ValidTargetTypes[in.TargetType] {
		return resolvedTarget{}, &InvalidRouteError{Field: "target_type"}
	}
	if !ValidRouteConditions[in.Conditions] {
		return resolvedTarget{}, &InvalidRouteError{Field: "conditions"}
	}
	if !ValidContentModes[in.ContentMode] {
		return resolvedTarget{}, &InvalidRouteError{Field: "content_mode"}
	}
	instID, err := util.ParseUUID(in.InstallationID)
	if err != nil {
		return resolvedTarget{}, &InvalidRouteError{Field: "installation_id"}
	}
	inst, err := s.Queries.GetChannelInstallationInWorkspace(ctx, db.GetChannelInstallationInWorkspaceParams{
		ID:          instID,
		WorkspaceID: workspaceID,
		ChannelType: "feishu",
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return resolvedTarget{}, &InstallationInvalidError{Reason: "installation not found in workspace"}
	}
	if err != nil {
		return resolvedTarget{}, fmt.Errorf("load installation: %w", err)
	}
	if inst.Status != "active" {
		return resolvedTarget{}, &InstallationInvalidError{Reason: "installation is revoked"}
	}

	out := resolvedTarget{
		installation: inst,
		targetType:   in.TargetType,
		chatID:       pgtype.Text{String: in.TargetChatID, Valid: in.TargetChatID != ""},
		messageID:    pgtype.Text{String: in.TargetMessageID, Valid: in.TargetMessageID != ""},
		threadID:     pgtype.Text{String: in.TargetThreadID, Valid: in.TargetThreadID != ""},
	}

	switch in.TargetType {
	case TargetMember:
		userID, parseErr := util.ParseUUID(in.TargetUserID)
		if parseErr != nil {
			return resolvedTarget{}, &InvalidRouteError{Field: "target_user_id"}
		}
		_, memberErr := s.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
			UserID:      userID,
			WorkspaceID: workspaceID,
		})
		if errors.Is(memberErr, pgx.ErrNoRows) {
			return resolvedTarget{}, &TargetNotMemberError{}
		} else if memberErr != nil {
			return resolvedTarget{}, fmt.Errorf("load target member: %w", memberErr)
		}
		// Installation-precise binding: (workspace, installation, user).
		// Re-checked before every send; a route is only saved when the
		// member is addressable NOW.
		_, bindErr := s.Queries.GetChannelUserBindingForDelivery(ctx, db.GetChannelUserBindingForDeliveryParams{
			WorkspaceID:    workspaceID,
			InstallationID: instID,
			MulticaUserID:  userID,
		})
		if errors.Is(bindErr, pgx.ErrNoRows) {
			return resolvedTarget{}, &MemberNotBoundError{}
		} else if bindErr != nil {
			return resolvedTarget{}, fmt.Errorf("load member binding: %w", bindErr)
		}
		out.userID = userID
		// Canonical UUID form in the target key (review R5): two textual
		// spellings of one member id must be ONE target, or the dedup
		// guarantee silently splits.
		in.TargetUserID = util.UUIDToString(userID)
	case TargetGroup:
		if in.TargetChatID == "" {
			return resolvedTarget{}, &InvalidRouteError{Field: "target_chat_id"}
		}
		// Fail-closed reachability check through the live platform
		// (review R1): a group route is only saved when the pinned bot
		// can actually see the chat.
		if s.Verifier == nil {
			return resolvedTarget{}, &TargetUnverifiableError{}
		}
		if err := s.Verifier.VerifyGroupTarget(ctx, VerifyTargetRequest{
			WorkspaceID:    util.UUIDToString(workspaceID),
			InstallationID: util.UUIDToString(instID),
			ChannelType:    inst.ChannelType,
			ChatID:         in.TargetChatID,
		}); err != nil {
			return resolvedTarget{}, classifyTargetVerifyError(err)
		}
	case TargetTopic:
		if in.TargetChatID == "" {
			return resolvedTarget{}, &InvalidRouteError{Field: "target_chat_id"}
		}
		if in.TargetMessageID == "" {
			return resolvedTarget{}, &InvalidRouteError{Field: "target_message_id"}
		}
		// Verify the anchor→chat relationship through the live platform
		// (review R1): the reply endpoint addresses only the anchor, so a
		// declared-but-foreign chat could silently redirect delivery.
		// The VERIFIED chat id is what gets stored.
		if s.Verifier == nil {
			return resolvedTarget{}, &TargetUnverifiableError{}
		}
		verified, err := s.Verifier.VerifyTopicTarget(ctx, VerifyTargetRequest{
			WorkspaceID:    util.UUIDToString(workspaceID),
			InstallationID: util.UUIDToString(instID),
			ChannelType:    inst.ChannelType,
			ChatID:         in.TargetChatID,
			MessageID:      in.TargetMessageID,
		})
		if err != nil {
			return resolvedTarget{}, classifyTargetVerifyError(err)
		}
		out.chatID = pgtype.Text{String: verified, Valid: true}
		in.TargetChatID = verified
	}

	out.targetKey = TargetKey(in.TargetType, in.TargetUserID, in.TargetChatID, in.TargetMessageID)
	return out, nil
}

// classifyTargetVerifyError maps adapter verification failures onto the
// module's typed errors. Anything unrecognized is treated as UNVERIFIABLE,
// so a save never proceeds on an unknown verdict.
func classifyTargetVerifyError(err error) error {
	var mismatch *TargetAnchorMismatchError
	var unreachable *TargetUnreachableError
	switch {
	case errors.Is(err, ErrTargetUnreachable):
		return &TargetUnreachableError{Detail: err.Error()}
	case errors.Is(err, ErrTargetAnchorMismatch):
		return &TargetAnchorMismatchError{Detail: err.Error()}
	case errors.As(err, &mismatch):
		return mismatch
	case errors.As(err, &unreachable):
		return unreachable
	}
	return &TargetUnverifiableError{Detail: err.Error()}
}

func (s *Service) enabledOrDefault(in RouteInput, create bool, current bool) bool {
	if in.Enabled != nil {
		return *in.Enabled
	}
	if create {
		return true
	}
	return current
}

// CreateRoute saves a new delivery rule. The acting member (resolved by the
// HTTP layer through requireAutopilotWrite) is stamped as creator AND first
// updater — the config author is recorded, distinct from the recipient and
// from whoever authorized the automation.
func (s *Service) CreateRoute(ctx context.Context, ap db.Autopilot, member db.Member, in RouteInput) (db.LabrastroMessageRoute, error) {
	target, err := s.ResolveTarget(ctx, ap.WorkspaceID, in)
	if err != nil {
		return db.LabrastroMessageRoute{}, err
	}
	route, err := s.Queries.CreateLabrastroMessageRoute(ctx, db.CreateLabrastroMessageRouteParams{
		ID:              dbid.NewV7(),
		WorkspaceID:     ap.WorkspaceID,
		AutopilotID:     ap.ID,
		InstallationID:  target.installation.ID,
		ChannelType:     target.installation.ChannelType,
		TargetType:      target.targetType,
		TargetKey:       target.targetKey,
		Conditions:      in.Conditions,
		ContentMode:     in.ContentMode,
		Enabled:         s.enabledOrDefault(in, true, false),
		CreatedBy:       member.UserID,
		TargetUserID:    target.userID,
		TargetChatID:    target.chatID,
		TargetMessageID: target.messageID,
		TargetThreadID:  target.threadID,
	})
	if isUniqueViolation(err) {
		return db.LabrastroMessageRoute{}, ErrRouteAlreadyExists
	}
	if err != nil {
		return db.LabrastroMessageRoute{}, fmt.Errorf("create message route: %w", err)
	}
	return route, nil
}

// UpdateRoute edits a route under optimistic concurrency. Zero rows from a
// matching-id-but-stale-revision update surface as ErrRouteRevisionConflict.
// Disabling through an edit cancels the route's not-yet-started sends.
func (s *Service) UpdateRoute(ctx context.Context, route db.LabrastroMessageRoute, member db.Member, expectedRevision int32, in RouteInput) (db.LabrastroMessageRoute, error) {
	target, err := s.ResolveTarget(ctx, route.WorkspaceID, in)
	if err != nil {
		return db.LabrastroMessageRoute{}, err
	}
	enabled := s.enabledOrDefault(in, false, route.Enabled)
	updated, err := s.Queries.UpdateLabrastroMessageRoute(ctx, db.UpdateLabrastroMessageRouteParams{
		ID:               route.ID,
		WorkspaceID:      route.WorkspaceID,
		ExpectedRevision: expectedRevision,
		InstallationID:   target.installation.ID,
		ChannelType:      target.installation.ChannelType,
		TargetType:       target.targetType,
		TargetUserID:     target.userID,
		TargetChatID:     target.chatID,
		TargetMessageID:  target.messageID,
		TargetThreadID:   target.threadID,
		TargetKey:        target.targetKey,
		Conditions:       in.Conditions,
		ContentMode:      in.ContentMode,
		Enabled:          enabled,
		UpdatedBy:        member.UserID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Either the route vanished or the revision moved on; distinguish
		// the two so a stale save is reported as a conflict, not a miss.
		current, getErr := s.Queries.GetLabrastroMessageRoute(ctx, db.GetLabrastroMessageRouteParams{
			ID: route.ID, WorkspaceID: route.WorkspaceID,
		})
		if getErr != nil {
			return db.LabrastroMessageRoute{}, ErrRouteNotFound
		}
		if current.Revision != expectedRevision {
			return db.LabrastroMessageRoute{}, ErrRouteRevisionConflict
		}
		return db.LabrastroMessageRoute{}, ErrRouteNotFound
	}
	if err != nil {
		return db.LabrastroMessageRoute{}, fmt.Errorf("update message route: %w", err)
	}
	if route.Enabled && !enabled {
		s.cancelRouteDeliveries(ctx, route.ID, ErrorCodeRouteDisabled, "route disabled by edit")
	}
	return updated, nil
}

// SetRouteEnabled flips a route's enabled flag under optimistic
// concurrency. Disable stops new enqueues (rules only decide while enabled)
// and cancels queued sends; enable resets the eligibility boundary so the
// disabled window is never backfilled.
func (s *Service) SetRouteEnabled(ctx context.Context, route db.LabrastroMessageRoute, member db.Member, enabled bool, expectedRevision int32) (db.LabrastroMessageRoute, error) {
	updated, err := s.Queries.SetLabrastroMessageRouteEnabled(ctx, db.SetLabrastroMessageRouteEnabledParams{
		ID:               route.ID,
		WorkspaceID:      route.WorkspaceID,
		ExpectedRevision: expectedRevision,
		Enabled:          enabled,
		UpdatedBy:        member.UserID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		current, getErr := s.Queries.GetLabrastroMessageRoute(ctx, db.GetLabrastroMessageRouteParams{
			ID: route.ID, WorkspaceID: route.WorkspaceID,
		})
		if getErr != nil {
			return db.LabrastroMessageRoute{}, ErrRouteNotFound
		}
		if current.Revision != expectedRevision {
			return db.LabrastroMessageRoute{}, ErrRouteRevisionConflict
		}
		return db.LabrastroMessageRoute{}, ErrRouteNotFound
	}
	if err != nil {
		return db.LabrastroMessageRoute{}, fmt.Errorf("set message route enabled: %w", err)
	}
	if !enabled {
		s.cancelRouteDeliveries(ctx, route.ID, ErrorCodeRouteDisabled, "route disabled")
	}
	return updated, nil
}

// DeleteRoute removes the rule and cancels its queued sends. Decisions
// already made (sent/failed/...) keep their snapshots and receipts for
// audit — deleting a rule never rewrites history.
func (s *Service) DeleteRoute(ctx context.Context, route db.LabrastroMessageRoute) error {
	s.cancelRouteDeliveries(ctx, route.ID, ErrorCodeRouteDeleted, "route deleted")
	if err := s.Queries.DeleteLabrastroMessageRoute(ctx, db.DeleteLabrastroMessageRouteParams{
		ID: route.ID, WorkspaceID: route.WorkspaceID,
	}); err != nil {
		return fmt.Errorf("delete message route: %w", err)
	}
	return nil
}

func (s *Service) cancelRouteDeliveries(ctx context.Context, routeID pgtype.UUID, code, reason string) {
	cancelled, err := s.Queries.CancelLabrastroMessageDeliveriesByRoute(ctx, db.CancelLabrastroMessageDeliveriesByRouteParams{
		RouteID:   routeID,
		ErrorCode: pgtype.Text{String: code, Valid: true},
		LastError: pgtype.Text{String: reason, Valid: true},
	})
	if err != nil {
		s.logger().Warn("messagedelivery: cancel queued deliveries for route",
			"route_id", util.UUIDToString(routeID), "error", err)
		return
	}
	for _, d := range cancelled {
		s.logger().Info("messagedelivery: queued delivery cancelled",
			"delivery_id", util.UUIDToString(d.ID),
			"route_id", util.UUIDToString(routeID),
			"reason_code", code,
		)
	}
}

// CancelInstallationDeliveries stops everything a disconnected bot had not
// started sending. Wired to the installation revoke path; the worker's own
// installation re-check covers the race where a claim lands in between.
func (s *Service) CancelInstallationDeliveries(ctx context.Context, workspaceID, installationID pgtype.UUID) {
	_, err := s.Queries.CancelLabrastroMessageDeliveriesByInstallation(ctx, db.CancelLabrastroMessageDeliveriesByInstallationParams{
		WorkspaceID:    workspaceID,
		InstallationID: installationID,
		ErrorCode:      pgtype.Text{String: ErrorCodeInstallationRevoked, Valid: true},
		LastError:      pgtype.Text{String: "installation revoked", Valid: true},
	})
	if err != nil {
		s.logger().Warn("messagedelivery: cancel queued deliveries for installation",
			"installation_id", util.UUIDToString(installationID), "error", err)
	}
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) {
		return pgErr.SQLState() == "23505"
	}
	return false
}

// ---- delivery decisions ----

// EnqueueRunDeliveries decides deliveries for one terminal run. Idempotent:
// the unique dedup key collapses concurrent and repeated invocations into
// one decision per (source, target). Called from the EventBus wakeup (a
// latency hint) and, for anything the event missed, by the compensator.
func (s *Service) EnqueueRunDeliveries(ctx context.Context, runID pgtype.UUID) (int, error) {
	run, err := s.Queries.GetAutopilotRun(ctx, runID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("load run: %w", err)
	}
	if !terminalRunStatuses[run.Status] {
		return 0, nil
	}
	ap, err := s.Queries.GetAutopilot(ctx, run.AutopilotID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("load autopilot: %w", err)
	}
	// An archived automation is a stopped source: no new decisions. The
	// worker separately cancels anything still queued.
	if ap.Status == "archived" {
		return 0, nil
	}
	routes, err := s.Queries.ListEnabledLabrastroMessageRoutesByAutopilot(ctx, db.ListEnabledLabrastroMessageRoutesByAutopilotParams{
		WorkspaceID: ap.WorkspaceID,
		AutopilotID: ap.ID,
	})
	if err != nil {
		return 0, fmt.Errorf("load routes: %w", err)
	}

	decided := 0
	for _, route := range routes {
		in := decisionInput{
			WorkspaceID:         util.UUIDToString(ap.WorkspaceID),
			AutopilotID:         util.UUIDToString(ap.ID),
			RunID:               util.UUIDToString(run.ID),
			RunStatus:           run.Status,
			RunCompletedAt:      run.CompletedAt.Time,
			RunCompletedAtValid: run.CompletedAt.Valid,
			ExecutionMode:       ap.ExecutionMode,
			RunTaskID:           util.UUIDToString(run.TaskID),
			RunTaskIDValid:      run.TaskID.Valid,
			Route:               route,
			Run: runFields{
				Result:        run.Result,
				FailureReason: run.FailureReason.String,
				ReasonCode:    run.ReasonCode.String,
				IssueID:       util.UUIDToString(run.IssueID),
				IssueIDValid:  run.IssueID.Valid,
			},
		}
		n, err := s.decideDelivery(ctx, ap, in)
		if err != nil {
			return decided, err
		}
		decided += n
	}
	if decided > 0 {
		s.Notify()
	}
	return decided, nil
}

// decideDelivery freezes content + target for one (run, route) pair and
// records the decision — a send when the condition matches, a suppressed
// marker otherwise. Both count as decisions: a source this module has judged
// is never re-judged. Returns 1 when THIS call created the row, 0 when a
// decision already existed.
func (s *Service) decideDelivery(ctx context.Context, ap db.Autopilot, in decisionInput) (int, error) {
	// Eligibility window: only runs completing at/after the rule's
	// boundary. Outside the window is NOT a decision — the candidate scan
	// filters those pairs out too, so nothing accumulates.
	if in.Route.EffectiveFrom.Valid && in.RunCompletedAtValid && in.RunCompletedAt.Before(in.Route.EffectiveFrom.Time) {
		return 0, nil
	}
	target, content, ref, shardTotal, err := s.buildDecisionPayload(ctx, ap, in)
	if err != nil {
		return 0, err
	}

	status := DeliveryStatusQueued
	var errorCode pgtype.Text
	if !routeMatchesRun(in.Route.Conditions, in.RunStatus) {
		// Condition mismatch (including skipped runs): record the
		// decision so the compensator stops revisiting this source.
		status = DeliveryStatusSuppressed
		errorCode = pgtype.Text{String: ErrorCodeConditionMismatch, Valid: true}
	}

	contentJSON, err := json.Marshal(content)
	if err != nil {
		return 0, fmt.Errorf("encode content snapshot: %w", err)
	}
	targetJSON, err := json.Marshal(target)
	if err != nil {
		return 0, fmt.Errorf("encode target snapshot: %w", err)
	}
	refJSON, err := json.Marshal(ref)
	if err != nil {
		return 0, fmt.Errorf("encode source ref: %w", err)
	}

	// Parent-integrity (review R3): the decision insert shares a short
	// transaction with a FOR SHARE lock on the workspace row. The
	// DeleteWorkspace flow takes that row FOR UPDATE before sweeping, so a
	// stale compensator snapshot can never commit content-bearing rows
	// into a deleted workspace: either the delete committed first (row
	// gone, refuse) or this commit lands first (the delete sweeps it).
	tx, err := s.Tx.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin decision tx: %w", err)
	}
	defer tx.Rollback(ctx)
	qtx := s.Queries.WithTx(tx)
	if _, err := qtx.LockWorkspaceForMessageDecision(ctx, ap.WorkspaceID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil // workspace gone; the source no longer exists
		}
		return 0, fmt.Errorf("lock decision parent: %w", err)
	}
	rows, err := qtx.CreateLabrastroMessageDelivery(ctx, db.CreateLabrastroMessageDeliveryParams{
		ID:              dbid.NewV7(),
		WorkspaceID:     ap.WorkspaceID,
		RouteID:         in.Route.ID,
		RouteRevision:   pgtype.Int4{Int32: in.Route.Revision, Valid: true},
		AutopilotID:     ap.ID,
		RunID:           mustUUID(in.RunID),
		DedupKey:        DeliveryDedupKey(in.RunID, util.UUIDToString(in.Route.InstallationID), in.Route.TargetKey),
		SourceKind:      sourceKindFromRun(in.Run.IssueIDValid, in.RunTaskIDValid, in.Run.Result, in.ExecutionMode),
		Status:          status,
		ContentSnapshot: contentJSON,
		TargetSnapshot:  targetJSON,
		ShardTotal:      int32(shardTotal),
		SourceRef:       refJSON,
		TargetKey:       in.Route.TargetKey,
		InstallationID:  in.Route.InstallationID,
		ErrorCode:       errorCode,
	})
	if err != nil && !isUniqueViolation(err) {
		return 0, fmt.Errorf("insert delivery decision: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit delivery decision: %w", err)
	}
	// ON CONFLICT DO NOTHING also returns zero rows on duplicate; both
	// shapes mean "already decided by someone else".
	if len(rows) == 0 {
		return 0, nil
	}
	if status == DeliveryStatusSuppressed {
		s.logger().Info("messagedelivery: source suppressed by route condition",
			"run_id", in.RunID,
			"route_id", util.UUIDToString(in.Route.ID),
			"reason_code", ErrorCodeConditionMismatch,
		)
		return 1, nil
	}
	s.logger().Info("messagedelivery: delivery decision created",
		"delivery_id", util.UUIDToString(rows[0].ID),
		"run_id", in.RunID,
		"route_id", util.UUIDToString(in.Route.ID),
	)
	return 1, nil
}

// buildDecisionPayload renders the frozen content/target/ref triple. This
// is the redaction boundary: only curated fields cross it.
func (s *Service) buildDecisionPayload(ctx context.Context, ap db.Autopilot, in decisionInput) (targetSnapshot, contentSnapshot, sourceRef, int, error) {
	target := targetSnapshot{
		TargetType:   in.Route.TargetType,
		ChannelType:  in.Route.ChannelType,
		Installation: util.UUIDToString(in.Route.InstallationID),
	}
	// Member targets freeze the CURRENT bound platform id, and the send
	// path re-resolves the binding before dialing (revocation between
	// decision and send fails the delivery with member_unbound, it does
	// not send to a stale address).
	if in.Route.TargetType == TargetMember && in.Route.TargetUserID.Valid {
		target.UserID = util.UUIDToString(in.Route.TargetUserID)
		binding, err := s.Queries.GetChannelUserBindingForDelivery(ctx, db.GetChannelUserBindingForDeliveryParams{
			WorkspaceID:    ap.WorkspaceID,
			InstallationID: in.Route.InstallationID,
			MulticaUserID:  in.Route.TargetUserID,
		})
		switch {
		case err == nil:
			target.OpenID = binding.ChannelUserID
		case errors.Is(err, pgx.ErrNoRows):
			// Unbound between rule save and decision: the send would
			// fail anyway; freeze without an address so the send-time
			// failure is member_unbound.
		default:
			return target, contentSnapshot{}, sourceRef{}, 0,
				fmt.Errorf("resolve member binding for decision: %w", err)
		}
	}
	target.ChatID = in.Route.TargetChatID.String
	target.MessageID = in.Route.TargetMessageID.String
	target.ThreadID = in.Route.TargetThreadID.String

	// The source kind comes from the run's persisted links (review R7);
	// the frozen ref records that original mode, never the mutable
	// autopilot configuration.
	sourceKind := sourceKindFromRun(in.Run.IssueIDValid, in.RunTaskIDValid, in.Run.Result, in.ExecutionMode)
	ref := sourceRef{
		RunID:         in.RunID,
		ExecutionMode: sourceKind,
		IssueID:       in.Run.IssueID,
	}

	var content contentSnapshot
	switch sourceKind {
	case SourceKindRunOnly:
		output, hasOutput := extractRunOnlyOutput(in.Run.Result)
		content = buildRunOnlyContent(
			ap.Title,
			in.RunStatus,
			in.Run.ReasonCode,
			in.Run.FailureReason,
			output,
			hasOutput,
			in.Route.ContentMode == ContentWithOutput,
		)
	default:
		ident, issueStatus, slug := s.issueRef(ctx, ap.WorkspaceID, in)
		content = buildCreateIssueContent(ap.Title, in.RunStatus, ident, issueStatus, s.AppURL, slug)
		ref.IssueIdentifier = ident
		ref.IssueStatus = issueStatus
	}

	shards := splitShards(content.Text)
	return target, content, ref, len(shards), nil
}

// issueRef resolves the linked issue's human-facing identifier, its FIRST
// terminal status, and the workspace slug for a create_issue card.
//
// The first-terminal status is the one the run completed against, read from
// what the terminal-sync boundary persisted into run.result
// (first_terminal_status — see service.SyncRunFromIssue). When that signal
// is absent (runs completed before it existed) the CURRENT issue status is
// used ONLY if the issue has provably not been touched since the run
// completed; otherwise the status is reported as empty and the card wording
// degrades instead of presenting a later status as the first terminal one
// (review R6). A deleted issue degrades to no identifier — the run still
// delivers, just without a link, instead of failing the decision.
func (s *Service) issueRef(ctx context.Context, workspaceID pgtype.UUID, in decisionInput) (string, string, string) {
	if !in.Run.IssueIDValid {
		return "", "", ""
	}
	issueID, err := util.ParseUUID(in.Run.IssueID)
	if err != nil {
		return "", "", ""
	}
	issue, err := s.Queries.GetIssue(ctx, issueID)
	if err != nil {
		return "", "", ""
	}
	prefix := ""
	slug := ""
	if ws, err := s.Queries.GetWorkspace(ctx, workspaceID); err == nil {
		prefix = ws.IssuePrefix
		slug = ws.Slug
	}
	return issueIdentifier(prefix, issue.Number), s.firstTerminalIssueStatus(issue, in), slug
}

// firstTerminalIssueStatus reports the status to name on the card.
//
//   - Completed runs read the status frozen by the terminal sync
//     (run.result.first_terminal_status — review R6).
//   - Failed runs read it from the failure reason the SAME sync boundary
//     wrote ("issue <status>" at the terminal moment — a single, stable
//     producer).
//   - Anything else degrades to "" — the card must never present the
//     issue's CURRENT status as the first terminal one, and legacy rows
//     carry no recoverable signal (issue.updated_at does not track writes
//     reliably enough to prove "untouched since completion").
func (s *Service) firstTerminalIssueStatus(issue db.Issue, in decisionInput) string {
	if in.RunStatus == "completed" && len(in.Run.Result) > 0 {
		var payload struct {
			FirstTerminalStatus string `json:"first_terminal_status"`
		}
		if err := json.Unmarshal(in.Run.Result, &payload); err == nil && payload.FirstTerminalStatus != "" {
			return payload.FirstTerminalStatus
		}
	}
	if in.RunStatus == "failed" {
		const marker = "issue "
		if rest, ok := strings.CutPrefix(in.Run.FailureReason, marker); ok && rest != "" {
			return rest
		}
	}
	return ""
}

// issueIdentifier mirrors service.IssueIdentifier ("MUL-42", or "#42"
// without a prefix). Kept local so this module stays a leaf package; the
// format is API-visible contract and must not drift — a test pins the
// format.
func issueIdentifier(prefix string, number int32) string {
	if prefix == "" {
		return "#" + strconv.Itoa(int(number))
	}
	return prefix + "-" + strconv.Itoa(int(number))
}

func mustUUID(s string) pgtype.UUID {
	u, err := util.ParseUUID(s)
	if err != nil {
		return pgtype.UUID{}
	}
	return u
}
