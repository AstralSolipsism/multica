package handler

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestConversationEnqueueRevalidatesRevokedGrant(t *testing.T) {
	f := newConversationFixture(t)
	f.msg.ReplyTo = nil
	f.ingest(t)
	ctx := context.Background()
	root := f.task(t)
	session, err := f.h.Queries.GetChatSession(ctx, root.ChatSessionID)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := f.h.TaskService.PrepareChatTaskEnqueue(ctx, root.AgentID, root.OriginatorUserID)
	if err != nil {
		t.Fatal(err)
	}
	enqueue := func() error {
		tx, err := testPool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		_, err = f.h.TaskService.EnqueuePreparedChannelChatTaskInTx(ctx, tx, session, root.OriginatorUserID, false, root.ChannelContextRevision.Int64, prepared)
		return err
	}
	if err := enqueue(); err != nil {
		t.Fatalf("active grant must allow the same prepared enqueue: %v", err)
	}
	// Consent was valid at preparation and withdrawn before the enqueue
	// transaction. The frozen binding still contains the old grant.
	dbfx.Exec(t, "UPDATE channel_installation SET config=config-'conversation' WHERE id=$1", f.install)
	err = enqueue()
	if !errors.Is(err, channel.ErrConversationDenied) {
		t.Fatalf("enqueue accepted withdrawn consent: %v", err)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE agent_id=$1", f.agent); n != 1 {
		t.Fatalf("revoked enqueue persisted %d tasks", n)
	}
}

func TestConversationIngressRejectsReboundInstallation(t *testing.T) {
	for _, field := range []string{"agent", "workspace"} {
		t.Run(field, func(t *testing.T) {
			f := newConversationFixture(t)
			f.msg.ReplyTo = nil
			ctx := context.Background()
			resolved := engine.ResolvedInstallation{ID: parseUUID(f.install), WorkspaceID: parseUUID(testWorkspaceID), AgentID: parseUUID(f.agent)}
			if field == "agent" {
				agent := dbfx.Agent(t, "Rebound installation agent", f.runtime)
				dbfx.Exec(t, "UPDATE channel_installation SET agent_id=$2 WHERE id=$1", f.install, agent)
			} else {
				ws := dbfx.Workspace(t, "Rebound installation workspace", "rebound-"+f.install)
				dbfx.Member(t, ws, testUserID, "member")
				agent := dbfx.Agent(t, "Rebound workspace agent", f.runtime, testutil.Cols{"workspace_id": ws})
				dbfx.Exec(t, "UPDATE channel_installation SET workspace_id=$2,agent_id=$3 WHERE id=$1", f.install, ws, agent)
			}
			_, handled, err := f.h.HandleChannelConversation(ctx, resolved, f.msg, pgtype.UUID{}, false, false, 0)
			if err != nil || !handled {
				t.Fatalf("rebound installation was not refused: handled=%t err=%v", handled, err)
			}
			if n := dbfx.Count(t, "SELECT count(*) FROM channel_inbound_audit WHERE installation_id=$1 AND drop_reason='conversation_installation_changed'", f.install); n != 1 {
				t.Fatalf("missing explicit rebind rejection: %d", n)
			}
			if n := dbfx.Count(t, "SELECT count(*) FROM channel_chat_session_binding WHERE installation_id=$1", f.install); n != 0 {
				t.Fatalf("rebound installation created %d chat routes", n)
			}
			inst, err := f.h.Queries.GetChannelInstallation(ctx, db.GetChannelInstallationParams{ID: parseUUID(f.install), ChannelType: "feishu"})
			if err != nil {
				t.Fatal(err)
			}
			cfg, err := channel.ParseConversationConfig(inst.Config)
			if err != nil {
				t.Fatal(err)
			}
			// Prove the rebind fence was necessary: the new installation's grant
			// is independently valid and would otherwise admit the stale routing.
			if err := channel.AuthorizeConversation(ctx, f.h.Queries, inst, cfg.Grant, f.msg.Source.ChatID, "p2p"); err != nil {
				t.Fatalf("fixture grant is not valid after rebind: %v", err)
			}
		})
	}
}
