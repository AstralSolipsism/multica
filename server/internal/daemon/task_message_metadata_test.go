package daemon

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/agent"
)

func TestExecuteAndDrain_PreservesMetadataBoundaries(t *testing.T) {
	t.Parallel()
	// Hold the first report so periodic flushing cannot split the tested frames.
	entered, release := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	defer unblock.Do(func() { close(release) })
	rec := &transcriptRecorder{}
	var first sync.Once
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []TaskMessageData `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		rec.mu.Lock()
		rec.messages = append(rec.messages, body.Messages...)
		rec.mu.Unlock()
		first.Do(func() { close(entered); <-release })
		w.WriteHeader(http.StatusOK)
	}))
	defer func() {
		unblock.Do(func() { close(release) })
		srv.Close()
	}()
	d := &Daemon{client: NewClient(srv.URL), logger: slog.Default()}
	messages := make(chan agent.Message)
	results := make(chan agent.Result, 1)
	backend := sessionBackend{session: &agent.Session{Messages: messages, Result: results}}
	var seq atomic.Int32
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, _, err := d.executeAndDrain(ctx, backend, "p", agent.ExecOptions{}, slog.Default(), "task", "", &seq)
		done <- err
	}()
	send := func(m agent.Message) {
		t.Helper()
		select {
		case messages <- m:
		case <-ctx.Done():
			t.Fatal("drain timed out")
		}
	}
	send(agent.Message{Type: agent.MessageToolUse, Tool: "Read"})
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("first report timed out")
	}
	metadata := func(level string, step int) map[string]any {
		return map[string]any{"thinking": map[string]any{"level": level, "mode": "adapt", "step": float64(step)}}
	}
	low, high, next := metadata("low", 1), metadata("high", 2), metadata("high", 3)
	for _, msg := range []agent.Message{
		{Type: agent.MessageThinking, Content: "old"},
		{Type: agent.MessageThinking, Content: " peer"},
		{Type: agent.MessageThinking, Content: "low", Metadata: low},
		{Type: agent.MessageThinking, Content: " merged", Metadata: metadata("low", 1)},
		{Type: agent.MessageThinking, Content: "high", Metadata: high},
		{Type: agent.MessageThinking, Content: "next", Metadata: next},
		{Type: agent.MessageThinking, Content: "missing"},
		{Type: agent.MessageText, Content: "text", Metadata: low},
		{Type: agent.MessageText, Content: " merged", Metadata: metadata("low", 1)},
		{Type: agent.MessageText, Content: "new level", Metadata: high},
		{Type: agent.MessageToolUse, Tool: "Bash", Metadata: next},
		{Type: agent.MessageToolResult, Tool: "Bash", Output: "ok", Metadata: next},
		{Type: agent.MessageError, Content: "error", Metadata: high},
		// Sending a sentinel proves the preceding message has been appended.
		{Type: agent.MessageStatus},
	} {
		send(msg)
	}
	close(messages)
	results <- agent.Result{Status: "completed"}
	close(results)
	unblock.Do(func() { close(release) })
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	got := rec.snapshot()
	slices.SortFunc(got, func(a, b TaskMessageData) int { return a.Seq - b.Seq })
	want := []struct {
		typ, content string
		metadata     map[string]any
	}{
		{"tool_use", "", nil},
		{"thinking", "old peer", nil},
		{"thinking", "low merged", low},
		{"thinking", "high", high},
		{"thinking", "next", next},
		{"thinking", "missing", nil},
		{"text", "text merged", low},
		{"text", "new level", high},
		{"tool_use", "", next},
		{"tool_result", "", next},
		{"error", "error", high},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d rows, want %d: %+v", len(got), len(want), got)
	}
	for i, row := range got {
		if row.Seq != i+1 || row.Type != want[i].typ || row.Content != want[i].content || !reflect.DeepEqual(row.Metadata, want[i].metadata) {
			t.Fatalf("row %d = %+v, want %+v", i, row, want[i])
		}
	}
}
