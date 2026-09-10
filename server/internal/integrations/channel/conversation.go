package channel

import (
	"context"
	"encoding/json"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const ConversationOrigin = "channel_integration"

var ErrConversationDenied = errors.New("channel conversation authorization is unavailable")

// ConversationGrant is explicit consent to let these external conversations
// use the installation's agent and its normal tools in this workspace. It is
// unrelated to the external sender's optional notification-address binding.
// Every edit gets a new ID; old routes and queued runs cannot inherit new consent.
type ConversationGrant struct {
	ID           string               `json:"id"`
	AuthorizedBy string               `json:"authorized_by"`
	Scope        string               `json:"scope"`
	Chats        []ConversationTarget `json:"chats"`
}

type ConversationTarget struct {
	ChatID   string `json:"chat_id"`
	ChatType string `json:"chat_type"`
}

// ConversationConfig is also frozen in channel_task_delivery.config, so retry
// and authorization checks use the original consent, never today's replacement.
type ConversationConfig struct {
	ChatID string             `json:"chat_id,omitempty"`
	Grant  *ConversationGrant `json:"conversation,omitempty"`
}

func ParseConversationConfig(raw []byte) (ConversationConfig, error) {
	var cfg ConversationConfig
	if len(raw) == 0 {
		return cfg, nil
	}
	err := json.Unmarshal(raw, &cfg)
	return cfg, err
}

func AuthorizeConversation(ctx context.Context, q *db.Queries, inst db.ChannelInstallation, grant *ConversationGrant, chatID, chatType string) error {
	current, err := ParseConversationConfig(inst.Config)
	if err != nil || current.Grant == nil || grant == nil || current.Grant.ID != grant.ID ||
		current.Grant.AuthorizedBy != grant.AuthorizedBy || grant.Scope != "workspace" ||
		current.Grant.Scope != "workspace" || inst.ChannelType != string(TypeFeishu) || inst.Status != "active" ||
		!slices.Contains(current.Grant.Chats, ConversationTarget{ChatID: chatID, ChatType: chatType}) {
		return ErrConversationDenied
	}
	user, err := util.ParseUUID(grant.AuthorizedBy)
	if err != nil {
		return ErrConversationDenied
	}
	if _, err = q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: user, WorkspaceID: inst.WorkspaceID}); err != nil {
		return conversationLookupError(err)
	}
	agent, err := q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: inst.AgentID, WorkspaceID: inst.WorkspaceID})
	if err != nil {
		return conversationLookupError(err)
	}
	if agent.ArchivedAt.Valid {
		return ErrConversationDenied
	}
	// Same human invocation rule as handler.canInvokeAgent: ownership or an
	// explicit public_to target. Workspace administration grants no invoke bypass.
	if agent.OwnerID == user {
		return nil
	}
	if agent.PermissionMode == "public_to" {
		targets, err := q.ListAgentInvocationTargets(ctx, agent.ID)
		if err != nil {
			return err
		}
		for _, target := range targets {
			if target.TargetType == "workspace" || (target.TargetType == "member" && target.TargetID == user) {
				return nil
			}
		}
	}
	return ErrConversationDenied
}

func conversationLookupError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrConversationDenied
	}
	return err
}

// AuthorizeConversationTask follows existing retry/delegation provenance. A
// new direct human action has its own authorization. This check only adds live
// revocation for integration-origin work; normal task-token/agent gates still
// decide every operation. A bounded walk fails closed on broken/cyclic lineage.
func AuthorizeConversationTask(ctx context.Context, q *db.Queries, task db.AgentTaskQueue, workspaceID pgtype.UUID) error {
	originator := task.OriginatorUserID
	executingAgent := task.AgentID
	for range 64 {
		if task.OriginatorSource.String == ConversationOrigin {
			delivery, err := q.GetChannelTaskDelivery(ctx, task.ID)
			if err != nil {
				return conversationLookupError(err)
			}
			cfg, err := ParseConversationConfig(delivery.Config)
			if err != nil || cfg.Grant == nil || cfg.Grant.AuthorizedBy != util.UUIDToString(originator) {
				return ErrConversationDenied
			}
			inst, err := q.GetChannelInstallation(ctx, db.GetChannelInstallationParams{ID: delivery.InstallationID, ChannelType: string(TypeFeishu)})
			if err != nil {
				return conversationLookupError(err)
			}
			if inst.WorkspaceID != workspaceID || inst.AgentID != task.AgentID {
				return ErrConversationDenied
			}
			if err := AuthorizeConversation(ctx, q, inst, cfg.Grant, cfg.ChatID, delivery.ChatType); err != nil {
				return err
			}
			// A delegated target must still be invocable by this grantor. The
			// installation's consent never grants access to a second private agent.
			if executingAgent != inst.AgentID {
				inst.AgentID = executingAgent
				return AuthorizeConversation(ctx, q, inst, cfg.Grant, cfg.ChatID, delivery.ChatType)
			}
			return nil
		}
		parent := task.RetryOfTaskID
		if !parent.Valid && (task.OriginatorSource.String == "delegation" || task.OriginatorSource.String == "comment_source") {
			parent = task.DelegatedFromTaskID
		}
		if !parent.Valid {
			return nil
		}
		var err error
		task, err = q.GetAgentTask(ctx, parent)
		if err != nil {
			return conversationLookupError(err)
		}
	}
	return ErrConversationDenied
}
