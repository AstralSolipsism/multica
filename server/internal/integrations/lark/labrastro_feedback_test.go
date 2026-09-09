package lark

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/messagedelivery"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Exercise the production sender, real HTTP normalization, encrypted bot
// credentials and PostgreSQL receipt recovery together. Only Feishu is fake.
func TestFeedbackSignedSourceRecoveryThroughHTTPAndDatabase(t *testing.T) {
	ctx := context.Background()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL required")
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	fx := testutil.New(pool, "", "")
	suffix := uuid.NewString()
	fx.UserID = fx.User(t, "Feedback sender", "feedback-"+suffix+"@test.invalid")
	fx.WorkspaceID = fx.Workspace(t, "Feedback source", "feedback-"+suffix)
	fx.Member(t, fx.WorkspaceID, fx.UserID, "owner")
	agent := fx.Agent(t, "Feedback bot", "")
	q := db.New(pool)
	box, err := secretbox.New([]byte(strings.Repeat("f", 32)))
	if err != nil {
		t.Fatal(err)
	}
	installs, err := NewInstallationService(q, box)
	if err != nil {
		t.Fatal(err)
	}
	inst, err := installs.Upsert(ctx, InstallationParams{WorkspaceID: util.MustParseUUID(fx.WorkspaceID), AgentID: util.MustParseUUID(agent), InstallerUserID: util.MustParseUUID(fx.UserID), AppID: "cli_feedback_http_" + suffix, AppSecret: "test-only-feedback-secret", BotOpenID: "ou_bot"})
	if err != nil {
		t.Fatal(err)
	}
	install := util.UUIDToString(inst.ID)
	fx.Cleanup(t, `DELETE FROM channel_installation WHERE id=$1`, install)
	issue := fx.Issue(t, "Feedback source issue")
	comment := fx.Comment(t, issue, "Frozen result")
	delivery := fx.Insert(t, "labrastro_message_delivery", testutil.Cols{"id": testutil.Raw("gen_random_uuid()"), "workspace_id": fx.WorkspaceID, "installation_id": install, "source_kind": "comment", "source_scope": "comment", "source_ref_id": comment, "source_ref": `{"source_kind":"comment","issue_id":"` + issue + `","comment_id":"` + comment + `"}`, "status": "uncertain", "dedup_key": suffix, "target_key": "member:" + fx.UserID, "target_snapshot": `{"target_type":"member","user_id":"` + fx.UserID + `"}`, "content_snapshot": `{"text":"Frozen result"}`, "shard_total": 1})
	receipt := fx.Insert(t, "labrastro_message_receipt", testutil.Cols{"delivery_id": delivery, "workspace_id": fx.WorkspaceID, "installation_id": install, "shard_index": 0, "shard_total": 1, "send_uuid": suffix})
	fake := newLarkFake(t)
	fake.stubToken("test-only-token", 3600)
	var content string
	fake.stubSend(map[string]any{"code": 0, "data": map[string]string{"message_id": "om_result"}}, func(_ *http.Request, body map[string]string) {
		content = body["content"]
		if body["uuid"] != suffix {
			t.Error("missing fixed send UUID")
		}
	})
	botID, senderType, chatID := inst.AppID, "app", "oc_feedback"
	deleted := false
	fake.mux.HandleFunc("/open-apis/im/v1/messages/om_result", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Error("feedback proof must fetch platform message")
		}
		writeJSON(w, map[string]any{"code": 0, "data": map[string]any{"items": []any{map[string]any{"message_id": "om_result", "chat_id": chatID, "msg_type": "text", "deleted": deleted, "sender": map[string]string{"id": botID, "sender_type": senderType, "id_type": "app_id"}, "body": map[string]string{"content": content}}}}})
	})
	sender := NewDeliverySender(installs, NewHTTPAPIClient(HTTPClientConfig{BaseURL: fake.URL()}).(DeliveryAPIClient))
	_, err = sender.Send(ctx, messagedelivery.SendRequest{DeliveryID: delivery, WorkspaceID: fx.WorkspaceID, InstallationID: install, SourceURL: "https://example.test/source", Target: messagedelivery.Target{Type: messagedelivery.TargetMember, OpenID: "ou_member"}, Text: "Frozen result", SendUUID: suffix, ShardTotal: 1})
	if err != nil {
		t.Fatal(err)
	}
	savedContent := content
	svc := messagedelivery.New(q)
	svc.FeedbackTransport = sender
	resolve := func() (*messagedelivery.FeedbackSource, error) {
		return svc.ResolveFeedbackSource(ctx, inst.WorkspaceID, inst.ID, "om_result", "oc_feedback")
	}
	source, err := resolve()
	if err != nil || source == nil || source.IssueID != issue || source.CommentID != comment {
		t.Fatalf("valid signed source failed: %+v/%v", source, err)
	}
	if n := fx.Count(t, `SELECT count(*) FROM labrastro_message_receipt WHERE id=$1 AND external_message_id='om_result'`, receipt); n != 1 {
		t.Fatal("lost local receipt was not restored")
	}
	for _, kind := range []string{"tampered", "human_copy", "other_bot", "other_chat", "deleted", "rebound", "missing_shard"} {
		t.Run(kind, func(t *testing.T) {
			content, botID, senderType, chatID, deleted = savedContent, inst.AppID, "app", "oc_feedback", false
			fx.Exec(t, `UPDATE labrastro_message_receipt SET external_message_id=NULL WHERE id=$1`, receipt)
			switch kind {
			case "tampered":
				content = strings.Replace(content, delivery, uuid.NewString(), 1)
			case "human_copy":
				senderType = "user"
			case "other_bot":
				botID = "cli_other"
			case "other_chat":
				chatID = "oc_other"
			case "deleted":
				deleted = true
			case "rebound":
				other := fx.Agent(t, "Replacement bot", "")
				fx.Exec(t, `UPDATE channel_installation SET agent_id=$2 WHERE id=$1`, install, other)
				t.Cleanup(func() { fx.Exec(t, `UPDATE channel_installation SET agent_id=$2 WHERE id=$1`, install, agent) })
			case "missing_shard":
				fx.Exec(t, `UPDATE labrastro_message_receipt SET send_uuid='other-shard' WHERE id=$1`, receipt)
			}
			source, err := resolve()
			if source != nil || !errors.Is(err, messagedelivery.ErrFeedbackSource) {
				t.Fatalf("untrusted proof routed: %+v/%v", source, err)
			}
			if n := fx.Count(t, `SELECT count(*) FROM labrastro_message_receipt WHERE id=$1 AND external_message_id IS NOT NULL`, receipt); n != 0 {
				t.Fatal("invalid proof restored a receipt")
			}
		})
	}
	// Never include credentials in the transported signature or source link.
	var sent struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(savedContent), &sent); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sent.Text, "test-only-feedback-secret") || !strings.Contains(sent.Text, feedbackFragment) {
		t.Fatal("invalid public provenance link")
	}
}
