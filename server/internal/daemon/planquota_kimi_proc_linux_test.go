//go:build linux

package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Exercise the full credential path as root, including the OL-117 attack:
// a stale owned-listener snapshot followed by a foreign process delaying
// accept. Synchronize accept around the real /proc proof so both sides of
// the race are deterministic. Only synthetic credentials leave the test.
func TestKimiCollect_RootPeerCredentials(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to exercise production euid and foreign-uid peers")
	}
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	const helper = `import json, socket, sys
ls = socket.socket()
ls.bind(("127.0.0.1", 0)); ls.listen(1)
print(json.dumps({"port": ls.getsockname()[1]}), flush=True)
sys.stdin.readline()
conn, _ = ls.accept()
ls.close()
print(json.dumps({"accepted": True}), flush=True)
conn.settimeout(5)
data = b""
while b"\r\n\r\n" not in data:
    chunk = conn.recv(4096)
    if not chunk: break
    data += chunk
if data:
    body = sys.argv[1].encode()
    conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
conn.close()
print(json.dumps({"received": len(data), "authenticated": b"Authorization: Bearer test-kimi-token\r\n" in data}), flush=True)
`
	for _, tc := range []struct {
		name              string
		uid               uint32
		acceptBeforeProof bool
		wantSuccess       bool
	}{
		{"root accepted", 0, true, true},
		{"root unaccepted", 0, false, false},
		{"foreign accepted", 65534, true, false},
		{"foreign delayed accept", 65534, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, python, "-u", "-c", helper, kimiLimitsJSON())
			cmd.Dir = "/"
			cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: tc.uid, Gid: tc.uid}}
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			stdin, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if cmd.ProcessState == nil {
					cancel()
					_ = cmd.Wait()
				}
			}()
			decoder := json.NewDecoder(stdout)
			var ready struct{ Port int }
			if err := decoder.Decode(&ready); err != nil || ready.Port <= 0 {
				t.Fatalf("peer readiness: port=%d err=%v", ready.Port, err)
			}
			accept := func() error {
				if _, err := io.WriteString(stdin, "accept\n"); err != nil {
					return err
				}
				var ack struct{ Accepted bool }
				if err := decoder.Decode(&ack); err != nil {
					return err
				}
				if !ack.Accepted {
					return fmt.Errorf("helper did not accept connection")
				}
				return nil
			}

			collector := newKimiPlanQuotaCollector(kimiTestHome(t, ready.Port))
			defer collector.client.CloseIdleConnections()
			collector.scanBase, collector.scanCount = ready.Port, 1
			if tc.uid != 0 {
				// Model ownership changing after the once-per-round LISTEN scan.
				collector.enumerateOwnedListenPorts = func() map[int]struct{} {
					return map[int]struct{}{ready.Port: {}}
				}
			}
			verify := collector.verifyConnPeer
			proofs := make(chan error, 1)
			collector.verifyConnPeer = func(conn net.Conn) bool {
				if tc.acceptBeforeProof {
					if err := accept(); err != nil {
						proofs <- err
						return false
					}
				}
				owned := verify(conn)
				var acceptErr error
				if !tc.acceptBeforeProof {
					acceptErr = accept()
				}
				proofs <- acceptErr
				return owned && acceptErr == nil
			}
			quota, collectErr := collector.collect(ctx)
			select {
			case err := <-proofs:
				if err != nil {
					t.Fatalf("synchronize peer accept: %v", err)
				}
			default:
				t.Fatalf("collection never reached the connection proof: %v", collectErr)
			}
			var evidence struct {
				Received      int
				Authenticated bool
			}
			if err := decoder.Decode(&evidence); err != nil {
				t.Fatalf("read peer evidence: %v", err)
			}
			if err := cmd.Wait(); err != nil {
				t.Fatalf("peer helper: %v; stderr: %s", err, stderr.String())
			}
			if tc.wantSuccess {
				if collectErr != nil || quota == nil {
					t.Fatalf("root collection: quota=%+v err=%v", quota, collectErr)
				}
				if quota.Status != protocol.PlanQuotaStatusOK || quota.ObservedAt <= 0 || len(quota.Windows) != 2 {
					t.Fatalf("root quota snapshot: %+v", quota)
				}
				if !evidence.Authenticated {
					t.Fatal("accepted root peer did not receive the credential")
				}
			} else {
				if evidence.Received != 0 {
					t.Fatalf("unproven peer received %d bytes", evidence.Received)
				}
				if collectErr == nil || quota != nil {
					t.Fatalf("unproven peer collected: quota=%+v err=%v", quota, collectErr)
				}
			}
		})
	}
}

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

// Before accept, Linux reports uid=0 inode=0 even for an established socket.
// That row must not prove ownership when the daemon itself happens to be root.
func TestKimiEstablishedPeerProof_UnacceptedConnection(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	conn, err := net.DialTimeout("tcp", ln.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	if kimiEstablishedPeerOwnedByUser(conn) {
		t.Fatal("unaccepted connection proved peer ownership")
	}
	// Accept assigns an inode and owner; the same connection now proves the uid.
	peer, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = peer.Close() }()
	if !kimiEstablishedPeerOwnedByUser(conn) {
		t.Fatal("accepted same-user connection did not prove peer ownership")
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
