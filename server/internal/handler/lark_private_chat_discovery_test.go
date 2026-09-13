package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func newPrivateChatFixture(t *testing.T) *conversationFixture {
	t.Helper()
	wireLarkInstallServices(t)
	f := newConversationFixture(t)
	dbfx.Exec(t, `UPDATE agent SET name='Private discovery ' || id::text WHERE id=$1`, f.agent)
	_, err := f.h.LarkInstallations.Upsert(context.Background(), lark.InstallationParams{WorkspaceID: parseUUID(testWorkspaceID),
		AgentID: parseUUID(f.agent), AppID: f.app, AppSecret: "private-test-secret", BotOpenID: "ou_bot", InstallerUserID: parseUUID(testUserID)})
	if err != nil {
		t.Fatal(err)
	}
	dbfx.Exec(t, `DELETE FROM channel_user_binding WHERE id=$1`, f.binding)
	f.msg.ReplyTo = nil
	f.msg.Text, f.msg.CommandText = "private body must not be stored", "private body must not be stored"
	f.privateSource(t, nil)
	return f
}

func (f *conversationFixture) privateSource(t *testing.T, change func(*lark.InboundMessage)) {
	t.Helper()
	source := lark.InboundMessage{InstallationID: parseUUID(f.install), AppID: f.app, EventID: f.msg.EventID,
		EventType: "im.message.receive_v1", MessageID: f.msg.MessageID, ChatID: lark.ChatID(f.msg.Source.ChatID),
		ChatType: lark.ChatType(f.msg.Source.ChatType), SenderType: "user", SenderOpenID: lark.OpenID(f.msg.Source.SenderID),
		CreateTime: strconv.FormatInt(time.Now().Add(-time.Minute).UnixMilli(), 10)}
	if change != nil {
		change(&source)
	}
	f.msg.Raw, _ = json.Marshal(source)
}

func (f *conversationFixture) privateRequest(user, method, body string) *http.Request {
	r := newRequestAs(user, method, "/api/workspaces/"+testWorkspaceID+"/lark/installations/"+f.install+"/private-chat-candidates", json.RawMessage(body))
	return withURLParams(r, "id", testWorkspaceID, "installationId", f.install)
}

func (f *conversationFixture) privateCandidates(t *testing.T) []larkPrivateChatCandidateResponse {
	t.Helper()
	var response struct {
		Items []larkPrivateChatCandidateResponse `json:"items"`
	}
	r := testutil.Call(t, f.h.ListLarkPrivateChatCandidates, f.privateRequest(testUserID, "GET", "")).Want(200).JSON(&response)
	if r.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private discovery is cacheable")
	}
	return response.Items
}

func (f *conversationFixture) confirmPrivate(t *testing.T, ids ...string) channel.ConversationGrant {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"scope": "workspace", "candidate_ids": ids})
	var saved struct {
		Conversation channel.ConversationGrant `json:"conversation"`
	}
	testutil.Call(t, f.h.ConfirmLarkPrivateChatCandidates, f.privateRequest(testUserID, "POST", string(raw))).Want(200).JSON(&saved)
	return saved.Conversation
}

// The connector stand-in decodes a documented event shape through the real
// factory, connection-bound emitter, normalizer, dedup and conversation handler.
type privateChatEventConnector struct{ payload []byte }

func (c privateChatEventConnector) Run(ctx context.Context, inst lark.Installation, emit lark.EventEmitter) error {
	msg, ok, err := lark.NewLarkJSONFrameDecoder().Decode(c.payload, inst)
	if err != nil || !ok {
		return err
	}
	_, err = emit(ctx, msg)
	return err
}

func TestPrivateChatDiscoveryConsentLifecycle(t *testing.T) {
	f := newPrivateChatFixture(t)
	registry := channel.NewRegistry()
	connector := privateChatEventConnector{payload: []byte(fmt.Sprintf(`{"schema":"2.0","header":{"event_id":"evt_input","event_type":"im.message.receive_v1","app_id":%q},"event":{"sender":{"sender_id":{"open_id":"ou_feedback"},"sender_type":"user"},"message":{"message_id":"om_input","chat_id":"oc_feedback","chat_type":"p2p","message_type":"text","create_time":%q,"content":"{\"text\":\"private body must not be stored\"}"}}}`, f.app, strconv.FormatInt(time.Now().UnixMilli(), 10)))}
	lark.RegisterFeishu(registry, lark.FeishuChannelDeps{Connector: connector})
	inst, err := f.h.Queries.GetChannelInstallation(context.Background(), db.GetChannelInstallationParams{ID: parseUUID(f.install), ChannelType: "feishu"})
	if err != nil {
		t.Fatal(err)
	}
	transport, err := registry.Build(channel.Config{Type: channel.TypeFeishu, ID: inst.ID, Raw: inst.Config, Handler: f.router(t).Handle})
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := transport.Connect(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	items := f.privateCandidates(t)
	if len(items) != 1 || items[0].Sender.ID != "ou_feedback" || items[0].ChatID != "oc_feedback" || items[0].AuthorizationStatus != "pending" {
		t.Fatalf("wrong candidate: %+v", items)
	}
	if inputs, runs, comments := f.counts(t); inputs != 0 || runs != 0 || comments != 0 {
		t.Fatal("discovery triggered an agent or stored a body")
	}
	var config string
	dbfx.QueryRow(t, `SELECT config::text FROM channel_installation WHERE id=$1`, f.install).Scan(&config)
	for _, forbidden := range []string{f.msg.Text, "om_input", "evt_input", "content", "union_id"} {
		if strings.Contains(config, forbidden) {
			t.Fatalf("candidate stored unnecessary data %q", forbidden)
		}
	}
	// Preserve a previously saved group while appending the selected private chat.
	testutil.Call(t, f.h.SetLarkConversationGrant, f.privateRequest(testUserID, "PUT", `{"scope":"workspace","chats":[{"chat_id":"oc_existing","chat_type":"group"}]}`)).Want(200)
	grant := f.confirmPrivate(t, items[0].ID)
	if grant.AuthorizedBy != testUserID || len(grant.Chats) != 2 || !slices.Contains(grant.Chats, channel.ConversationTarget{ChatID: "oc_existing", ChatType: "group"}) {
		t.Fatalf("confirmation replaced consent or existing targets: %+v", grant)
	}
	if retried := f.confirmPrivate(t, items[0].ID); retried.ID != grant.ID {
		t.Fatal("confirmation retry invalidated existing runs")
	}
	if got := f.privateCandidates(t)[0].AuthorizationStatus; got != "authorized" {
		t.Fatalf("authorization status = %s", got)
	}
	// The original rejected event stays deduplicated even after confirmation.
	f.ingest(t)
	f.msg.MessageID = "om_authorized"
	f.privateSource(t, nil)
	f.ingest(t)
	if inputs, runs, _ := f.counts(t); inputs != 1 || runs != 1 {
		t.Fatalf("confirmed conversation inputs/runs = %d/%d", inputs, runs)
	}
	testutil.Call(t, f.h.SetLarkConversationGrant, f.privateRequest(testUserID, "PUT", `{"scope":"workspace","chats":[]}`)).Want(200)
	f.msg.MessageID = "om_after_revoke"
	f.privateSource(t, nil)
	f.ingest(t)
	if inputs, runs, _ := f.counts(t); inputs != 1 || runs != 1 {
		t.Fatal("revoked conversation ran")
	}
	if err := channel.AuthorizeConversationTask(context.Background(), f.h.Queries, f.task(t), parseUUID(testWorkspaceID)); err == nil {
		t.Fatal("revoked grant still authorizes task tools")
	}
}

func TestPrivateChatDiscoveryRejectsInvalidEvents(t *testing.T) {
	for _, scenario := range []string{"group", "user_id_as_chat", "no_connection", "wrong_connection", "wrong_app", "bot_sender", "no_sender_type", "source_mismatch", "bad_sender", "bad_message", "expired_event", "future_event", "invalid_time", "revoked", "archived"} {
		t.Run(scenario, func(t *testing.T) {
			f := newPrivateChatFixture(t)
			if scenario == "group" {
				f.msg.Source.ChatType = channel.ChatTypeGroup
			}
			if scenario == "user_id_as_chat" {
				f.msg.Source.ChatID = "ou_feedback"
			}
			f.privateSource(t, func(s *lark.InboundMessage) {
				switch scenario {
				case "no_connection":
					s.InstallationID.Valid = false
				case "wrong_connection":
					s.InstallationID = dbid.NewV7()
				case "wrong_app":
					s.AppID = "cli_not_this_bot"
				case "bot_sender":
					s.SenderType = "bot"
				case "no_sender_type":
					s.SenderType = ""
				case "source_mismatch":
					s.ChatID = "oc_forged"
				case "bad_sender":
					s.SenderOpenID = "ou_"
				case "bad_message":
					s.MessageID = "om_"
				case "expired_event":
					s.CreateTime = strconv.FormatInt(time.Now().Add(-8*24*time.Hour).UnixMilli(), 10)
				case "future_event":
					s.CreateTime = strconv.FormatInt(time.Now().Add(time.Hour).UnixMilli(), 10)
				case "invalid_time":
					s.CreateTime = "invalid"
				}
			})
			if scenario == "revoked" {
				dbfx.Exec(t, `UPDATE channel_installation SET status='revoked' WHERE id=$1`, f.install)
			}
			if scenario == "archived" {
				dbfx.Exec(t, `UPDATE agent SET archived_at=now() WHERE id=$1`, f.agent)
			}
			f.ingest(t)
			if n := dbfx.Count(t, `SELECT jsonb_array_length(COALESCE(config->'private_chat_candidates','[]'::jsonb)) FROM channel_installation WHERE id=$1`, f.install); n != 0 {
				t.Fatalf("invalid event created %d candidates", n)
			}
			if inputs, runs, _ := f.counts(t); inputs != 0 || runs != 0 {
				t.Fatal("invalid event triggered a run")
			}
		})
	}
}

func TestPrivateChatDiscoveryAuthorizationIsolationAndLimits(t *testing.T) {
	f := newPrivateChatFixture(t)
	f.ingest(t)
	items := f.privateCandidates(t)
	if len(items) != 1 {
		t.Fatal("missing candidate")
	}
	body := fmt.Sprintf(`{"scope":"workspace","candidate_ids":[%q]}`, items[0].ID)
	member := dbfx.User(t, "Private chat member", f.install+"@private.test")
	dbfx.Member(t, testWorkspaceID, member, "member")
	for _, endpoint := range []struct {
		method string
		fn     http.HandlerFunc
	}{{"GET", f.h.ListLarkPrivateChatCandidates}, {"POST", f.h.ConfirmLarkPrivateChatCandidates}} {
		testutil.Call(t, endpoint.fn, f.privateRequest("", endpoint.method, body)).Want(401)
		testutil.Call(t, endpoint.fn, f.privateRequest(member, endpoint.method, body)).Want(403)
		for _, actor := range []string{"task_token", "cloud_pat"} {
			r := f.privateRequest(testUserID, endpoint.method, body)
			r.Header.Set("X-Actor-Source", actor)
			testutil.Call(t, endpoint.fn, r).Want(403)
		}
		other := dbfx.Workspace(t, "Other workspace", "private-"+uuidToString(dbid.NewV7()))
		dbfx.Member(t, other, testUserID, "owner")
		r := withURLParams(f.privateRequest(testUserID, endpoint.method, body), "id", other, "installationId", f.install)
		testutil.Call(t, endpoint.fn, r).Want(404)
	}
	// Member-visible installation listing never becomes a candidate directory.
	listed := testutil.Call(t, f.h.ListLarkInstallations, f.privateRequest(member, "GET", "")).Want(200).Text()
	if strings.Contains(listed, items[0].ID) || strings.Contains(listed, "ou_feedback") {
		t.Fatal("installation list leaked private candidate identities")
	}
	otherBot := newPrivateChatFixture(t)
	if len(otherBot.privateCandidates(t)) != 0 {
		t.Fatal("bots shared candidate storage")
	}
	testutil.Call(t, otherBot.h.ConfirmLarkPrivateChatCandidates, otherBot.privateRequest(testUserID, "POST", body)).Want(410)
	// Workspace management alone never bypasses private-agent invocation.
	dbfx.Exec(t, `UPDATE agent SET owner_id=$2,permission_mode='private' WHERE id=$1`, f.agent, member)
	testutil.Call(t, f.h.ConfirmLarkPrivateChatCandidates, f.privateRequest(testUserID, "POST", body)).Want(403)
	testutil.Call(t, f.h.ConfirmLarkPrivateChatCandidates, f.privateRequest(member, "POST", body)).Want(200)
	dbfx.Exec(t, `UPDATE agent SET owner_id=$2 WHERE id=$1`, f.agent, testUserID)
	chats := make([]channel.ConversationTarget, 50)
	for i := range chats {
		chats[i] = channel.ConversationTarget{ChatID: fmt.Sprintf("oc_group_%d", i), ChatType: "group"}
	}
	raw, _ := json.Marshal(map[string]any{"scope": "workspace", "chats": chats})
	testutil.Call(t, f.h.SetLarkConversationGrant, f.privateRequest(testUserID, "PUT", string(raw))).Want(200)
	testutil.Call(t, f.h.ConfirmLarkPrivateChatCandidates, f.privateRequest(testUserID, "POST", body)).Want(409)
	var saved int
	dbfx.QueryRow(t, `SELECT jsonb_array_length(config->'conversation'->'chats') FROM channel_installation WHERE id=$1`, f.install).Scan(&saved)
	if saved != 50 {
		t.Fatal("limit failure changed the saved grant")
	}
	dbfx.Exec(t, `UPDATE channel_installation SET config=jsonb_set(config,'{private_chat_candidates,0,last_seen_at}',to_jsonb($2::text)) WHERE id=$1`, f.install, time.Now().Add(-8*24*time.Hour).Format(time.RFC3339Nano))
	testutil.Call(t, f.h.ConfirmLarkPrivateChatCandidates, f.privateRequest(testUserID, "POST", body)).Want(410)
	if got := f.privateCandidates(t); len(got) != 0 {
		t.Fatal("expired candidate returned")
	}
	if n := dbfx.Count(t, `SELECT jsonb_array_length(config->'private_chat_candidates') FROM channel_installation WHERE id=$1`, f.install); n != 0 {
		t.Fatal("read did not prune expired data")
	}
}

func TestPrivateChatDiscoveryBoundedConcurrentWrites(t *testing.T) {
	f := newPrivateChatFixture(t)
	resolved := engine.ResolvedInstallation{ID: parseUUID(f.install), WorkspaceID: parseUUID(testWorkspaceID), AgentID: parseUUID(f.agent)}
	var wg sync.WaitGroup
	for i := range 60 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			copy := *f
			copy.msg.Source.ChatID = fmt.Sprintf("oc_private_%d", i)
			copy.msg.MessageID = fmt.Sprintf("om_private_%d", i)
			copy.privateSource(t, nil)
			if err := copy.h.recordLarkPrivateChatCandidate(context.Background(), resolved, copy.msg); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	items := f.privateCandidates(t)
	if len(items) != 50 {
		t.Fatalf("candidate cap = %d", len(items))
	}
	for _, item := range items[:12] {
		wg.Add(1)
		go func() { defer wg.Done(); f.confirmPrivate(t, item.ID) }()
	}
	wg.Wait()
	if n := dbfx.Count(t, `SELECT jsonb_array_length(config->'conversation'->'chats') FROM channel_installation WHERE id=$1`, f.install); n != 12 {
		t.Fatal("parallel confirmation lost a target")
	}
	if err := f.h.LarkInstallations.Revoke(context.Background(), parseUUID(f.install)); err != nil {
		t.Fatal(err)
	}
	if n := dbfx.Count(t, `SELECT count(*) FROM channel_installation WHERE id=$1 AND config ? 'private_chat_candidates'`, f.install); n != 0 {
		t.Fatal("installation revocation retained private observations")
	}
	testutil.Call(t, f.h.ListLarkPrivateChatCandidates, f.privateRequest(testUserID, "GET", "")).Want(409)
	body := fmt.Sprintf(`{"scope":"workspace","candidate_ids":[%q]}`, items[0].ID)
	testutil.Call(t, f.h.ConfirmLarkPrivateChatCandidates, f.privateRequest(testUserID, "POST", body)).Want(409)
}

func TestPrivateChatDiscoveryNamesUseScopedRealTransport(t *testing.T) {
	f := newPrivateChatFixture(t)
	f.ingest(t)
	var calls atomic.Int32
	var reply atomic.Value
	reply.Store(`{"code":0,"data":{"items":[{"open_id":"ou_feedback","name":" Alice\n Example ","email":"never-return@example.test"},{"open_id":"ou_stranger","name":"Not this user"}]}}`)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path == "/open-apis/auth/v3/tenant_access_token/internal" {
			var credentials map[string]string
			_ = json.NewDecoder(r.Body).Decode(&credentials)
			if credentials["app_id"] != f.app || credentials["app_secret"] != "private-test-secret" {
				t.Error("wrong bot credentials")
			}
			fmt.Fprint(w, `{"code":0,"tenant_access_token":"private-test-token","expire":7200}`)
			return
		}
		if r.Method != "GET" || r.URL.Path != "/open-apis/contact/v3/users/batch" || r.URL.Query().Get("user_id_type") != "open_id" || !slices.Equal(r.URL.Query()["user_ids"], []string{"ou_feedback"}) {
			t.Errorf("unexpected provider request: %s %s", r.Method, r.URL.Path)
		}
		fmt.Fprint(w, reply.Load().(string))
	}))
	defer provider.Close()
	f.h.LarkAPIClient = lark.NewHTTPAPIClient(lark.HTTPClientConfig{BaseURL: provider.URL})
	member := dbfx.User(t, "No name access", f.install+"@noaccess.test")
	dbfx.Member(t, testWorkspaceID, member, "member")
	testutil.Call(t, f.h.ListLarkPrivateChatCandidates, f.privateRequest(member, "GET", "")).Want(403)
	if calls.Load() != 0 {
		t.Fatal("unauthorized read contacted provider")
	}
	got := f.privateCandidates(t)
	if len(got) != 1 || got[0].DisplayName != "Alice Example" || got[0].IdentityStatus != "name_available" {
		t.Fatalf("identity = %+v", got)
	}
	for _, degraded := range []string{`{"code":99991672,"msg":"private-test-token"}`, `{"code":0,"data":{"items":[]}}`, `{"secret`, `{}`} {
		reply.Store(degraded)
		got = f.privateCandidates(t)
		if len(got) != 1 || got[0].DisplayName != "" || got[0].IdentityStatus != "id_only" {
			t.Fatalf("lookup failure invented identity: %+v", got)
		}
	}
	var config string
	dbfx.QueryRow(t, `SELECT config::text FROM channel_installation WHERE id=$1`, f.install).Scan(&config)
	if strings.Contains(config, "Alice") || strings.Contains(config, "never-return") || strings.Contains(config, "private-test-token") {
		t.Fatal("optional contact data persisted")
	}
}

func TestPrivateChatDiscoveryRetriesExpiryAndReinstallation(t *testing.T) {
	f := newPrivateChatFixture(t)
	f.h.TxStarter = &feedbackFaultStarter{txStarter: testPool, commit: true}
	if err := f.router(t).Handle(context.Background(), f.msg); err == nil {
		t.Fatal("missing commit acknowledgement was hidden")
	}
	before := f.privateCandidates(t)
	if len(before) != 1 {
		t.Fatal("lost acknowledgement did not leave durable observation")
	}
	f.ingest(t)
	after := f.privateCandidates(t)
	if len(after) != 1 || after[0].ID != before[0].ID || after[0].LastSeenAt != before[0].LastSeenAt {
		t.Fatal("retry duplicated candidate or renewed expiry")
	}
	for _, body := range []string{
		`{`, `{"scope":"workspace","candidate_ids":[]}`, `{"scope":"other","candidate_ids":[]}`,
		`{"scope":"workspace","candidate_ids":["not-a-uuid"]}`,
		fmt.Sprintf(`{"scope":"workspace","candidate_ids":[%q,%q]}`, before[0].ID, before[0].ID),
		fmt.Sprintf(`{"scope":"workspace","candidate_ids":[%q],"authorized_by":"forged"}`, before[0].ID),
		fmt.Sprintf(`{"scope":"workspace","candidate_ids":[%q],"chats":[{"chat_id":"oc_forged","chat_type":"p2p"}]}`, before[0].ID),
		fmt.Sprintf(`{"scope":"workspace","candidate_ids":[%q]} {}`, before[0].ID),
	} {
		testutil.Call(t, f.h.ConfirmLarkPrivateChatCandidates, f.privateRequest(testUserID, "POST", body)).Want(400)
	}
	dbfx.Exec(t, `UPDATE channel_installation SET config=jsonb_set(config,'{private_chat_candidates,0,last_seen_at}',to_jsonb($2::text)) WHERE id=$1`, f.install, time.Now().Add(-8*24*time.Hour).Format(time.RFC3339Nano))
	f.msg.MessageID = "om_fresh_observation"
	f.privateSource(t, nil)
	f.ingest(t)
	fresh := f.privateCandidates(t)
	if len(fresh) != 1 || fresh[0].ID == before[0].ID {
		t.Fatal("expired candidate identity was reused")
	}
	body := fmt.Sprintf(`{"scope":"workspace","candidate_ids":[%q]}`, before[0].ID)
	testutil.Call(t, f.h.ConfirmLarkPrivateChatCandidates, f.privateRequest(testUserID, "POST", body)).Want(410)
	_, err := f.h.LarkInstallations.Upsert(context.Background(), lark.InstallationParams{WorkspaceID: parseUUID(testWorkspaceID),
		AgentID: parseUUID(f.agent), AppID: f.app, AppSecret: "rotated", BotOpenID: "ou_bot", InstallerUserID: parseUUID(testUserID)})
	if err != nil {
		t.Fatal(err)
	}
	if got := f.privateCandidates(t); len(got) != 0 {
		t.Fatal("reinstallation inherited old candidates")
	}
}
