//go:build linux

package daemon

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

// Native round-5 regression: a foreign-uid process accepts our connection,
// releases its listener, and our user re-binds the port. A LISTEN-based
// check passes (the new listener is ours) — yet the connection we actually
// hold belongs to uid 65534, and the established-peer proof must refuse it
// before a single byte is written.
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
        if b"\r\n\r\n" in data:
            conn.sendall(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 38\r\nConnection: close\r\n\r\n{\"code\":40101,\"msg\":\"missing bearer\"}")
except OSError:
    pass
open(outlog, "wb").write(data)
conn.close()
`
	dir, err := os.MkdirTemp("", "ol5-peerproof")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o777); err != nil { // the nobody helper must read AND write here
		t.Fatal(err)
	}
	// The task TMPDIR chain can be 0700; make every level traversable.
	for d := dir; d != "/" && strings.HasPrefix(d, os.TempDir()); d = filepath.Dir(d) {
		_ = os.Chmod(d, 0o777)
	}
	script := filepath.Join(dir, "helper.py")
	if err := os.WriteFile(script, []byte(helper), 0o755); err != nil {
		t.Fatal(err)
	}

	run := func(t *testing.T, uid int, expectDialOK bool) {
		t.Helper()
		lnA, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := lnA.Addr().(*net.TCPAddr).Port
		// Pre-dial: our listener passes the production LISTEN check.
		if !kimiSocketOwnedByUser(port) {
			t.Fatal("own listener failed the LISTEN check")
		}
		_ = lnA.Close()

		suffix := fmt.Sprintf("-%d-%d", uid, port)
		ready := filepath.Join(dir, "ready"+suffix)
		accepted := filepath.Join(dir, "accepted"+suffix)
		outlog := filepath.Join(dir, "out"+suffix)
		errlog := filepath.Join(dir, "err"+suffix)
		ef, _ := os.Create(errlog)
		cmd := exec.Command("setpriv", fmt.Sprintf("--reuid=%d", uid), "--clear-groups", "--",
			"python3", script, fmt.Sprint(port), ready, accepted, outlog)
		cmd.Stderr = ef
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = cmd.Process.Kill(), cmd.Wait()
			_ = ef.Close()
			if t.Failed() {
				if raw, rerr := os.ReadFile(errlog); rerr == nil && len(raw) > 0 {
					t.Logf("helper stderr: %s", raw)
				}
			}
		})
		t.Cleanup(func() { _, _ = cmd.Process.Kill(), cmd.Wait() })
		waitForFile(t, ready)

		// The production dialer now connects to the FOREIGN helper. The
		// established-peer proof must refuse before any byte is written.
		conn, err := loopbackOwnedDialContext(context.Background(), "tcp",
			fmt.Sprintf("127.0.0.1:%d", port), nil, kimiEstablishedPeerOwnedByUser)
		if expectDialOK {
			if err != nil {
				t.Fatalf("same-uid dial refused: %v", err)
			}
			_ = conn.Close()
			return
		}
		if err == nil {
			_ = conn.Close()
			t.Fatal("foreign-uid peer accepted by the dialer")
		}

		// The blind spot is real: once our user re-binds the port, the
		// LISTEN check passes again — while the (refused) connection still
		// belonged to the foreign process.
		waitForFile(t, accepted)
		lnA2, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Fatalf("re-bind as our user: %v", err)
		}
		defer func() { _ = lnA2.Close() }()
		if !kimiSocketOwnedByUser(port) {
			t.Fatal("control broken: our re-bound listener fails the LISTEN check")
		}

		// Zero bytes reached the foreign process (it logs everything it
		// receives; EOF on our close writes the file).
		waitForFile(t, outlog)
		raw, _ := os.ReadFile(outlog)
		if len(raw) != 0 {
			t.Fatalf("foreign process received %d bytes: %q", len(raw), raw)
		}
	}

	t.Run("foreign uid refused, zero bytes", func(t *testing.T) { run(t, 65534, false) })
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
