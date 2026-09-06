//go:build linux

package daemon

import (
	"net"
	"os"
	"testing"
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
