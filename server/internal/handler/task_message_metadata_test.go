package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestTaskMessageMetadataLiveAndHistory(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	taskID := seedBatchTask(t, "metadata")
	h := *testHandler
	h.Bus = events.New()
	var live []map[string]any
	h.Bus.Subscribe(protocol.EventTaskMessage, func(e events.Event) {
		if e.TaskID != taskID {
			return
		}
		data, err := json.Marshal(e.Payload)
		if err != nil {
			t.Error(err)
			return
		}
		var row map[string]any
		if err := json.Unmarshal(data, &row); err != nil {
			t.Error(err)
			return
		}
		live = append(live, row)
	})
	valid := map[string]any{
		"thinking": map[string]any{"level": "xhigh", "mode": "adapt", "step": float64(2), "confidence": 0.88},
		"future":   map[string]any{"enabled": true},
	}
	// The limit measures bytes, including multibyte UTF-8, on each field.
	boundary := json.RawMessage(`{"x":"` + strings.Repeat("a", 4088) + `"}`)
	tooLarge := json.RawMessage(`{"x":"` + strings.Repeat("a", 4089) + `"}`)
	cases := []struct {
		name     string
		metadata any
		want     any
	}{
		{"valid", valid, valid},
		{"missing", nil, nil},
		{"empty object", map[string]any{}, map[string]any{}},
		{"array", []any{valid}, nil},
		{"string", "bad", nil},
		{"number", 123, nil},
		{"boolean", true, nil},
		{"null", json.RawMessage("null"), nil},
		{"at limit", boundary, map[string]any{"x": strings.Repeat("a", 4088)}},
		{"over limit", tooLarge, nil},
		{"multibyte over limit", map[string]any{"x": strings.Repeat("脑", 1363)}, nil},
		{"nested NUL", map[string]any{"future": []any{"a\x00b"}}, map[string]any{"future": []any{"ab"}}},
		// JSON numbers must not round through float64 before JSONB persistence.
		{"precise number", json.RawMessage(`{"n":9007199254740993}`), map[string]any{"n": float64(9007199254740993)}},
	}
	messages := make([]any, len(cases))
	for i, tc := range cases {
		row := map[string]any{"seq": i + 1, "type": "thinking", "content": tc.name}
		if tc.metadata != nil {
			row["metadata"] = tc.metadata
		}
		messages[i] = row
	}
	testutil.Call(t, h.ReportTaskMessages, batchMessagesRequest(t, taskID, messages)).Want(http.StatusOK)
	stored, err := h.Queries.ListTaskMessages(context.Background(), util.MustParseUUID(taskID))
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != len(cases) || len(live) != len(cases) {
		t.Fatalf("stored/live counts = %d/%d, want %d", len(stored), len(live), len(cases))
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if stored[i].Content.String != tc.name || live[i]["content"] != tc.name {
				t.Fatal("metadata discarded the message content")
			}
			var got any
			if stored[i].Metadata != nil {
				if err := json.Unmarshal(stored[i].Metadata, &got); err != nil {
					t.Fatal(err)
				}
			}
			if !reflect.DeepEqual(got, tc.want) || !reflect.DeepEqual(live[i]["metadata"], tc.want) {
				t.Fatalf("stored/live metadata = %v / %v, want %v", got, live[i]["metadata"], tc.want)
			}
			if tc.want == nil {
				if _, ok := live[i]["metadata"]; ok {
					t.Fatal("absent metadata must be omitted on the wire")
				}
			}
		})
	}
	var precise string
	dbfx.QueryRow(t, `SELECT metadata->>'n' FROM task_message WHERE task_id=$1 AND seq=$2`, taskID, len(cases)).Scan(&precise)
	if precise != "9007199254740993" {
		t.Fatalf("JSON number lost precision: %s", precise)
	}

	for _, reader := range []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"daemon", h.ListTaskMessages}, {"user", h.ListTaskMessagesByUser},
	} {
		for _, suffix := range []string{"", "?since=2"} {
			t.Run(reader.name+suffix, func(t *testing.T) {
				req := testutil.JSONRequest(http.MethodGet, "/api/tasks/"+taskID+"/messages"+suffix, nil)
				req = testutil.WithURLParams(req, "taskId", taskID)
				ctx := middleware.WithDaemonContext(req.Context(), testWorkspaceID, "metadata-daemon")
				ctx = middleware.SetMemberContext(ctx, testWorkspaceID, db.Member{})
				var history []map[string]any
				testutil.Call(t, reader.handler, req.WithContext(ctx)).Want(http.StatusOK).JSON(&history)
				want := live
				if suffix != "" {
					want = live[2:]
				}
				if !reflect.DeepEqual(history, want) {
					t.Fatal("history differs from live payload")
				}
			})
		}
	}
}
