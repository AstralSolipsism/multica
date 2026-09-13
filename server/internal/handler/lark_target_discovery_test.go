package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/integrations/lark"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type larkDiscoveryFixture struct {
	installation, owner, member string
	calls, providerCode         atomic.Int32
}

func newLarkDiscoveryFixture(t *testing.T) *larkDiscoveryFixture {
	t.Helper()
	wireLarkInstallServices(t)
	agentID, owner, member := privateAgentTestFixture(t)
	inst, err := testHandler.LarkInstallations.Upsert(context.Background(), lark.InstallationParams{
		WorkspaceID: parseUUID(testWorkspaceID), AgentID: parseUUID(agentID), AppID: "cli_discovery_" + agentID,
		AppSecret: "test-discovery-secret", BotOpenID: "ou_bot", InstallerUserID: parseUUID(owner), Region: lark.RegionLark,
	})
	if err != nil {
		t.Fatal(err)
	}
	f := &larkDiscoveryFixture{installation: uuidToString(inst.ID), owner: owner, member: member}
	dbfx.Cleanup(t, `DELETE FROM channel_installation WHERE id = $1`, f.installation)
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		if r.URL.Path == "/open-apis/auth/v3/tenant_access_token/internal" {
			var credentials map[string]string
			if err := json.NewDecoder(r.Body).Decode(&credentials); err != nil {
				t.Error(err)
			}
			if credentials["app_id"] != inst.AppID || credentials["app_secret"] != "test-discovery-secret" {
				t.Error("wrong installation credentials")
			}
			fmt.Fprint(w, `{"code":0,"tenant_access_token":"test-discovery-token","expire":7200}`)
			return
		}
		if code := f.providerCode.Load(); code != 0 {
			if code == -1 {
				fmt.Fprint(w, `{"secret-token`)
				return
			}
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintf(w, `{"code":%d,"msg":"test-discovery-secret test-discovery-token"}`, code)
			return
		}
		if r.Method != "GET" {
			t.Error("discovery performed a provider write")
		}
		switch r.URL.Path {
		case "/open-apis/im/v1/chats":
			if r.URL.Query().Get("page_token") == "" {
				fmt.Fprint(w, `{"code":0,"data":{"items":[{"chat_id":"oc_a","name":"Release","description":"Team A"}],"has_more":true,"page_token":"next+/?="}}`)
			} else {
				if r.URL.Query().Get("page_token") != "next+/?=" {
					t.Error("wrong upstream cursor")
				}
				fmt.Fprint(w, `{"code":0,"data":{"items":[{"chat_id":"oc_b","name":"Release","description":"Team B"}],"has_more":false}}`)
			}
		case "/open-apis/im/v1/chats/oc_a", "/open-apis/im/v1/chats/oc_b":
			fmt.Fprint(w, `{"code":0,"data":{"chat_mode":"group"}}`)
		case "/open-apis/im/v1/messages":
			if r.URL.Query().Get("page_token") == "" {
				fmt.Fprint(w, `{"code":0,"data":{"items":[{"message_id":"om_new","chat_id":"oc_a","create_time":"1700000000000","msg_type":"text","body":{"content":"{\"text\":\"release ready\"}"}}],"has_more":true,"page_token":"old-messages"}}`)
			} else {
				if r.URL.Query().Get("page_token") != "old-messages" {
					t.Error("wrong history cursor")
				}
				fmt.Fprint(w, `{"code":0,"data":{"items":[{"message_id":"om_old","chat_id":"oc_a","create_time":"1600000000000","msg_type":"text","body":{"content":"{\"text\":\"earlier release\"}"}}],"has_more":false}}`)
			}
		default:
			t.Errorf("unexpected upstream path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(fake.Close)
	previous := testHandler.LarkAPIClient
	t.Cleanup(func() { testHandler.LarkAPIClient = previous })
	testHandler.LarkAPIClient = lark.NewHTTPAPIClient(lark.HTTPClientConfig{BaseURL: fake.URL})
	return f
}

func (f *larkDiscoveryFixture) request(user, query, chat string) *http.Request {
	path := "/api/workspaces/" + testWorkspaceID + "/lark/installations/" + f.installation + "/chats"
	if chat != "" {
		path += "/" + chat + "/message-anchors"
	}
	return withURLParams(newRequestAs(user, "GET", path+query, nil), "id", testWorkspaceID, "installationId", f.installation, "chatId", chat)
}

func TestLarkDiscoveryAuthorizationAndCapability(t *testing.T) {
	f := newLarkDiscoveryFixture(t)
	otherWS := dbfx.Workspace(t, "Discovery other workspace", "discovery-"+f.installation)
	dbfx.Member(t, otherWS, f.owner, "owner")
	endpoints := []struct {
		name    string
		handler http.HandlerFunc
		chat    string
	}{
		{"capabilities", testHandler.GetLarkTargetCapabilities, ""},
		{"chats", testHandler.ListLarkTargetChats, ""},
		{"anchors", testHandler.ListLarkMessageAnchors, "oc_a"},
	}
	for _, e := range endpoints {
		t.Run(e.name, func(t *testing.T) {
			before := f.calls.Load()
			testutil.Call(t, e.handler, f.request("", "", e.chat)).Want(401)
			testutil.Call(t, e.handler, f.request(f.member, "", e.chat)).Want(403)
			for _, actor := range []string{"task_token", "cloud_pat"} {
				r := f.request(f.owner, "", e.chat)
				r.Header.Set("X-Actor-Source", actor)
				testutil.Call(t, e.handler, r).Want(403)
			}
			foreignWS := uuidToString(dbid.NewV7())
			r := withURLParams(f.request(f.owner, "", e.chat), "id", foreignWS, "installationId", f.installation, "chatId", e.chat)
			testutil.Call(t, e.handler, r).Want(404)
			// Caller owns both workspaces; this installation only exists in one.
			r = withURLParams(f.request(f.owner, "", e.chat), "id", otherWS, "installationId", f.installation, "chatId", e.chat)
			testutil.Call(t, e.handler, r).Want(404)
			r = withURLParams(f.request(f.owner, "", e.chat), "id", testWorkspaceID, "installationId", uuidToString(dbid.NewV7()), "chatId", e.chat)
			testutil.Call(t, e.handler, r).Want(404)
			if f.calls.Load() != before {
				t.Fatal("unauthorized request reached provider")
			}
			for _, user := range []string{f.owner, testUserID} {
				raw := testutil.Call(t, e.handler, f.request(user, "", e.chat)).Want(200)
				if raw.Header().Get("Cache-Control") != "no-store" {
					t.Error("history response is cacheable")
				}
				if strings.Contains(raw.Text(), "test-discovery-") || strings.Contains(raw.Text(), "app_secret") {
					t.Fatal("credentials leaked")
				}
			}
		})
	}
	cap := testutil.Decode[LarkTargetCapabilitiesResponse](t, testHandler.GetLarkTargetCapabilities, f.request(f.owner, "", ""), 200)
	if !cap.ChatListSupported || !cap.MessageAnchorListSupported || cap.Region != "lark" || cap.ScopeStatus != "not_checked" {
		t.Fatalf("capabilities: %+v", cap)
	}
	testHandler.LarkAPIClient = lark.NewStubAPIClient(nil)
	cap = testutil.Decode[LarkTargetCapabilitiesResponse](t, testHandler.GetLarkTargetCapabilities, f.request(f.owner, "", ""), 200)
	if cap.ChatListSupported || cap.MessageAnchorListSupported {
		t.Fatal("stub advertised discovery")
	}
	testutil.Call(t, testHandler.ListLarkTargetChats, f.request(f.owner, "", "")).Want(503)
}

func TestLarkDiscoveryPagesAndCursorBoundaries(t *testing.T) {
	f := newLarkDiscoveryFixture(t)
	first := testutil.Decode[larkDiscoveryPageResponse[lark.DiscoveryChat]](t, testHandler.ListLarkTargetChats, f.request(f.owner, "?page_size=1&q=release", ""), 200)
	if !first.HasMore || first.NextCursor == "" || first.Items[0].ChatID != "oc_a" {
		t.Fatalf("first page: %+v", first)
	}
	nextQuery := "?page_size=1&q=release&cursor=" + url.QueryEscape(first.NextCursor)
	next := testutil.Decode[larkDiscoveryPageResponse[lark.DiscoveryChat]](t, testHandler.ListLarkTargetChats, f.request(f.owner, nextQuery, ""), 200)
	if next.HasMore || next.NextCursor != "" || len(next.Items) != 1 || next.Items[0].ChatID != "oc_b" {
		t.Fatalf("second page: %+v", next)
	}
	before := f.calls.Load()
	for _, q := range []string{
		"?page_size=0", "?page_size=101", "?page_size=bad", "?page_size=1&page_size=2", "?q=" + strings.Repeat("a", 101),
		"?cursor=broken", "?page_size=2&q=release&cursor=" + url.QueryEscape(first.NextCursor), "?page_size=1&q=other&cursor=" + url.QueryEscape(first.NextCursor),
	} {
		testutil.Call(t, testHandler.ListLarkTargetChats, f.request(f.owner, q, "")).Want(400)
	}
	testutil.Call(t, testHandler.ListLarkTargetChats, f.request(testUserID, nextQuery, "")).Want(400)
	testutil.Call(t, testHandler.ListLarkMessageAnchors, f.request(f.owner, "?page_size=51", "oc_a")).Want(400)
	testutil.Call(t, testHandler.ListLarkMessageAnchors, f.request(f.owner, "?q=search", "oc_a")).Want(400)
	if f.calls.Load() != before {
		t.Fatal("invalid query reached provider")
	}
	anchors := testutil.Decode[larkDiscoveryPageResponse[lark.MessageAnchor]](t, testHandler.ListLarkMessageAnchors, f.request(f.owner, "?page_size=1", "oc_a"), 200)
	q := "?page_size=1&cursor=" + url.QueryEscape(anchors.NextCursor)
	testutil.Call(t, testHandler.ListLarkMessageAnchors, f.request(f.owner, q, "oc_b")).Want(400)
	older := testutil.Decode[larkDiscoveryPageResponse[lark.MessageAnchor]](t, testHandler.ListLarkMessageAnchors, f.request(f.owner, q, "oc_a"), 200)
	if len(older.Items) != 1 || older.Items[0].MessageID != "om_old" || older.HasMore {
		t.Fatalf("second anchor page: %+v", older)
	}
	before = f.calls.Load()
	if err := testHandler.LarkInstallations.Revoke(context.Background(), parseUUID(f.installation)); err != nil {
		t.Fatal(err)
	}
	testutil.Call(t, testHandler.ListLarkMessageAnchors, f.request(f.owner, q, "oc_a")).Want(409)
	if f.calls.Load() != before {
		t.Fatal("revoked installation reused cursor")
	}
}

func TestLarkDiscoveryProviderErrorsAreSafe(t *testing.T) {
	f := newLarkDiscoveryFixture(t)
	for _, tc := range []struct {
		provider int32
		status   int
		code     string
	}{
		{230002, 404, "lark_discovery_chat_unavailable"},
		{230027, 403, "lark_discovery_permission_denied"},
		{230110, 410, "lark_discovery_message_unavailable"},
		{99991400, 429, "lark_discovery_rate_limited"},
		{232025, 503, "lark_discovery_unavailable"},
		{230001, 400, "lark_discovery_invalid_request"},
		{-1, 502, "lark_discovery_invalid_response"},
	} {
		f.providerCode.Store(tc.provider)
		resp := testutil.Call(t, testHandler.ListLarkMessageAnchors, f.request(f.owner, "", "oc_a")).Want(tc.status)
		if resp.Map()["code"] != tc.code {
			t.Fatalf("code: %s", resp.Text())
		}
		if strings.Contains(resp.Text(), "test-discovery-") {
			t.Fatal("raw provider error leaked")
		}
	}
	f.providerCode.Store(0)
	first := testutil.Decode[larkDiscoveryPageResponse[lark.DiscoveryChat]](t, testHandler.ListLarkTargetChats, f.request(f.owner, "", ""), 200)
	f.providerCode.Store(232001)
	resp := testutil.Call(t, testHandler.ListLarkTargetChats, f.request(f.owner, "?cursor="+url.QueryEscape(first.NextCursor), "")).Want(400)
	if resp.Map()["code"] != "lark_discovery_invalid_cursor" {
		t.Fatal(resp.Text())
	}
}

func TestLarkDiscoveryCursorIntegrity(t *testing.T) {
	now := time.Unix(1700000000, 0)
	cursor := encodeLarkDiscoveryCursor("provider+/?=", "secret", "workspace-installation-user-chat-query", now)
	if token, ok := decodeLarkDiscoveryCursor(cursor, "secret", "workspace-installation-user-chat-query", now); !ok || token != "provider+/?=" {
		t.Fatal("cursor failed round trip")
	}
	for _, tc := range []struct {
		cursor, secret, scope string
		now                   time.Time
	}{
		{cursor, "secret", "other-installation", now},
		{cursor, "rotated-secret", "workspace-installation-user-chat-query", now},
		{cursor, "secret", "workspace-installation-user-chat-query", now.Add(30 * time.Minute)},
		{cursor + "x", "secret", "workspace-installation-user-chat-query", now},
		{strings.Repeat("a", 8193), "secret", "workspace-installation-user-chat-query", now},
	} {
		if _, ok := decodeLarkDiscoveryCursor(tc.cursor, tc.secret, tc.scope, tc.now); ok {
			t.Fatal("invalid cursor accepted")
		}
	}
}
