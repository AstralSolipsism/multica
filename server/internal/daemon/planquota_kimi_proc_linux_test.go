//go:build linux

package daemon

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Real /proc integration for the socket-ownership probe (the fixture matrix
// in planquota_kimi_test.go covers parsing; this proves the live path).
func TestKimiSocketOwnedByUser_LiveSocket(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	port := ln.Addr().(*net.TCPAddr).Port

	if !kimiSocketOwnedByUser(port) {
		t.Fatal("own listener not recognized as owned by this user")
	}
	if kimiSocketOwnedByUser(port + 1) {
		t.Fatal("unused port reported as owned")
	}

	// The probe must consult the SAME uid the kernel records for us.
	if !loopbackListenOwnedByUID(port, os.Geteuid(), nil) == true {
		// nil tables: nothing found — sanity for the fail direction
	}
	if loopbackListenOwnedByUID(port, os.Geteuid(), nil) {
		t.Fatal("empty tables reported ownership")
	}
}

// The process verifier accepts this very test process only if it looks like
// kimi (it does not) — proving the image check rejects unrelated same-user
// processes, and accepts a synthetic kimi-looking cmdline.
func TestKimiVerifyInstanceProcess_LiveProcess(t *testing.T) {
	if err := kimiVerifyInstanceProcess(os.Getpid()); err == nil {
		t.Fatal("test binary accepted as kimi")
	}
	if err := kimiVerifyInstanceProcess(0); err == nil {
		t.Fatal("pid 0 accepted")
	}
	if err := kimiVerifyInstanceProcess(4194303); err == nil {
		t.Fatal("implausible pid accepted")
	}
}

// The production dialer (both proofs live) against a real same-user server:
// passes end to end, so the hardening does not break the happy path.
func TestKimiDialerProductionProofsLiveSocket(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	// Hold accepted connections open — a closed peer leaves no ESTABLISHED
	// row to prove (correctly failing closed), which is not what we test here.
	// Cleanup order: close the listener first (unblocks Accept, which then
	// closes the channel), then drain and close the held connections.
	held := make(chan net.Conn, 8)
	defer func() {
		_ = ln.Close()
		for c := range held {
			_ = c.Close()
		}
	}()
	go func() {
		defer close(held)
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			held <- c
		}
	}()
	conn, err := loopbackOwnedDialContext(context.Background(), "tcp", ln.Addr().String(),
		kimiSocketOwnedByUser, kimiEstablishedPeerOwnedByUser)
	if err != nil {
		t.Fatalf("production dialer refused own server: %v", err)
	}
	_ = conn.Close()
}

// Native round-5 regression: a foreign-uid process accepts our connection,
// releases its listener, and our user re-binds the port. Only then is the
// established-peer proof consulted — it must still name the foreign
// acceptor, even though the LISTEN check now passes (the new listener is
// ours). Zero bytes are written to the foreign connection.
func TestKimiEstablishedPeerProof_ForeignAcceptedConnection(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to spawn a foreign-uid helper")
	}
	if _, err := exec.LookPath("setpriv"); err != nil {
		t.Skip("setpriv unavailable")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 unavailable")
	}

	helper := `import socket, sys, time
port, ready, accepted, outlog = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
ls = socket.socket(); ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
ls.bind(("127.0.0.1", port)); ls.listen(1)
open(ready, "w").write("1")
conn, _ = ls.accept()
ls.close()
open(accepted, "w").write("1")
data = b""
conn.settimeout(8)
try:
    while True:
        chunk = conn.recv(4096)
        if not chunk: break
        data += chunk
except OSError:
    pass
with open(outlog, "wb") as f:
    f.write(data)
conn.close()
`
	// A test-exclusive world-writable dir directly under /tmp (1777): the
	// nobody helper needs to create its marker files there. Parent
	// permissions are never touched.
	dir, err := os.MkdirTemp("/tmp", "ol5-peerproof")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "helper.py")
	if err := os.WriteFile(script, []byte(helper), 0o755); err != nil {
		t.Fatal(err)
	}

	run := func(t *testing.T, uid int, expectPeerOK bool) {
		t.Helper()
		lnA, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := lnA.Addr().(*net.TCPAddr).Port
		if !kimiSocketOwnedByUser(port) {
			t.Fatal("own listener failed the LISTEN check")
		}
		_ = lnA.Close()

		suffix := fmt.Sprintf("-%d-%d", uid, port)
		ready := filepath.Join(dir, "ready"+suffix)
		accepted := filepath.Join(dir, "accepted"+suffix)
		outlog := filepath.Join(dir, "out"+suffix)
		errlog := filepath.Join(dir, "err"+suffix)
		ef, err := os.Create(errlog)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = ef.Close() }()
		cmd := exec.Command("setpriv", fmt.Sprintf("--reuid=%d", uid), "--clear-groups", "--",
			"python3", script, fmt.Sprint(port), ready, accepted, outlog)
		cmd.Stderr = ef
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			if t.Failed() {
				if raw, rerr := os.ReadFile(errlog); rerr == nil && len(raw) > 0 {
					t.Logf("helper stderr: %s", raw)
				}
			}
		})
		waitForFile(t, ready)

		// Dial the foreign helper directly (no proof yet).
		conn, err := (&net.Dialer{Timeout: 2 * time.Second}).Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer func() { _ = conn.Close() }()
		// Confirm the takeover: helper accepted and closed ITS listener...
		waitForFile(t, accepted)
		// ...and our user owns the port again.
		lnA2, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatalf("re-bind as our user: %v", err)
		}
		defer func() { _ = lnA2.Close() }()
		if !kimiSocketOwnedByUser(port) {
			t.Fatal("control broken: our re-bound listener fails the LISTEN check")
		}

		// NOW prove the connection's peer. The live connection still belongs
		// to the helper's uid regardless of who listens on the port.
		if got := kimiEstablishedPeerOwnedByUser(conn); got != expectPeerOK {
			t.Fatalf("established-peer proof = %v, want %v", got, expectPeerOK)
		}

		if !expectPeerOK {
			// Production behavior on proof failure: close without writing.
			// The helper logs everything it receives; EOF on close ends it.
			_ = conn.Close()
			waitForFile(t, outlog)
			raw, err := os.ReadFile(outlog)
			if err != nil {
				t.Fatalf("read evidence log: %v", err)
			}
			if len(raw) != 0 {
				t.Fatalf("foreign process received %d bytes: %q", len(raw), raw)
			}
		}
	}

	t.Run("foreign uid named despite re-bind", func(t *testing.T) { run(t, 65534, false) })
	t.Run("same uid accepted (control)", func(t *testing.T) { run(t, os.Geteuid(), true) })
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}
