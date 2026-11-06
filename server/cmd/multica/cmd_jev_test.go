package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const cliEvaluation = `{"state":{"reader":"board reader","text":"product context"},"questions":{"need":{"type":"score","instructions":"judge clarity","criteria":["clear","minor","heavy","opaque"]}}}`
const cliEvaluationTask = "12345678-1234-1234-1234-123456789abc"

func TestJevEvaluateFileAndStdin(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/tasks/"+cliEvaluationTask+"/jev-evaluate" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer mat_test" {
			t.Error("wrong task request")
		}
		body, _ := io.ReadAll(r.Body)
		var payload map[string]any
		if json.Unmarshal(body, &payload) != nil || len(payload) != 2 || payload["state"] == nil || payload["questions"] == nil {
			t.Error("unexpected transport input")
		}
		io.WriteString(w, `{"ok":true,"answers":{"need":{"score":2}},"latency_ms":12,"daemon_version":"test-version"}`)
	}))
	defer srv.Close()
	t.Setenv("MULTICA_DAEMON_PORT", strings.TrimPrefix(srv.URL, "http://127.0.0.1:"))
	t.Setenv("MULTICA_TASK_ID", cliEvaluationTask)
	t.Setenv("MULTICA_TOKEN", "mat_test")
	path := filepath.Join(t.TempDir(), "evaluation.json")
	if err := os.WriteFile(path, []byte(cliEvaluation), 0600); err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{"-", path} {
		cmd := newJevCmd()
		var out bytes.Buffer
		cmd.SetOut(&out)
		cmd.SetErr(io.Discard)
		cmd.SetIn(strings.NewReader(cliEvaluation))
		cmd.SetArgs([]string{"evaluate", "--input-file", input, "--output", "json"})
		if err := cmd.Execute(); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), `"score": 2`) || !strings.Contains(out.String(), `"daemon_version": "test-version"`) {
			t.Fatal(out.String())
		}
	}
	if calls != 2 {
		t.Fatal(calls)
	}
}

func TestJevEvaluateRejectsInfrastructureAndInvalidInput(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer srv.Close()
	t.Setenv("MULTICA_DAEMON_PORT", strings.TrimPrefix(srv.URL, "http://127.0.0.1:"))
	t.Setenv("MULTICA_TASK_ID", cliEvaluationTask)
	t.Setenv("MULTICA_TOKEN", "mat_test")
	for _, flag := range []string{"--url", "--sources", "--model", "--api-key"} {
		cmd := newJevCmd()
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		cmd.SetIn(strings.NewReader(cliEvaluation))
		cmd.SetArgs([]string{"evaluate", "--input-file", "-", flag, "override"})
		if cmd.Execute() == nil {
			t.Fatalf("accepted %s", flag)
		}
	}
	for _, body := range []string{`{}`, cliEvaluation + `{}`, strings.Replace(cliEvaluation, `"state":`, `"model":"override","state":`, 1)} {
		cmd := newJevCmd()
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		cmd.SetIn(strings.NewReader(body))
		cmd.SetArgs([]string{"evaluate", "--input-file", "-"})
		if cmd.Execute() == nil {
			t.Fatal("accepted invalid input")
		}
	}
	for _, token := range []string{"", "owner-token"} {
		t.Setenv("MULTICA_TOKEN", token)
		cmd := newJevCmd()
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		cmd.SetIn(strings.NewReader(cliEvaluation))
		cmd.SetArgs([]string{"evaluate", "--input-file", "-"})
		if cmd.Execute() == nil {
			t.Fatal("accepted owner or missing token")
		}
	}
	if calls != 0 {
		t.Fatalf("unexpected network calls: %d", calls)
	}
}

func TestJevEvaluateFailureAndRedirect(t *testing.T) {
	for _, mode := range []string{"unavailable", "old-daemon", "malformed", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			leaks := 0
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaks++ }))
			defer target.Close()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch mode {
				case "unavailable":
					io.WriteString(w, `{"ok":false,"reason":"timeout","latency_ms":10}`)
				case "old-daemon":
					http.Error(w, "private error", 404)
				case "malformed":
					io.WriteString(w, `{"ok":true} trailing`)
				case "redirect":
					http.Redirect(w, r, target.URL, 307)
				}
			}))
			defer srv.Close()
			t.Setenv("MULTICA_DAEMON_PORT", strings.TrimPrefix(srv.URL, "http://127.0.0.1:"))
			t.Setenv("MULTICA_TASK_ID", cliEvaluationTask)
			t.Setenv("MULTICA_TOKEN", "mat_test")
			cmd := newJevCmd()
			var out bytes.Buffer
			cmd.SetOut(&out)
			cmd.SetErr(io.Discard)
			cmd.SetIn(strings.NewReader(cliEvaluation))
			cmd.SetArgs([]string{"evaluate", "--input-file", "-", "--output", "json"})
			err := cmd.Execute()
			if err == nil {
				t.Fatal("failure returned success")
			}
			if mode == "unavailable" && (!strings.Contains(out.String(), `"ok": false`) || err != errSilent) {
				t.Fatalf("%v %s", err, out.String())
			}
			if leaks != 0 || strings.Contains(err.Error(), "private error") {
				t.Fatal("credential or upstream error leaked")
			}
		})
	}
}
