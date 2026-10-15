package handler

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const oversizedSessionError = `FAILED_PRECONDITION (code 400): The message size (31402142 bytes) exceeds 30.000MB limit.`

// Exercise PostgreSQL itself, including latest-per-session selection: an older
// completed row for the same session must never resurrect poisoned history.
func TestOversizedRequestResumeQueries(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	agentID, runtimeID, _ := createRuntimeGuardAgent(t, ctx)
	for _, tc := range []struct {
		name, raw string
		excluded  bool
	}{
		{"agy", oversizedSessionError, true},
		{"structured", `AGY_ERROR: {"short_error":"The message size (31641339 bytes) exceeds 30.000MB limit.","status":"INVALID_ARGUMENT","error_code":400}`, true},
		{"payload", `HTTP 400 Request payload size exceeds the limit`, true},
		{"case", `invalid_argument MESSAGE SIZE EXCEEDS LIMIT`, true},
		{"newline", "FAILED_PRECONDITION request size\nexceeds limit", true},
		{"no status", `message size exceeds limit`, false},
		{"embedded digits", `message size (31400142 bytes) exceeds 30.000MB limit`, false},
		{"long code", `message size exceeds limit HTTP 4000`, false},
		{"file", `file size (52428800 bytes) exceeds 50MB limit (HTTP 400)`, false},
		{"quota", `HTTP 429 quota exceeded`, false},
		{"glm image", `API Error: 400 [1210][图片输入格式/解析错误]`, false},
		{"anthropic unchanged", `API Error: 400 invalid_request_error: Could not process image`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, chat := range []bool{false, true} {
				issueID := dbfx.Issue(t, "oversized SQL guard")
				chatID := dbfx.ChatSession(t, agentID, testutil.Cols{"runtime_id": runtimeID})
				scope := testutil.Cols{"issue_id": issueID}
				if chat {
					scope = testutil.Cols{"chat_session_id": chatID}
				}
				dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "status": "completed", "session_id": "same-session", "completed_at": testutil.Raw("now() - interval '2 minutes'")}, scope)
				dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "status": "failed", "session_id": "same-session", "failure_reason": "agent_error.unknown", "error": tc.raw, "completed_at": testutil.Raw("now() - interval '1 minute'")}, scope)
				var session string
				var err error
				if chat {
					var prior db.GetLastChatTaskSessionRow
					prior, err = testHandler.Queries.GetLastChatTaskSession(ctx, db.GetLastChatTaskSessionParams{ChatSessionID: parseUUID(chatID)})
					session = prior.SessionID.String
				} else {
					var prior db.GetLastTaskSessionRow
					prior, err = testHandler.Queries.GetLastTaskSession(ctx, db.GetLastTaskSessionParams{AgentID: parseUUID(agentID), IssueID: parseUUID(issueID)})
					session = prior.SessionID.String
				}
				if tc.excluded {
					if !errors.Is(err, pgx.ErrNoRows) {
						t.Fatalf("chat=%v: expected exclusion, got session=%q err=%v", chat, session, err)
					}
				} else if err != nil || session != "same-session" {
					t.Fatalf("chat=%v: healthy session lost: %q, %v", chat, session, err)
				}
			}
		})
	}
}

func TestClaimIssueExcludedSessionContinuity(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	for _, tc := range []struct {
		name                                                    string
		capable, older, retired, healthy, forceFresh, noHistory bool
		reason, raw, wantSession, wantDir                       string
		wantNotice                                              bool
	}{
		{name: "legacy oversized", capable: true, reason: "agent_error.unknown", raw: oversizedSessionError, wantDir: "/latest-work", wantNotice: true},
		{name: "old daemon capability", reason: "agent_error.unknown", raw: oversizedSessionError, wantNotice: true},
		{name: "older healthy fallback", older: true, reason: "api_invalid_request", wantSession: "healthy-session", wantDir: "/healthy-work", wantNotice: true},
		{name: "retired", capable: true, retired: true, wantDir: "/latest-work", wantNotice: true},
		{name: "other unsafe reason", capable: true, reason: "iteration_limit", wantDir: "/latest-work", wantNotice: true},
		{name: "normal followup", healthy: true, wantSession: "latest-session", wantDir: "/session-work"},
		{name: "transient failure", reason: "agent_error.unknown", raw: "HTTP 429 quota exceeded", wantSession: "latest-session", wantDir: "/session-work"},
		{name: "explicit fresh", capable: true, forceFresh: true, reason: "api_invalid_request"},
		{name: "first run", capable: true, noHistory: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			agentID, runtimeID, daemonID := createRuntimeGuardAgent(t, context.Background())
			issueID := dbfx.Issue(t, "excluded session continuity")
			if tc.older {
				dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "completed", "session_id": "healthy-session", "work_dir": "/healthy-work", "completed_at": testutil.Raw("now() - interval '5 minutes'")})
			}
			if !tc.noHistory {
				status := "failed"
				if tc.healthy || tc.retired {
					status = "completed"
				}
				dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": status, "session_id": "latest-session", "work_dir": "/session-work", "failure_reason": tc.reason, "error": tc.raw, "started_at": testutil.Raw("now() - interval '3 minutes'"), "completed_at": testutil.Raw("now() - interval '2 minutes'")})
				// A later run can record a workdir without returning a session. Preserve
				// this latest directory when no session can be resumed.
				newer := testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "failed", "work_dir": "/latest-work", "completed_at": testutil.Raw("now() - interval '1 minute'")}
				if tc.retired {
					newer["retired_session_id"] = "latest-session"
				}
				dbfx.Task(t, agentID, newer)
				// A later failure before preparation has no directory of its own;
				// it must not hide the most recent recorded workdir.
				dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "failed", "completed_at": testutil.Raw("now() - interval '30 seconds'")})
				// Triage must not become the latest execution session or directory.
				dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "completed", "context": `{"type":"triage"}`, "session_id": "triage", "work_dir": "/triage", "completed_at": testutil.Raw("now()")})
			}
			dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "force_fresh_session": tc.forceFresh})
			caps := ""
			if tc.capable {
				caps = protocol.DaemonCapabilityCheckoutKeepsWorkV1
			}
			got := claimTaskForRuntimeGuardWithCapabilities(t, runtimeID, daemonID, caps)
			if got.PriorSessionID != tc.wantSession || got.PriorWorkDir != tc.wantDir || got.PriorSessionResumeUnavailable != tc.wantNotice {
				t.Fatalf("claim = session %q dir %q notice %v; want %q %q %v", got.PriorSessionID, got.PriorWorkDir, got.PriorSessionResumeUnavailable, tc.wantSession, tc.wantDir, tc.wantNotice)
			}
		})
	}
}

func TestClaimRerunOversizedSessionContinuity(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	agentID, runtimeID, daemonID := createRuntimeGuardAgent(t, context.Background())
	issueID := dbfx.Issue(t, "oversized manual rerun")
	src := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "status": "failed", "session_id": "oversized", "work_dir": "/source-work", "failure_reason": "agent_error.unknown", "error": oversizedSessionError})
	dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "issue_id": issueID, "rerun_of_task_id": src, "force_fresh_session": true})
	got := claimTaskForRuntimeGuard(t, runtimeID, daemonID)
	if got.PriorSessionID != "" || got.PriorWorkDir != "/source-work" || !got.PriorSessionResumeUnavailable {
		t.Fatalf("rerun = %+v", got)
	}
}

func TestClaimChatExcludedSessionContinuity(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	for _, mode := range []string{"oversized", "retired", "healthy", "older healthy fallback", "older pointer", "legacy poisoned pointer"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			agentID, runtimeID, daemonID := createRuntimeGuardAgent(t, ctx)
			chatID := dbfx.ChatSession(t, agentID, testutil.Cols{"runtime_id": runtimeID, "session_id": "chat-session", "work_dir": "/chat-work"})
			if mode == "older healthy fallback" || mode == "older pointer" {
				dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "chat_session_id": chatID, "status": "completed", "session_id": "older-session", "work_dir": "/older-work", "completed_at": testutil.Raw("now() - interval '2 minutes'")})
			}
			taskID := dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "chat_session_id": chatID, "status": "running", "session_id": "chat-session", "work_dir": "/chat-work", "started_at": testutil.Raw("now() - interval '1 minute'")})
			raw, retired := "HTTP 429 quota exceeded", ""
			if mode == "oversized" || mode == "older healthy fallback" || mode == "older pointer" || mode == "legacy poisoned pointer" {
				raw = oversizedSessionError
			}
			if mode == "retired" {
				retired = "chat-session"
			}
			svc := service.NewTaskService(testHandler.Queries, testPool, nil, events.New())
			failed, err := svc.FailTask(ctx, parseUUID(taskID), raw, "", "/chat-work", "", "agent_error.unknown", false, retired, "")
			if err != nil {
				t.Fatal(err)
			}
			cs, err := testHandler.Queries.GetChatSession(ctx, parseUUID(chatID))
			if err != nil {
				t.Fatal(err)
			}
			if mode == "oversized" || mode == "older healthy fallback" || mode == "older pointer" || mode == "legacy poisoned pointer" {
				if failed.FailureReason.String != "api_invalid_request" {
					t.Fatalf("legacy reason not upgraded: %v", failed.FailureReason)
				}
			}
			if mode != "healthy" && cs.SessionID.Valid {
				t.Fatalf("unsafe/retired pointer retained: %v", cs.SessionID)
			}
			if cs.WorkDir.String != "/chat-work" {
				t.Fatalf("lost chat directory: %v", cs.WorkDir)
			}
			if mode == "older pointer" {
				dbfx.Exec(t, `UPDATE chat_session SET session_id = 'older-session' WHERE id = $1`, chatID)
			}
			if mode == "legacy poisoned pointer" {
				// A row written before this server learned to clear the pointer.
				dbfx.Exec(t, `UPDATE chat_session SET session_id = 'chat-session' WHERE id = $1`, chatID)
				dbfx.Exec(t, `UPDATE agent_task_queue SET failure_reason = 'agent_error.unknown' WHERE id = $1`, taskID)
			}
			dbfx.Insert(t, "chat_message", testutil.Cols{"chat_session_id": chatID, "role": "user", "content": "continue"})
			dbfx.Task(t, agentID, testutil.Cols{"runtime_id": runtimeID, "chat_session_id": chatID})
			got := claimTaskForRuntimeGuard(t, runtimeID, daemonID)
			wantSession := ""
			if mode == "healthy" {
				wantSession = "chat-session"
			}
			if mode == "older healthy fallback" || mode == "older pointer" {
				wantSession = "older-session"
			}
			if got.PriorSessionID != wantSession || got.PriorWorkDir != "/chat-work" || got.PriorSessionResumeUnavailable != (mode != "healthy") {
				t.Fatalf("chat claim = %+v", got)
			}
		})
	}
}
