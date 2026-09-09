package messagedelivery

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// FeedbackMessage is evidence fetched using the pinned installation. Signature
// validity is evaluated by the transport, never from the inbound quoted text.
type FeedbackMessage struct {
	MessageID, ChatID    string
	Bot                  bool
	HasReference, Signed bool
	DeliveryID, SendUUID string
	ShardIndex           int32
}

type FeedbackTransport interface {
	ReadFeedbackMessage(context.Context, string, string, string) (FeedbackMessage, error)
	SendFeedbackNotice(context.Context, db.LabrastroMessageFeedback) error
}

var ErrFeedbackSource = errors.New("feedback source cannot be verified")

type FeedbackSource struct {
	Delivery                  db.LabrastroMessageDelivery
	IssueID, CommentID, RunID string
	Text, Link                string
}

// ResolveFeedbackSource returns nil only for a quote outside this module. A
// recognized but invalid source must not fall through into ordinary Chat.
func (s *Service) ResolveFeedbackSource(ctx context.Context, workspaceID, installationID pgtype.UUID, messageID, chatID string) (*FeedbackSource, error) {
	receipt, err := s.Queries.GetLabrastroFeedbackReceipt(ctx, db.GetLabrastroFeedbackReceiptParams{
		WorkspaceID: workspaceID, InstallationID: installationID, ExternalMessageID: pgtype.Text{String: messageID, Valid: true},
	})
	known := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if s.FeedbackTransport == nil {
		if known {
			return nil, ErrFeedbackSource
		}
		return nil, nil
	}
	proof, err := s.FeedbackTransport.ReadFeedbackMessage(ctx, util.UUIDToString(workspaceID), util.UUIDToString(installationID), messageID)
	if err != nil {
		// Retry transport failures. Falling through while the source is unknown
		// could turn a lost-receipt report into an ordinary Chat instruction.
		return nil, err
	}
	if !known && !proof.HasReference {
		return nil, nil
	}
	if !proof.Bot || proof.MessageID != messageID || proof.ChatID != chatID || (proof.HasReference && !proof.Signed) {
		return nil, ErrFeedbackSource
	}
	id := receipt.DeliveryID
	if !known {
		if !proof.Signed {
			return nil, ErrFeedbackSource
		}
		id, err = util.ParseUUID(proof.DeliveryID)
		if err != nil {
			return nil, ErrFeedbackSource
		}
	}
	d, err := s.Queries.GetLabrastroMessageDelivery(ctx, db.GetLabrastroMessageDeliveryParams{ID: id, WorkspaceID: workspaceID})
	if err != nil || d.InstallationID != installationID {
		return nil, ErrFeedbackSource
	}
	if d.SourceKind == SourceKindTestSend || d.SourceKind == SourceKindUnknown {
		return nil, ErrFeedbackSource
	}
	if !known {
		// Every send already persisted its shard/UUID before calling the provider.
		// Restore only that exact receipt; a missing shard is not guessed.
		rows, err := s.Queries.ListLabrastroMessageReceiptsByDelivery(ctx, db.ListLabrastroMessageReceiptsByDeliveryParams{DeliveryID: d.ID, WorkspaceID: workspaceID})
		if err != nil {
			return nil, err
		}
		found := false
		for _, r := range rows {
			if r.InstallationID != installationID || r.ShardIndex != proof.ShardIndex || r.SendUuid != proof.SendUUID {
				continue
			}
			if r.ExternalMessageID.Valid && r.ExternalMessageID.String != messageID {
				return nil, ErrFeedbackSource
			}
			if !r.ExternalMessageID.Valid {
				_, err = s.Queries.RecordLabrastroMessageReceiptExternalID(ctx, db.RecordLabrastroMessageReceiptExternalIDParams{ID: r.ID, ExternalMessageID: pgtype.Text{String: messageID, Valid: true}})
				if err != nil && !errors.Is(err, pgx.ErrNoRows) {
					return nil, err
				}
				// Another recovery may have won the first external ID, or teardown
				// may have removed the shard. Prove the result before using it.
				restored, err := s.Queries.GetLabrastroFeedbackReceipt(ctx, db.GetLabrastroFeedbackReceiptParams{WorkspaceID: workspaceID, InstallationID: installationID, ExternalMessageID: pgtype.Text{String: messageID, Valid: true}})
				if err != nil || restored.ID != r.ID {
					return nil, ErrFeedbackSource
				}
			}
			found = true
		}
		if !found {
			return nil, ErrFeedbackSource
		}
	}
	var ref sourceRef
	var snap contentSnapshot
	if json.Unmarshal(d.SourceRef, &ref) != nil || json.Unmarshal(d.ContentSnapshot, &snap) != nil {
		return nil, ErrFeedbackSource
	}
	scope := d.SourceScope.String
	if scope == "" && d.AutopilotID.Valid {
		scope = RouteSourceRun
	}
	if (scope == RouteSourceRun && d.SourceKind != SourceKindRunOnly && d.SourceKind != SourceKindCreateIssue) ||
		(scope != RouteSourceRun && (!IsSourceRouteScope(scope) || scope != d.SourceKind || ref.SourceKind != d.SourceKind)) {
		return nil, ErrFeedbackSource
	}
	return &FeedbackSource{Delivery: d, IssueID: ref.IssueID, CommentID: ref.CommentID, RunID: ref.RunID, Text: snap.Text, Link: snap.Link}, nil
}

// AuthorizeFeedbackTarget checks frozen recipient/range consent with the same
// approval predicates as sending. Member and issue authorization is separate.
func AuthorizeFeedbackTarget(ctx context.Context, q *db.Queries, d db.LabrastroMessageDelivery, userID pgtype.UUID, chatID string) error {
	var snap targetSnapshot
	if json.Unmarshal(d.TargetSnapshot, &snap) != nil {
		return ErrFeedbackSource
	}
	if snap.TargetType == TargetMember {
		if snap.UserID != util.UUIDToString(userID) {
			return ErrFeedbackSource
		}
		return nil
	}
	if (snap.TargetType != TargetGroup && snap.TargetType != TargetTopic) || snap.ChatID != chatID {
		return ErrFeedbackSource
	}
	if d.AutopilotID.Valid {
		return targetApprovedWith(ctx, q, d.WorkspaceID, d.AutopilotID, d.InstallationID, snap.TargetKeyFor())
	}
	return sourceTargetApprovedWith(ctx, q, d.WorkspaceID, d.SourceScope.String, d.SourceProjectID, d.InstallationID, snap.TargetKeyFor())
}
