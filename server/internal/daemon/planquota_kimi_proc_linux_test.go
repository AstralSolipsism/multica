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

// Real /proc integration for the per-round enumeration (the fixture matrix
// in planquota_kimi_test.go covers parsing; this proves the live path).
func TestKimiEnumerateOwnedListenPorts_LiveSocket(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	port := ln.Addr().(*net.TCPAddr).Port

	owned := kimiEnumerateOwnedListenPorts()
	if _, ok := owned[port]; !ok {
		t.Fatal("own listener missing from the owned set")
	}
	if _, ok := owned[port+1]; ok {
		t.Fatal("unused port reported as owned")
	}
}

// The production dialer (round enumeration + established-peer proof live)
// against a real same-user server passes end to end, so the hardening does
// not break the happy path.
func TestKimiDialerProductionProofsLiveSocket(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	// Hold accepted connections open — a closed peer leaves no ESTABLISHED
	// row to prove (correctly failing closed), which is not what we test
	// here. Cleanup order: close the listener first (unblocks Accept, which
	// then closes the channel), then drain and close held connections.
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

	collector := newKimiPlanQuotaCollector(t.TempDir())
	collector.roundOwned = kimiEnumerateOwnedListenPorts()
	conn, err := collector.dial(context.Background(), "tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("production dialer refused own server: %v", err)
	}
	_ = conn.Close()
}

// Native uid-handover regression: a foreign-uid process accepts our
// connection, releases its listener, and our user re-binds the port. Only
// then is the established-peer proof consulted — it must still name the
// foreign acceptor, even though the LISTEN set now contains the port again
// (the new listener is ours). Zero bytes are written to the foreign
// connection.
func TestKimiEstablishedPeerProof_ForeignAcceptedConnection(t *testing.T) {
	// Acceptance guard: this test must never alter shared directory
	// permissions. Assert /tmp's mode is untouched.
	tmpStat, err := os.Stat("/tmp")
	if err != nil {
		t.Fatal(err)
	}
	tmpModeBefore := tmpStat.Mode()
	t.Cleanup(func() {
		st, err := os.Stat("/tmp")
		if err != nil {
			t.Errorf("stat /tmp after test: %v", err)
			return
		}
		if st.Mode() != tmpModeBefore {
			t.Errorf("/tmp mode changed: %v -> %v", tmpModeBefore, st.Mode())
		}
	})
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
		if _, ok := kimiEnumerateOwnedListenPorts()[port]; !ok {
			t.Fatal("own listener missing from the owned set")
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

		// Dial the helper directly (no proof yet).
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
		if _, ok := kimiEnumerateOwnedListenPorts()[port]; !ok {
			t.Fatal("control broken: our re-bound listener missing from the owned set")
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
