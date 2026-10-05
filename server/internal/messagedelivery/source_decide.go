package messagedelivery

// Candidates already collapse all equivalent routes to the best matching
// authorized rule. We freeze one decision per source/normalized target,
// checking the selected route again under the lock used by configuration
// writes. Source cursors include their last ID until all its targets drain.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/notify"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ---- inbox (personal) ----

// scanInboxSourceDecisions judges one page of inbox_item × personal-route
// pairs.
func (s *Service) scanInboxSourceDecisions(ctx context.Context, cur scanCursor) (scanCursor, error) {
	rows, err := s.Queries.ListLabrastroMessageInboxSourceCandidates(ctx, db.ListLabrastroMessageInboxSourceCandidatesParams{
		ScanFrom:    pgtype.Timestamptz{Time: cur.ts.Add(-sourceScanOverlap), Valid: true},
		ScanThrough: pgtype.Timestamptz{Time: cur.cycleStarted, Valid: true},
		AfterID:     cur.id,
		UpperID:     cur.upperID,
		Limit:       scanPageLimit,
	})
	if err != nil {
		return cur, err
	}
	if len(rows) == 0 {
		return cur, nil
	}
	for _, row := range rows {
		if err := s.decideInboxPair(ctx, row); err != nil {
			// The page is NOT advanced on failure: the next tick re-reads
			// it. A preference lookup error must never be judged as
			// "unmuted", and a failed page must never lose rows.
			return cur, err
		}
	}
	cur.id = rows[len(rows)-1].ItemID
	cur.nonempty = true
	return cur, nil
}

// decideInboxPair freezes one inbox forwarding decision. The route's target
// is definitionally the item's recipient (the scan JOIN enforces it), so
// the personal surface can only ever forward a member's OWN items to their
// OWN chat.
func (s *Service) decideInboxPair(ctx context.Context, row db.ListLabrastroMessageInboxSourceCandidatesRow) error {
	refID := util.UUIDToString(row.ItemID)
	wsID := util.UUIDToString(row.ItemWorkspaceID)
	instID := util.UUIDToString(row.InstallationID)
	ident := ""
	if row.IssueNumber.Valid {
		ident = issueIdentifier(row.WorkspaceIssuePrefix, row.IssueNumber.Int32)
	}
	// Content is built from the source record for EVERY outcome — a
	// suppressed marker records what would have been sent, so the audit
	// trail explains the decision instead of leaving a hollow row.
	content := buildInboxContent(row, ident, s.AppURL, row.WorkspaceSlug)
	ref := sourceRef{
		SourceKind:      SourceKindInbox,
		InboxItemID:     refID,
		IssueID:         util.UUIDToString(row.ItemIssueID),
		IssueIdentifier: ident,
	}
	var details struct {
		CommentID string `json:"comment_id"`
	}
	if err := json.Unmarshal(row.ItemDetails, &details); err == nil {
		if _, err := util.ParseUUID(details.CommentID); err == nil {
			ref.CommentID = details.CommentID
		}
	}
	base := sourceDecision{
		scope: RouteSourceInbox, workspaceID: wsID, sourceRefID: refID,
		routeID: row.RouteID, routeRevision: row.RouteRevision,
		sourceCreatedAt: row.ItemCreatedAt.Time,
		installationID:  row.InstallationID, targetKey: row.TargetKey,
		kind: SourceKindInbox, content: content, ref: ref,
	}
	// The event filter is judged here (not in SQL) so a filtered-out pair
	// is RECORDED as suppressed — editing the filter later must not replay
	// the events it used to exclude.
	if len(row.EventTypes) > 0 && !containsString(row.EventTypes, row.ItemType) {
		base.status, base.errorCode = DeliveryStatusSuppressed, ErrorCodeConditionMismatch
		return s.insertSourceDecision(ctx, base)
	}
	// Mute semantics are the SAME preference check the inbox listeners
	// applied when creating the item, re-judged live: an item muted after
	// it persisted is not forwarded, and an unreadable preference table is
	// NEVER treated as "not muted" — the pair stays undecided (the page
	// aborts, the cursor holds) until preferences can be read again.
	muted, err := s.inboxMuted(ctx, row.ItemWorkspaceID, row.RecipientID, row.ItemType)
	if err != nil {
		return fmt.Errorf("judge mute for inbox item %s: %w", refID, err)
	}
	if muted {
		base.status, base.errorCode = DeliveryStatusSuppressed, ErrorCodeRecipientMuted
		return s.insertSourceDecision(ctx, base)
	}

	target := targetSnapshot{
		TargetType:   row.TargetType,
		ChannelType:  row.ChannelType,
		Installation: instID,
		UserID:       util.UUIDToString(row.TargetUserID),
	}
	// Freeze the CURRENT bound platform id; the send path re-resolves the
	// binding before dialing (unbinding between decision and send fails
	// with member_unbound, it does not send to a stale address).
	binding, err := s.Queries.GetChannelUserBindingForDelivery(ctx, db.GetChannelUserBindingForDeliveryParams{
		WorkspaceID: row.ItemWorkspaceID, InstallationID: row.InstallationID, MulticaUserID: row.TargetUserID,
	})
	switch {
	case err == nil:
		target.OpenID = binding.ChannelUserID
	case errors.Is(err, pgx.ErrNoRows):
		// Unbound between route save and decision: the send would fail
		// anyway; freeze without an address so the send-time failure is
		// member_unbound (the same contract as the automation source).
	default:
		return fmt.Errorf("resolve member binding for inbox decision: %w", err)
	}
	base.status, base.target = DeliveryStatusQueued, target
	return s.insertSourceDecision(ctx, base)
}

// inboxMuted reads the recipient's live preference. A query failure is an
// error, never a verdict (fail closed).
func (s *Service) inboxMuted(ctx context.Context, workspaceID, userID pgtype.UUID, itemType string) (bool, error) {
	rows, err := s.Queries.ListNotificationPreferencesByUsers(ctx, db.ListNotificationPreferencesByUsersParams{
		WorkspaceID: workspaceID,
		UserIds:     []pgtype.UUID{userID},
	})
	if err != nil {
		return false, err
	}
	if len(rows) == 0 {
		return false, nil
	}
	var prefs map[string]string
	if err := json.Unmarshal(rows[0].Preferences, &prefs); err != nil {
		return false, fmt.Errorf("parse notification preference: %w", err)
	}
	return notify.IsMuted(prefs, itemType), nil
}

func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// ---- team activity ----

// scanActivitySourceDecisions judges one page of activity_log × team-route
// pairs. The action whitelist is definitional SQL; the project filter is
// judged here so a scoped-out pair is recorded, not rescanned forever.
func (s *Service) scanActivitySourceDecisions(ctx context.Context, cur scanCursor) (scanCursor, error) {
	rows, err := s.Queries.ListLabrastroMessageActivitySourceCandidates(ctx, db.ListLabrastroMessageActivitySourceCandidatesParams{
		ScanFrom:    pgtype.Timestamptz{Time: cur.ts.Add(-sourceScanOverlap), Valid: true},
		ScanThrough: pgtype.Timestamptz{Time: cur.cycleStarted, Valid: true},
		AfterID:     cur.id,
		UpperID:     cur.upperID,
		Limit:       scanPageLimit,
	})
	if err != nil {
		return cur, err
	}
	if len(rows) == 0 {
		return cur, nil
	}
	for _, row := range rows {
		if err := s.decideActivityPair(ctx, row); err != nil {
			return cur, err
		}
	}
	cur.id = rows[len(rows)-1].ActivityID
	cur.nonempty = true
	return cur, nil
}

func (s *Service) decideActivityPair(ctx context.Context, row db.ListLabrastroMessageActivitySourceCandidatesRow) error {
	refID := util.UUIDToString(row.ActivityID)
	wsID := util.UUIDToString(row.ActivityWorkspaceID)
	instID := util.UUIDToString(row.InstallationID)
	if (row.RouteProjectID.Valid && row.RouteProjectID != row.IssueProjectID) || (len(row.EventTypes) > 0 && !containsString(row.EventTypes, row.ActivityAction)) {
		return s.insertSourceDecision(ctx, sourceDecision{
			scope: RouteSourceActivity, workspaceID: wsID, sourceRefID: refID,
			routeID: row.RouteID, routeRevision: row.RouteRevision,
			sourceCreatedAt: row.ActivityCreatedAt.Time, projectID: row.RouteProjectID,
			installationID: row.InstallationID, targetKey: row.TargetKey,
			kind: SourceKindActivity, status: DeliveryStatusSuppressed,
			errorCode: ErrorCodeConditionMismatch,
		})
	}
	target := targetSnapshot{
		TargetType:   row.TargetType,
		ChannelType:  row.ChannelType,
		Installation: instID,
		ChatID:       row.TargetChatID.String,
		MessageID:    row.TargetMessageID.String,
		ThreadID:     row.TargetThreadID.String,
	}
	ident := issueIdentifier(row.WorkspaceIssuePrefix, row.IssueNumber)
	actor := actorName(row.ActivityActorType.String, row.ActorMemberName, row.ActorAgentName)
	var details struct {
		From     string `json:"from"`
		To       string `json:"to"`
		FromType string `json:"from_type"`
		FromID   string `json:"from_id"`
		ToType   string `json:"to_type"`
		ToID     string `json:"to_id"`
	}
	if err := json.Unmarshal(row.ActivityDetails, &details); err != nil {
		// details is written by the activity listeners as a JSON object;
		// a malformed record is not deliverable content.
		return s.insertSourceDecision(ctx, sourceDecision{
			scope: RouteSourceActivity, workspaceID: wsID, sourceRefID: refID,
			routeID: row.RouteID, routeRevision: row.RouteRevision,
			sourceCreatedAt: row.ActivityCreatedAt.Time, projectID: row.RouteProjectID,
			installationID: row.InstallationID, targetKey: row.TargetKey,
			kind: SourceKindActivity, status: DeliveryStatusSuppressed,
			errorCode: ErrorCodeConditionMismatch,
		})
	}
	var change string
	var assigneeChange *assigneeChangeSnapshot
	switch row.ActivityAction {
	case notify.ActivityActionStatusChanged:
		change = notify.StatusLabel(details.From) + " → " + notify.StatusLabel(details.To)
	case notify.ActivityActionAssigneeChanged:
		assigneeChange = &assigneeChangeSnapshot{
			FromType: details.FromType, FromID: details.FromID,
			ToType: details.ToType, ToID: details.ToID,
		}
		change = "changed assignee: " + s.assigneeLabel(ctx, row.ActivityWorkspaceID, details.FromType, details.FromID) +
			" → " + s.assigneeLabel(ctx, row.ActivityWorkspaceID, details.ToType, details.ToID)
	}
	content := buildTeamContent(SourceKindActivity, row.ActivityAction, actor, change,
		row.IssueTitle, ident, s.AppURL, row.WorkspaceSlug)
	content.AssigneeChange = assigneeChange
	ref := sourceRef{
		SourceKind:      SourceKindActivity,
		ActivityID:      refID,
		IssueID:         util.UUIDToString(row.ActivityIssueID),
		IssueIdentifier: ident,
	}
	return s.insertSourceDecision(ctx, sourceDecision{
		scope: RouteSourceActivity, workspaceID: wsID, sourceRefID: refID,
		routeID: row.RouteID, routeRevision: row.RouteRevision,
		sourceCreatedAt: row.ActivityCreatedAt.Time, projectID: row.RouteProjectID,
		installationID: row.InstallationID, targetKey: row.TargetKey,
		kind: SourceKindActivity, status: DeliveryStatusQueued,
		target: target, content: content, ref: ref,
	})
}

// assigneeLabel keeps the type visible, including for identically named
// members and agents. Name lookup is best effort within the source workspace;
// missing records or lookup failures retain the original type and ID.
func (s *Service) assigneeLabel(ctx context.Context, workspaceID pgtype.UUID, refType, refID string) string {
	if refType == "" && refID == "" {
		return "Unassigned"
	}
	label := refType
	switch refType {
	case "member":
		label = "Member"
	case "agent":
		label = "Agent"
	case "":
		label = "Assignee"
	}
	name := refID
	if id, err := util.ParseUUID(refID); err == nil {
		switch refType {
		case "member":
			if _, err := s.Queries.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{
				UserID: id, WorkspaceID: workspaceID,
			}); err == nil {
				if user, err := s.Queries.GetUser(ctx, id); err == nil && strings.TrimSpace(user.Name) != "" {
					name = user.Name
				}
			}
		case "agent":
			if agent, err := s.Queries.GetAgent(ctx, id); err == nil && agent.WorkspaceID == workspaceID && strings.TrimSpace(agent.Name) != "" {
				name = agent.Name
			}
		}
	}
	return strings.TrimSpace(label + " " + name)
}

func actorName(actorType string, memberName, agentName pgtype.Text) string {
	switch actorType {
	case "member":
		return memberName.String
	case "agent":
		return agentName.String
	}
	return ""
}

// ---- team comments ----

// scanCommentSourceDecisions judges one page of comment × team-route pairs.
// Only plain comments are sources (definitional SQL, see the query).
func (s *Service) scanCommentSourceDecisions(ctx context.Context, cur scanCursor) (scanCursor, error) {
	rows, err := s.Queries.ListLabrastroMessageCommentSourceCandidates(ctx, db.ListLabrastroMessageCommentSourceCandidatesParams{
		ScanFrom:    pgtype.Timestamptz{Time: cur.ts.Add(-sourceScanOverlap), Valid: true},
		ScanThrough: pgtype.Timestamptz{Time: cur.cycleStarted, Valid: true},
		AfterID:     cur.id,
		UpperID:     cur.upperID,
		Limit:       scanPageLimit,
	})
	if err != nil {
		return cur, err
	}
	if len(rows) == 0 {
		return cur, nil
	}
	for _, row := range rows {
		if err := s.decideCommentPair(ctx, row); err != nil {
			return cur, err
		}
	}
	cur.id = rows[len(rows)-1].CommentID
	cur.nonempty = true
	return cur, nil
}

func (s *Service) decideCommentPair(ctx context.Context, row db.ListLabrastroMessageCommentSourceCandidatesRow) error {
	refID := util.UUIDToString(row.CommentID)
	wsID := util.UUIDToString(row.CommentWorkspaceID)
	instID := util.UUIDToString(row.InstallationID)
	if (row.RouteProjectID.Valid && row.RouteProjectID != row.IssueProjectID) || (len(row.EventTypes) > 0 && !containsString(row.EventTypes, notify.CommentTypeDeliverable)) {
		return s.insertSourceDecision(ctx, sourceDecision{
			scope: RouteSourceComment, workspaceID: wsID, sourceRefID: refID,
			routeID: row.RouteID, routeRevision: row.RouteRevision,
			sourceCreatedAt: row.CommentCreatedAt.Time, projectID: row.RouteProjectID,
			installationID: row.InstallationID, targetKey: row.TargetKey,
			kind: SourceKindComment, status: DeliveryStatusSuppressed,
			errorCode: ErrorCodeConditionMismatch,
		})
	}
	target := targetSnapshot{
		TargetType:   row.TargetType,
		ChannelType:  row.ChannelType,
		Installation: instID,
		ChatID:       row.TargetChatID.String,
		MessageID:    row.TargetMessageID.String,
		ThreadID:     row.TargetThreadID.String,
	}
	ident := issueIdentifier(row.WorkspaceIssuePrefix, row.IssueNumber)
	author := actorName(row.CommentAuthorType, row.AuthorMemberName, row.AuthorAgentName)
	content := buildTeamContent(SourceKindComment, notify.CommentTypeDeliverable, author, "commented",
		row.IssueTitle, ident, s.AppURL, row.WorkspaceSlug)
	content.Body = truncateRunes(row.CommentContent, maxOutputRunes)
	content.Text += "\n\n" + content.Body
	ref := sourceRef{
		SourceKind:      SourceKindComment,
		CommentID:       refID,
		ParentCommentID: util.UUIDToString(row.CommentParentID),
		IssueID:         util.UUIDToString(row.CommentIssueID),
		IssueIdentifier: ident,
	}
	return s.insertSourceDecision(ctx, sourceDecision{
		scope: RouteSourceComment, workspaceID: wsID, sourceRefID: refID,
		routeID: row.RouteID, routeRevision: row.RouteRevision,
		sourceCreatedAt: row.CommentCreatedAt.Time, projectID: row.RouteProjectID,
		installationID: row.InstallationID, targetKey: row.TargetKey,
		kind: SourceKindComment, status: DeliveryStatusQueued,
		target: target, content: content, ref: ref,
	})
}

// ---- content builders ----

// buildInboxContent renders the personal forwarding message: the item's own
// title/body (exactly what the recipient already sees in their inbox) plus
// the issue link. No detail beyond the record is read.
func buildInboxContent(row db.ListLabrastroMessageInboxSourceCandidatesRow, issueIdent, appURL, workspaceSlug string) contentSnapshot {
	snap := contentSnapshot{
		SourceKind:      SourceKindInbox,
		Summary:         row.ItemTitle,
		IssueIdentifier: issueIdent,
	}
	var b strings.Builder
	b.WriteString(row.ItemTitle)
	if row.ItemBody.Valid && strings.TrimSpace(row.ItemBody.String) != "" {
		body := truncateRunes(strings.TrimSpace(row.ItemBody.String), maxOutputRunes)
		snap.Body = body
		b.WriteString("\n\n")
		b.WriteString(body)
	}
	if appURL != "" && workspaceSlug != "" && issueIdent != "" {
		snap.Link = strings.TrimRight(appURL, "/") + "/" + workspaceSlug + "/issues/" + issueIdent
	}
	snap.Text = b.String()
	return snap
}

// buildTeamContent renders the team-event message headline. Comment bodies
// are appended by the caller (they carry the comment text; activity events
// carry none).
func buildTeamContent(kind, action, actor, change, issueTitle, issueIdent, appURL, workspaceSlug string) contentSnapshot {
	snap := contentSnapshot{
		SourceKind:      kind,
		ActorName:       actor,
		Change:          change,
		IssueTitle:      issueTitle,
		IssueIdentifier: issueIdent,
	}
	headline := issueIdent
	if headline == "" {
		headline = issueTitle
	} else {
		headline += " " + issueTitle
	}
	verb := change
	if verb == "" {
		verb = action
	}
	who := actor
	if who != "" {
		who += " "
	}
	snap.Summary = who + verb + ": " + headline
	if appURL != "" && workspaceSlug != "" && issueIdent != "" {
		snap.Link = strings.TrimRight(appURL, "/") + "/" + workspaceSlug + "/issues/" + issueIdent
	}
	snap.Text = snap.Summary
	return snap
}
