package lark

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type discoveryHostTransport struct {
	t    *testing.T
	host string
}

func (rt discoveryHostTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host != rt.host {
		rt.t.Errorf("discovery reached %s, want %s", r.URL.Host, rt.host)
	}
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"code":0,"tenant_access_token":"t","expire":7200,"data":{"chat_mode":"group","items":[],"has_more":false}}`))}, nil
}

func TestTargetDiscoveryRegion(t *testing.T) {
	for _, region := range []Region{RegionFeishu, RegionLark} {
		t.Run(string(region), func(t *testing.T) {
			creds := testCreds()
			creds.Region = region
			host := strings.TrimPrefix(region.OpenPlatformBaseURL(), "https://")
			c := NewHTTPAPIClient(HTTPClientConfig{HTTPClient: &http.Client{Transport: discoveryHostTransport{t, host}}}).(TargetDiscoveryClient)
			if _, err := c.ListJoinedChats(context.Background(), creds, DiscoveryParams{PageSize: 1}, ""); err != nil {
				t.Fatal(err)
			}
			if _, err := c.ListMessageAnchors(context.Background(), creds, DiscoveryParams{PageSize: 1}, "oc_a"); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTargetDiscoverySummaryFallbackAndUnicode(t *testing.T) {
	f := newLarkFake(t)
	f.stubToken("tok", 7200)
	f.mux.HandleFunc("/open-apis/im/v1/chats/oc_a", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"code":0,"data":{"chat_mode":"group"}}`) })
	f.mux.HandleFunc("/open-apis/im/v1/messages", func(w http.ResponseWriter, r *http.Request) {
		items := []map[string]any{}
		for i, content := range []string{`{"text":`, `{"text":"` + strings.Repeat("群", 205) + `"}`} {
			items = append(items, map[string]any{"chat_id": "oc_a", "message_id": fmt.Sprintf("om_%d", i), "msg_type": "text", "create_time": "1000", "body": map[string]string{"content": content}})
		}
		writeJSON(w, map[string]any{"code": 0, "data": map[string]any{"items": items, "has_more": false}})
	})
	page, err := newTestClient(f, time.Now).ListMessageAnchors(context.Background(), testCreds(), DiscoveryParams{PageSize: 2}, "oc_a")
	if err != nil || len(page.Items) != 2 {
		t.Fatalf("summary page: %+v %v", page, err)
	}
	if page.Items[0].Summary != "[Message]" || page.Items[1].Summary != strings.Repeat("群", 200)+"…" {
		t.Fatalf("summary fallback/limit: %+v", page.Items)
	}
}

func TestTargetDiscoveryJoinedChatsPagination(t *testing.T) {
	f := newLarkFake(t)
	f.stubToken("tok", 7200)
	calls := 0
	f.mux.HandleFunc("/open-apis/im/v1/chats", func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "GET" || r.URL.Query().Get("sort_type") != "ByCreateTimeAsc" || r.URL.Query().Get("page_size") != "2" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
		}
		if r.URL.Query().Get("page_token") == "" {
			fmt.Fprint(w, `{"code":0,"data":{"items":[{"chat_id":"oc_a","name":"Release","description":"Team A","owner_id":"private-owner","tenant_key":"private-tenant"},{"chat_id":"oc_deleted","name":"Release","chat_status":"dissolved"}],"has_more":true,"page_token":"next+/?="}}`)
		} else {
			if r.URL.Query().Get("page_token") != "next+/?=" {
				t.Error("cursor was not preserved")
			}
			fmt.Fprint(w, `{"code":0,"data":{"items":[{"chat_id":"oc_b","name":"Release","description":"Team B","external":true}],"has_more":false}}`)
		}
	})
	c := newTestClient(f, time.Now)
	page, err := c.ListJoinedChats(context.Background(), testCreds(), DiscoveryParams{PageSize: 2}, "release")
	if err != nil || len(page.Items) != 1 || !page.HasMore || page.Items[0].ChatID != "oc_a" {
		t.Fatalf("first page: %+v %v", page, err)
	}
	next, err := c.ListJoinedChats(context.Background(), testCreds(), DiscoveryParams{PageSize: 2, PageToken: page.PageToken}, "release")
	if err != nil || len(next.Items) != 1 || next.HasMore || next.Items[0].ChatID != "oc_b" || next.Items[0].Description == page.Items[0].Description {
		t.Fatalf("second page/same-name identity: %+v %v", next, err)
	}
	raw, _ := json.Marshal(page.Items)
	if strings.Contains(string(raw), "private-") || strings.Contains(string(raw), "owner_id") {
		t.Fatalf("private fields leaked: %s", raw)
	}
	filtered, err := c.ListJoinedChats(context.Background(), testCreds(), DiscoveryParams{PageSize: 2}, "absent")
	if err != nil || len(filtered.Items) != 0 || !filtered.HasMore || filtered.PageToken == "" {
		t.Fatalf("empty filtered page lost continuation: %+v %v", filtered, err)
	}
	if calls != 3 {
		t.Fatalf("discovery fetched %d pages, want exactly one per request", calls)
	}
}

func TestTargetDiscoveryTokenRejectionDoesNotPoisonNextPage(t *testing.T) {
	f := newLarkFake(t)
	f.stubToken("tok", 7200)
	calls := 0
	f.mux.HandleFunc("/open-apis/im/v1/chats", func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			fmt.Fprint(w, `{"code":99991663}`)
			return
		}
		fmt.Fprint(w, `{"code":0,"data":{"items":[],"has_more":false}}`)
	})
	c := newTestClient(f, time.Now)
	if _, err := c.ListJoinedChats(context.Background(), testCreds(), DiscoveryParams{PageSize: 1}, ""); !errors.Is(err, ErrDiscoveryUnavailable) {
		t.Fatalf("token rejection: %v", err)
	}
	if _, err := c.ListJoinedChats(context.Background(), testCreds(), DiscoveryParams{PageSize: 1}, ""); err != nil {
		t.Fatal(err)
	}
	if f.tokenN.Load() != 2 {
		t.Fatal("rejected cached token was reused")
	}
}

func TestTargetDiscoveryMessageAnchorsPagination(t *testing.T) {
	f := newLarkFake(t)
	f.stubToken("tok", 7200)
	f.mux.HandleFunc("/open-apis/im/v1/chats/oc_group", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"code":0,"data":{"chat_mode":"group"}}`)
	})
	f.mux.HandleFunc("/open-apis/im/v1/messages", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("container_id_type") != "chat" || q.Get("container_id") != "oc_group" || q.Get("sort_type") != "ByCreateTimeDesc" || q.Has("end_time") {
			t.Errorf("unexpected UI history query: %s", r.URL)
		}
		if q.Get("page_token") == "" {
			fmt.Fprint(w, `{"code":0,"data":{"has_more":true,"page_token":"older","items":[
			{"message_id":"om_new","chat_id":"oc_group","msg_type":"text","create_time":"1700000000123","thread_id":"omt_topic","sender":{"sender_type":"user","id":"ou_1","id_type":"open_id","tenant_key":"private"},"body":{"content":"{\"text\":\"hi  @_user_1\\nthere\"}"},"mentions":[{"key":"@_user_1","name":"Alex"}]},
			{"message_id":"om_deleted","chat_id":"oc_group","deleted":true,"body":{"content":"secret recalled text"}},
			{"message_id":"om_child","chat_id":"oc_group","upper_message_id":"om_forward"}]}}`)
		} else {
			if q.Get("page_token") != "older" {
				t.Error("wrong page token")
			}
			fmt.Fprint(w, `{"code":0,"data":{"has_more":false,"items":[{"message_id":"om_old","chat_id":"oc_group","msg_type":"image","create_time":"1600000000000","sender":{"sender_type":"anonymous","id":"private-anonymous-id","id_type":"open_id"},"body":{"content":"{\"image_key\":\"private-image-key\"}"}}]}}`)
		}
	})
	c := newTestClient(f, time.Now)
	page, err := c.ListMessageAnchors(context.Background(), testCreds(), DiscoveryParams{PageSize: 3}, "oc_group")
	if err != nil || len(page.Items) != 1 || !page.HasMore {
		t.Fatalf("first page: %+v %v", page, err)
	}
	if m := page.Items[0]; m.Summary != "hi @Alex there" || m.Sender.ID != "ou_1" || m.ThreadID != "omt_topic" || m.CreateTime != "1700000000123" {
		t.Fatalf("anchor: %+v", m)
	}
	next, err := c.ListMessageAnchors(context.Background(), testCreds(), DiscoveryParams{PageSize: 3, PageToken: page.PageToken}, "oc_group")
	if err != nil || len(next.Items) != 1 || next.HasMore || next.Items[0].MessageID != "om_old" || next.Items[0].Summary != "[Image]" {
		t.Fatalf("older anchors: %+v %v", next, err)
	}
	raw, _ := json.Marshal(next.Items)
	if strings.Contains(string(raw), "private") || next.Items[0].Sender.ID != "" {
		t.Fatalf("private fields leaked: %s", raw)
	}
}

func TestTargetDiscoveryErrorsAndMalformedResponses(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		want       error
	}{
		{"bad parameter", `{"code":232001}`, 400, ErrDiscoveryInvalidRequest},
		{"bad message cursor", `{"code":230001}`, 200, ErrDiscoveryInvalidRequest},
		{"not joined", `{"code":230002}`, 400, ErrDiscoveryChat},
		{"invisible chat", `{"code":232011}`, 400, ErrDiscoveryChat},
		{"no scope", `{"code":99991672,"msg":"secret-token"}`, 403, ErrDiscoveryPermission},
		{"no history scope", `{"code":230027,"msg":"secret-token"}`, 200, ErrDiscoveryPermission},
		{"external chat", `{"code":232033}`, 400, ErrDiscoveryPermission},
		{"deleted message", `{"code":230110}`, 400, ErrDiscoveryMessage},
		{"bot disabled", `{"code":232025}`, 400, ErrDiscoveryUnavailable},
		{"rate limited", `{"code":99991400}`, 400, ErrDiscoveryRateLimited},
		{"gateway rate limited", `secret-token`, 429, ErrDiscoveryRateLimited},
		{"gateway unavailable", `secret-token`, 502, ErrDiscoveryUnavailable},
		{"missing code", `{"data":{"items":[],"has_more":false}}`, 200, ErrDiscoveryResponse},
		{"missing data", `{"code":0}`, 200, ErrDiscoveryResponse},
		{"missing items", `{"code":0,"data":{"has_more":false}}`, 200, ErrDiscoveryResponse},
		{"missing has_more", `{"code":0,"data":{"items":[]}}`, 200, ErrDiscoveryResponse},
		{"missing token", `{"code":0,"data":{"items":[],"has_more":true}}`, 200, ErrDiscoveryResponse},
		{"repeated token", `{"code":0,"data":{"items":[],"has_more":true,"page_token":"same"}}`, 200, ErrDiscoveryResponse},
		{"bad types", `{"code":0,"data":{"items":{},"has_more":"false"}}`, 200, ErrDiscoveryResponse},
		{"bad json", `{"secret-token`, 200, ErrDiscoveryResponse},
		{"bad chat id", `{"code":0,"data":{"items":[{"chat_id":"p2p"}],"has_more":false}}`, 200, ErrDiscoveryResponse},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newLarkFake(t)
			f.stubToken("tok", 7200)
			f.mux.HandleFunc("/open-apis/im/v1/chats", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); fmt.Fprint(w, tc.body) })
			_, err := newTestClient(f, time.Now).ListJoinedChats(context.Background(), testCreds(), DiscoveryParams{PageSize: 2, PageToken: "same"}, "")
			if !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
			if strings.Contains(err.Error(), "secret-token") {
				t.Fatal("provider error leaked")
			}
		})
	}
}

func TestTargetDiscoveryAnchorsBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, mode, body string
		want             error
	}{
		{"empty history", "group", `{"code":0,"data":{"items":[],"has_more":false}}`, nil},
		{"p2p denied", "p2p", "", ErrDiscoveryChat},
		{"limited public info denied", "", "", ErrDiscoveryChat},
		{"removed bot", "group", `{"code":230002}`, ErrDiscoveryChat},
		{"foreign message", "group", `{"code":0,"data":{"items":[{"chat_id":"oc_other","message_id":"om_1","create_time":"1000"}],"has_more":false}}`, ErrDiscoveryResponse},
		{"malformed time", "topic", `{"code":0,"data":{"items":[{"chat_id":"oc_group","message_id":"om_1","create_time":"no"}],"has_more":false}}`, ErrDiscoveryResponse},
		{"missing message id", "topic", `{"code":0,"data":{"items":[{"chat_id":"oc_group","create_time":"1000"}],"has_more":false}}`, ErrDiscoveryResponse},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newLarkFake(t)
			f.stubToken("tok", 7200)
			f.mux.HandleFunc("/open-apis/im/v1/chats/oc_group", func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, map[string]any{"code": 0, "data": map[string]string{"chat_mode": tc.mode}})
			})
			f.mux.HandleFunc("/open-apis/im/v1/messages", func(w http.ResponseWriter, r *http.Request) {
				if tc.body == "" {
					t.Error("denied chat fetched messages")
				}
				fmt.Fprint(w, tc.body)
			})
			page, err := newTestClient(f, time.Now).ListMessageAnchors(context.Background(), testCreds(), DiscoveryParams{PageSize: 2, PageToken: "older"}, "oc_group")
			if !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
			if tc.want == nil && (page.Items == nil || len(page.Items) != 0 || page.HasMore) {
				t.Fatalf("empty page: %+v", page)
			}
		})
	}
}
