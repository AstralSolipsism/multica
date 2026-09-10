package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Invocation equivalence applies after conversation-specific membership,
// installation and archive checks, and only to a real human grantor.
func TestConversationInvocationMatchesMemberGate(t *testing.T) {
	for _, tc := range []struct {
		name, role, mode, target string
		owner, allowed           bool
	}{
		{"owner_private", "member", "private", "", true, true},
		{"owner_public_to_empty", "member", "public_to", "", true, true},
		{"private_member", "member", "private", "", false, false},
		{"private_admin", "admin", "private", "", false, false},
		{"private_workspace_owner", "owner", "private", "", false, false},
		{"public_to_empty", "member", "public_to", "", false, false},
		{"workspace_target", "member", "public_to", "workspace", false, true},
		{"member_target", "member", "public_to", "member", false, true},
		{"other_member_target", "member", "public_to", "other_member", false, false},
		{"reserved_team_target", "member", "public_to", "team", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newConversationFixture(t)
			grantor := dbfx.User(t, "Grantor", f.install+"@grantor.test")
			dbfx.Member(t, testWorkspaceID, grantor, tc.role)
			owner := testUserID
			if tc.owner {
				owner = grantor
			}
			dbfx.Exec(t, `UPDATE agent SET owner_id=$2, permission_mode=$3 WHERE id=$1`, f.agent, owner, tc.mode)
			dbfx.Exec(t, `UPDATE channel_installation SET config=jsonb_set(config,'{conversation,authorized_by}',to_jsonb($2::text)) WHERE id=$1`, f.install, grantor)
			if tc.target != "" {
				targetType, targetID := tc.target, grantor
				switch tc.target {
				case "workspace", "team":
					targetID = testWorkspaceID
				case "other_member":
					targetType, targetID = "member", testUserID
				}
				dbfx.Insert(t, "agent_invocation_target", testutil.Cols{"agent_id": f.agent, "target_type": targetType, "target_id": targetID})
			}
			ctx := context.Background()
			agent, err := f.h.Queries.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: parseUUID(f.agent), WorkspaceID: parseUUID(testWorkspaceID)})
			if err != nil {
				t.Fatal(err)
			}
			inst, err := f.h.Queries.GetChannelInstallation(ctx, db.GetChannelInstallationParams{ID: parseUUID(f.install), ChannelType: "feishu"})
			if err != nil {
				t.Fatal(err)
			}
			cfg, err := channel.ParseConversationConfig(inst.Config)
			if err != nil {
				t.Fatal(err)
			}
			memberAllowed := f.h.canInvokeAgent(ctx, agent, "member", grantor, "", testWorkspaceID)
			err = channel.AuthorizeConversation(ctx, f.h.Queries, inst, cfg.Grant, "oc_feedback", "p2p")
			if err != nil && !errors.Is(err, channel.ErrConversationDenied) {
				t.Fatal(err)
			}
			if memberAllowed != tc.allowed || (err == nil) != memberAllowed {
				t.Fatalf("expected=%v member=%v conversation=%v", tc.allowed, memberAllowed, err)
			}
		})
	}
}

func TestConversationLineageBoundaries(t *testing.T) {
	f := newConversationFixture(t)
	f.msg.ReplyTo = nil
	f.ingest(t)
	root := f.task(t)
	ctx := context.Background()
	for _, source := range []string{"retry", "delegation", "comment_source"} {
		t.Run(source, func(t *testing.T) {
			head := root
			for depth := 2; depth <= 65; depth++ {
				parentColumn := "delegated_from_task_id"
				if source == "retry" {
					parentColumn = "retry_of_task_id"
				}
				id := dbfx.Task(t, f.agent, testutil.Cols{parentColumn: head.ID, "runtime_id": root.RuntimeID, "originator_source": source, "originator_user_id": testUserID, "accountable_user_id": testUserID})
				var err error
				head, err = f.h.Queries.GetAgentTask(ctx, parseUUID(id))
				if err != nil {
					t.Fatal(err)
				}
				if depth < 64 {
					continue
				}
				err = channel.AuthorizeConversationTask(ctx, f.h.Queries, head, parseUUID(testWorkspaceID))
				if (depth == 64 && err != nil) || (depth == 65 && !errors.Is(err, channel.ErrConversationDenied)) {
					t.Fatalf("depth %d: %v", depth, err)
				}
			}
		})
	}
	for _, missing := range []bool{false, true} {
		id := dbfx.Task(t, f.agent, testutil.Cols{"runtime_id": root.RuntimeID, "originator_source": "retry", "originator_user_id": testUserID, "accountable_user_id": testUserID})
		parent := id
		if missing {
			parent = f.install // A valid UUID that is not a task.
		}
		dbfx.Exec(t, `UPDATE agent_task_queue SET retry_of_task_id=$2 WHERE id=$1`, id, parent)
		task, err := f.h.Queries.GetAgentTask(ctx, parseUUID(id))
		if err != nil {
			t.Fatal(err)
		}
		if err := channel.AuthorizeConversationTask(ctx, f.h.Queries, task, parseUUID(testWorkspaceID)); !errors.Is(err, channel.ErrConversationDenied) {
			t.Fatalf("missing=%v lineage should fail closed: %v", missing, err)
		}
	}
	// A new human action is independently authorized even when its historical
	// delegation anchor is no longer readable. No database access is needed.
	if err := channel.AuthorizeConversationTask(ctx, nil, db.AgentTaskQueue{
		OriginatorSource:    pgtype.Text{String: "direct_human", Valid: true},
		DelegatedFromTaskID: root.ID,
	}, parseUUID(testWorkspaceID)); err != nil {
		t.Fatal(err)
	}
}

type conversationLookupFault struct {
	db.DBTX
	query string
}

func (f conversationLookupFault) QueryRow(ctx context.Context, query string, args ...any) pgx.Row {
	if strings.Contains(query, "-- name: "+f.query+" ") {
		return conversationLookupErrorRow{}
	}
	return f.DBTX.QueryRow(ctx, query, args...)
}

type conversationLookupErrorRow struct{}

func (conversationLookupErrorRow) Scan(...any) error { return errors.New("injected database failure") }

func TestConversationTaskTokenLookupFailures(t *testing.T) {
	for _, tc := range []struct {
		name, query string
		external    bool
		status      int
	}{
		{"direct_task_read_failure", "GetAgentTask", false, http.StatusServiceUnavailable},
		{"external_task_read_failure", "GetAgentTask", true, http.StatusServiceUnavailable},
		{"external_grant_read_failure", "GetChannelInstallation", true, http.StatusServiceUnavailable},
		{"direct_skips_grant_read", "GetChannelInstallation", false, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newConversationFixture(t)
			f.msg.ReplyTo = nil
			f.ingest(t)
			task := f.task(t)
			if !tc.external {
				dbfx.Exec(t, `UPDATE agent_task_queue SET originator_source='direct_human' WHERE id=$1`, task.ID)
			}
			token := f.token(t, task)
			req := httptest.NewRequest(http.MethodGet, "/api/issues/"+f.issue, nil)
			req.Header.Set("Authorization", "Bearer "+token)
			q := db.New(conversationLookupFault{DBTX: testPool, query: tc.query})
			testutil.Call(t, middleware.Auth(q, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			})).ServeHTTP, req).Want(tc.status)
		})
	}
}
