//go:build unix

package agent

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func piSkillInvocation(t *testing.T) (*SkillInvocation, string) {
	t.Helper()
	dir := t.TempDir()
	skillDir := filepath.Join(dir, "first-multica")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	s := &SkillInvocation{
		Prompt:         "Platform context\nsecond line",
		PlatformPrompt: "Platform context",
		UserMessage:    "run the review",
		Skills: []ExplicitSkill{
			{Name: "first-multica", Directory: skillDir, Body: "FIRST BODY"},
			{Name: "second", Directory: filepath.Join(dir, "second"), Body: "SECOND BODY"},
		},
	}
	return s, filepath.Join(skillDir, "SKILL.md")
}

func TestPiSkillPromptNativeAndFallback(t *testing.T) {
	s, skillFile := piSkillInvocation(t)

	native := s.piSkillPrompt([]string{skillFile}, nil)
	if !strings.HasPrefix(native, "/skill:first-multica Platform context\nsecond line") {
		t.Fatalf("native prompt must lead with the pi skill token: %q", native)
	}
	if strings.Contains(native, "FIRST BODY") || !strings.Contains(native, "SECOND BODY") {
		t.Fatalf("first skill must expand natively, the rest inject: %q", native)
	}

	for _, tc := range []struct {
		name  string
		files []string
		args  []string
	}{
		{"skill file not in dispatch", nil, nil},
		{"other files only", []string{filepath.Join(t.TempDir(), "other", "SKILL.md")}, nil},
		{"skills disabled", []string{skillFile}, []string{"--no-skills"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := s.piSkillPrompt(tc.files, tc.args)
			if strings.HasPrefix(got, "/skill:") {
				t.Fatalf("must fall back, got native: %q", got)
			}
			if !strings.Contains(got, "FIRST BODY") || !strings.Contains(got, "SECOND BODY") {
				t.Fatalf("fallback must inject every skill body: %q", got)
			}
		})
	}
}

// piSkillStdinProbe runs a backend against a fake CLI that records stdin and
// emits a minimal successful event stream. builtin mirrors the daemon's
// Config.BuiltinRuntime for the provider under test.
func piSkillStdinProbe(t *testing.T, provider string, opts ExecOptions, builtin bool) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	stdinPath := filepath.Join(dir, "stdin.txt")
	// omp requires the runtime itself to persist a transcript into its
	// --session-dir before exit; pi only needs the event stream.
	script := fmt.Sprintf(`#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-dir) sessdir="$2" ;;
  esac
  shift
done
cat > %[1]s
if [ -n "$sessdir" ]; then
  printf '%%s\n' '{"type":"session","id":"s"}' > "$sessdir/runtime-chosen.jsonl"
fi
printf '%%s\n' '{"type":"agent_end"}'
`, stdinPath)
	fakePath := filepath.Join(dir, provider)
	writeTestExecutable(t, fakePath, []byte(script))
	backend, err := ResolveBackend(provider, Config{ExecutablePath: fakePath, Logger: slog.Default(), BuiltinRuntime: builtin})
	if err != nil {
		t.Fatal(err)
	}
	prompt := "unused prompt"
	if (provider == "omp" || !builtin) && opts.SkillInvocation != nil {
		// The backend never rewrites the prompt for omp or a custom
		// protocol-family profile; the daemon hands every non-native runtime
		// the fallback text up front.
		prompt = opts.SkillInvocation.FallbackPrompt()
	}
	session, err := backend.Execute(t.Context(), prompt, opts)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	result := <-session.Result
	if result.Status != "completed" {
		t.Fatalf("result: %+v", result)
	}
	data, err := os.ReadFile(stdinPath)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestPiExecuteSendsNativeSkillPromptOnStdin(t *testing.T) {
	s, skillFile := piSkillInvocation(t)
	stdin := piSkillStdinProbe(t, "pi", ExecOptions{
		Timeout:         10 * time.Second,
		SkillInvocation: s,
		PiSkillPaths:    []string{skillFile},
	}, true)
	if !strings.HasPrefix(stdin, "/skill:first-multica ") {
		t.Fatalf("pi must receive the native skill token first: %q", stdin)
	}
	if !strings.Contains(stdin, "Platform context") || !strings.Contains(stdin, "SECOND BODY") {
		t.Fatalf("pi prompt lost platform text or injected skills: %q", stdin)
	}
}

// TestPiProfileExecuteKeepsInjectionFallback pins the custom-profile gate: a
// protocol-family profile is not the vendor's binary, so its "/skill:" grammar
// is unverified and the native token must never be sent.
func TestPiProfileExecuteKeepsInjectionFallback(t *testing.T) {
	s, skillFile := piSkillInvocation(t)
	stdin := piSkillStdinProbe(t, "pi", ExecOptions{
		Timeout:         10 * time.Second,
		SkillInvocation: s,
		PiSkillPaths:    []string{skillFile},
	}, false)
	if strings.HasPrefix(stdin, "/skill:") {
		t.Fatalf("a custom pi-family profile must not receive the native token: %q", stdin)
	}
	if !strings.Contains(stdin, "FIRST BODY") || !strings.Contains(stdin, "Platform context") {
		t.Fatalf("the profile must receive the full fallback prompt: %q", stdin)
	}
}

func TestOmpExecuteKeepsInjectionFallback(t *testing.T) {
	s, skillFile := piSkillInvocation(t)
	stdin := piSkillStdinProbe(t, "omp", ExecOptions{
		Timeout:         10 * time.Second,
		SkillInvocation: s,
		PiSkillPaths:    []string{skillFile},
	}, true)
	if strings.HasPrefix(stdin, "/skill:") {
		t.Fatalf("omp never command-dispatches its stdin prompt; native token must not be sent: %q", stdin)
	}
	if !strings.Contains(stdin, "FIRST BODY") || !strings.Contains(stdin, "Platform context") {
		t.Fatalf("omp must receive the full fallback prompt: %q", stdin)
	}
}
