package media

import (
	"context"
	"errors"
	"github.com/multica-ai/multica/server/pkg/protocol"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestProfilesDoNotCopyCredentialsAndKeepStableIDs(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "auth.json"), []byte("fixture credential"), 0600); err != nil {
		t.Fatal(err)
	}
	a, err := OpenProfile(root, home, "sub1", "codex", true)
	if err != nil {
		t.Fatal(err)
	}
	b, err := OpenProfile(root, home, "sub2", "codex", true)
	if err != nil {
		t.Fatal(err)
	}
	again, err := OpenProfile(root, home, "sub1", "codex", false)
	if err != nil {
		t.Fatal(err)
	}
	if a.ExecutorID != again.ExecutorID || a.CredentialScopeID != again.CredentialScopeID {
		t.Fatal("identity changed on restart")
	}
	if a.ExecutorID == b.ExecutorID || a.CredentialScopeID == b.CredentialScopeID {
		t.Fatal("profiles share identity")
	}
	if _, err := os.Stat(filepath.Join(a.NativeDir, "auth.json")); !os.IsNotExist(err) {
		t.Fatal("default credentials copied")
	}
	if _, err := OpenProfile(root, home, "../escape", "codex", true); err == nil {
		t.Fatal("profile escaped root")
	}
}
func TestFlowWhiskShareScopeAndCrossProcessLock(t *testing.T) {
	if path := os.Getenv("MULTICA_TEST_MEDIA_LOCK"); path != "" {
		f, err := lockFile(path)
		if f != nil {
			f.Close()
		}
		if !errors.Is(err, ErrLocked) {
			os.Exit(2)
		}
		os.Exit(0)
	}
	root, home := t.TempDir(), t.TempDir()
	a, err := OpenProfile(root, home, "sub1", "flow", true)
	if err != nil {
		t.Fatal(err)
	}
	b, err := OpenProfile(root, home, "sub1", "whisk", true)
	if err != nil {
		t.Fatal(err)
	}
	if a.CredentialScopeID != b.CredentialScopeID || a.ExecutorID == b.ExecutorID {
		t.Fatal("Flow/Whisk identities wrong")
	}
	f, err := a.Lock()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestFlowWhiskShareScopeAndCrossProcessLock$")
	cmd.Env = append(os.Environ(), "MULTICA_TEST_MEDIA_LOCK="+filepath.Join(b.NativeDir, ".multica-media.lock"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child bypassed lock: %v %s", err, out)
	}
	f.Close()
	f, err = b.Lock()
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
}
func TestSymlinkAliasUsesSameCredentialScope(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	a, err := OpenProfile(root, home, "a", "flow", true)
	if err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "profiles", "b", "media", "native")
	if err := os.MkdirAll(alias, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(a.NativeDir, filepath.Join(alias, "google-browser")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	b, err := OpenProfile(root, home, "b", "flow", false)
	if err != nil {
		t.Fatal(err)
	}
	if a.CredentialScopeID != b.CredentialScopeID {
		t.Fatal("alias minted independent quota")
	}
	f, err := a.Lock()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if g, err := b.Lock(); !errors.Is(err, ErrLocked) {
		if g != nil {
			g.Close()
		}
		t.Fatalf("alias bypassed lock: %v", err)
	}
}

type fixtureExecutor struct{ readiness protocol.MediaReadiness }

func (f *fixtureExecutor) Probe(context.Context) (ProbeResult, error) {
	return ProbeResult{Readiness: f.readiness}, nil
}
func (*fixtureExecutor) Describe() Description {
	return Description{Provider: "codex", ResolvedProvider: "codex", Models: []string{"fixture-model"}, OutputFormats: []string{"png"}, MaxConcurrency: 1}
}
func (*fixtureExecutor) Submit(context.Context, Submission) (SubmissionResult, error) {
	panic("probe called Submit")
}
func (*fixtureExecutor) Recover(context.Context, Recovery) (SubmissionResult, error) {
	panic("unexpected Recover")
}
func (*fixtureExecutor) CollectArtifacts(context.Context, Recovery) ([]Artifact, error) {
	panic("unexpected collect")
}
func (*fixtureExecutor) Cancel(context.Context, Recovery) error { panic("unexpected cancel") }
func (*fixtureExecutor) ObserveQuota(context.Context) (*protocol.RuntimePlanQuota, error) {
	return nil, nil
}
func TestRegistryRevokesReadyForLogoutAndLockConflict(t *testing.T) {
	p, err := OpenProfile(t.TempDir(), t.TempDir(), "sub", "codex", true)
	if err != nil {
		t.Fatal(err)
	}
	native := &fixtureExecutor{readiness: protocol.MediaReady}
	r := NewRegistry([]Instance{{Profile: p, Executor: native}})
	r.Refresh(context.Background())
	if r.Snapshot().Executors[0].Readiness != protocol.MediaReady {
		t.Fatal("probe result not reported")
	}
	native.readiness = protocol.MediaNeedsAuth
	r.Refresh(context.Background())
	if r.Snapshot().Executors[0].Readiness != protocol.MediaNeedsAuth {
		t.Fatal("logout retained ready")
	}
	lock, err := p.Lock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	native.readiness = protocol.MediaReady
	r.Refresh(context.Background())
	if r.Snapshot().Executors[0].Readiness != protocol.MediaUnhealthy {
		t.Fatal("lock conflict retained ready")
	}
}
func TestRegistryNeverInfersReadyFromCredentials(t *testing.T) {
	p, err := OpenProfile(t.TempDir(), t.TempDir(), "sub", "codex", true)
	if err != nil {
		t.Fatal(err)
	}
	r := NewRegistry([]Instance{{Profile: p}})
	r.Refresh(context.Background())
	if r.Snapshot().Executors[0].Readiness != protocol.MediaUnsupported {
		t.Fatal("unverified native contract advertised")
	}
}
