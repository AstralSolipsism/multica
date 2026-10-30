package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/daemon/media"
	"github.com/multica-ai/multica/server/internal/daemonws"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/storage"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type fixtureMediaExecutor struct {
	submits   atomic.Int32
	directory string
	input     string
}

func (e *fixtureMediaExecutor) Capabilities() []string { return []string{"media-image-codex-v1"} }
func (e *fixtureMediaExecutor) Submit(ctx context.Context, req protocol.MediaRequest, inputs []media.Input, dir string) (media.Artifact, error) {
	e.submits.Add(1)
	e.directory = dir
	if len(inputs) != 1 || inputs[0].Role != "subject" {
		return media.Artifact{}, fmt.Errorf("wrong input manifest")
	}
	data, err := os.ReadFile(inputs[0].Path)
	if err != nil || string(data) != e.input {
		return media.Artifact{}, fmt.Errorf("wrong input bytes")
	}
	file := filepath.Join(dir, "output.png")
	f, err := os.Create(file)
	if err != nil {
		return media.Artifact{}, err
	}
	if _, err = f.Write([]byte{137, 80, 78, 71, 13, 10, 26, 10}); err == nil {
		err = f.Truncate(110 << 20)
	}
	closeErr := f.Close()
	if err != nil {
		return media.Artifact{}, err
	}
	if closeErr != nil {
		return media.Artifact{}, closeErr
	}
	return media.Artifact{Path: file}, nil
}

func TestMediaEndToEndStreamingRPC(t *testing.T) {
	database := os.Getenv("DATABASE_URL")
	if database == "" {
		t.Skip("requires migrated DATABASE_URL")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	fx := testutil.New(pool, "", "")
	userID := fx.User(t, "media integration", uuid.NewString()+"@example.test")
	workspaceID := fx.Workspace(t, "media integration", uuid.NewString())
	fx.Member(t, workspaceID, userID, "owner")
	fx = testutil.New(pool, workspaceID, userID)
	runtimeID := fx.Runtime(t, "media", testutil.Cols{"provider": "codex", "daemon_id": uuid.NewString(), "metadata": `{"capabilities":["media-image-codex-v1"]}`})
	t.Setenv("LOCAL_UPLOAD_DIR", t.TempDir())
	h := &handler.Handler{Queries: db.New(pool), DB: pool, TxStarter: pool, Storage: storage.NewLocalStorageFromEnv()}
	hub := daemonws.NewHub()
	hub.SetRPCHandler(h.DaemonRPCHandler)
	identity := daemonws.ClientIdentity{UserID: userID, WorkspaceID: workspaceID, RuntimeIDs: []string{runtimeID}}
	var acks, uploads, downloads atomic.Int32
	hub.SetHeartbeatHandler(func(ctx context.Context, id daemonws.ClientIdentity, p protocol.DaemonHeartbeatRequestPayload) (*protocol.DaemonHeartbeatAckPayload, error) {
		return &protocol.DaemonHeartbeatAckPayload{RuntimeID: runtimeID, ServerCapabilities: []string{"rpc-v1"}}, nil
	})
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Header.Set("X-User-ID", userID)
			r.Header.Set("X-Workspace-ID", workspaceID)
			next.ServeHTTP(w, r)
		})
	})
	router.Get("/ws", func(w http.ResponseWriter, r *http.Request) { hub.HandleWebSocket(w, r, identity) })
	router.Post("/api/media/jobs", h.CreateMediaJob)
	router.Get("/api/media/jobs/{id}", h.GetMediaJob)
	router.Get("/api/media/jobs/{id}/status", h.MediaAttemptStatus)
	router.Get("/api/media/jobs/{id}/inputs/{attachmentID}", h.DownloadMediaInput)
	router.Post("/api/upload-file", h.UploadFile)
	router.Post("/api/media/jobs/{id}/output", func(w http.ResponseWriter, r *http.Request) {
		attempt := uploads.Add(1)
		if attempt == 1 {
			http.Error(w, "transient upload failure", 503)
			return
		}
		if attempt == 2 {
			before := acks.Load()
			deadline := time.Now().Add(time.Second)
			for acks.Load() < before+3 && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			if acks.Load() < before+3 {
				t.Error("WS heartbeats stopped during upload")
			}
			rec := httptest.NewRecorder()
			h.UploadMediaOutput(rec, r)
			if rec.Code != 200 {
				t.Errorf("upload: %d %s", rec.Code, rec.Body.String())
			}
			// The object committed, but its HTTP receipt was lost. The next upload
			// must return the existing attachment, without rerunning Submit.
			http.Error(w, "lost upload receipt", 503)
			return
		}
		h.UploadMediaOutput(w, r)
	})
	router.Get("/api/attachments/{id}/download", func(w http.ResponseWriter, r *http.Request) { downloads.Add(1); h.DownloadAttachment(w, r) })
	server := httptest.NewServer(router)
	defer server.Close()
	client := &cli.APIClient{BaseURL: server.URL, WorkspaceID: workspaceID, HTTPClient: server.Client()}
	inputPath := filepath.Join(t.TempDir(), "source.txt")
	if err := os.WriteFile(inputPath, []byte("fixture input"), 0600); err != nil {
		t.Fatal(err)
	}
	input, err := client.UploadMediaInput(ctx, inputPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), "DELETE FROM attachment WHERE workspace_id=$1", workspaceID) })
	var job protocol.MediaJob
	err = client.PostJSON(ctx, "/api/media/jobs", protocol.MediaRequest{Capability: "image-edit", Provider: "codex", Prompt: "fixture", Inputs: []protocol.MediaInput{{Role: "subject", AttachmentID: input.ID}}}, &job)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(context.Background(), "DELETE FROM media_job WHERE workspace_id=$1", workspaceID) })
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	wsCtx, wsCancel := context.WithCancel(ctx)
	executor := &fixtureMediaExecutor{input: "fixture input"}
	d := &Daemon{cfg: Config{MediaExecutor: func(provider, profile string) media.Executor { return executor }}, client: NewClient(server.URL), wsRPC: newWSRPCClient(time.Second)}
	frames := make(chan *wsOutbound, 64)
	generation := d.wsRPC.attach(func(data []byte) (*wsOutbound, error) {
		frame := &wsOutbound{data: data}
		select {
		case frames <- frame:
			return frame, nil
		case <-wsCtx.Done():
			return nil, wsCtx.Err()
		}
	})
	d.wsRPC.markRPCV1Supported(generation)
	readDone, writeDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var msg protocol.Message
			if json.Unmarshal(data, &msg) != nil {
				continue
			}
			switch msg.Type {
			case protocol.EventDaemonRPCResponse:
				var response protocol.RPCResponsePayload
				json.Unmarshal(msg.Payload, &response)
				d.wsRPC.deliver(response)
			case protocol.EventDaemonHeartbeatAck:
				acks.Add(1)
			}
		}
	}()
	go func() {
		defer close(writeDone)
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-wsCtx.Done():
				return
			case frame := <-frames:
				if len(frame.data) > 64<<10 {
					t.Error("binary data in WS control frame")
				}
				if frame.beginWrite() {
					if conn.WriteMessage(websocket.TextMessage, frame.data) != nil {
						return
					}
				}
			case <-ticker.C:
				payload, _ := json.Marshal(protocol.DaemonHeartbeatRequestPayload{RuntimeID: runtimeID})
				data, _ := json.Marshal(protocol.Message{Type: protocol.EventDaemonHeartbeat, Payload: payload})
				if conn.WriteMessage(websocket.TextMessage, data) != nil {
					return
				}
			}
		}
	}()
	defer func() { wsCancel(); conn.Close(); <-readDone; <-writeDone }()
	var claim protocol.MediaClaimResponse
	if err := d.mediaRPC(ctx, "media.claim", protocol.MediaClaimRequest{RuntimeID: runtimeID}, &claim); err != nil {
		t.Fatal(err)
	}
	if claim.Assignment == nil {
		t.Fatal("no assignment")
	}
	result := d.executeMedia(ctx, Runtime{ID: runtimeID, Provider: "codex"}, *claim.Assignment)
	if result.Error != "" {
		t.Fatal(result.Error)
	}
	if err := d.mediaRPC(ctx, "media.result", result, nil); err != nil {
		t.Fatal(err)
	}
	completed, err := client.WaitMediaJob(ctx, job.ID, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if completed.State != "completed" || completed.AttachmentID == "" || completed.Markdown == "" {
		t.Fatalf("missing receipt: %+v", completed)
	}
	if executor.submits.Load() != 1 || uploads.Load() != 3 || downloads.Load() != 0 {
		t.Fatalf("submits=%d uploads=%d downloads=%d", executor.submits.Load(), uploads.Load(), downloads.Load())
	}
	if _, err := os.Stat(executor.directory); !os.IsNotExist(err) {
		t.Fatal("job temporary files not removed")
	}
	out := filepath.Join(t.TempDir(), "download.png")
	if err := client.DownloadMediaOutput(ctx, completed.AttachmentID, out); err != nil {
		t.Fatal(err)
	}
	stat, err := os.Stat(out)
	if err != nil || stat.Size() != 110<<20 || downloads.Load() != 1 {
		t.Fatal("streamed download incomplete")
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM attachment WHERE workspace_id=$1", workspaceID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("upload retry duplicated attachments: %d %v", count, err)
	}
}

func TestMediaRegistrationDoesNotBroadcastCapabilities(t *testing.T) {
	executor := &fixtureMediaExecutor{}
	d := &Daemon{cfg: Config{MediaExecutor: func(provider, profile string) media.Executor {
		if provider == "codex" && profile == "ready" {
			return executor
		}
		return nil
	}}}
	payload := d.withMediaCapabilities([]map[string]string{{"type": "codex", "profile_id": "ready"}, {"type": "codex", "profile_id": "unavailable"}, {"type": "claude"}})
	for i, entry := range payload {
		caps := entry["media_capabilities"].([]string)
		if i == 0 && len(caps) != 1 {
			t.Fatal("ready adapter not advertised")
		}
		if i > 0 && len(caps) != 0 {
			t.Fatal("media capability broadcast to unavailable runtime")
		}
	}
}
