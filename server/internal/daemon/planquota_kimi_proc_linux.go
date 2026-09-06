//go:build linux

package daemon

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
)

// Linux identity proofs for the Kimi local server, all from /proc:
// socket ownership via /proc/net/tcp{,6} (the kernel records the listening
// socket's uid), process ownership via /proc/<pid>/status, and a process-name
// sanity check via /proc/<pid>/exe. The token file is 0600 same-user, so the
// trust boundary being enforced here is exactly "same user".

func kimiIdentitySupported() bool { return true }

// kimiSocketOwnedByUser reports whether every LISTEN socket that could serve
// a 127.0.0.1 dial on the port belongs to this process's effective user.
func kimiSocketOwnedByUser(port int) bool {
	var tables [][]byte
	for _, name := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		if raw, err := os.ReadFile(name); err == nil {
			tables = append(tables, raw)
		}
	}
	return loopbackListenOwnedByUID(port, os.Geteuid(), tables)
}

// kimiVerifyInstanceProcess binds a registry-claimed pid to a live, same-user
// process whose executable looks like the Kimi CLI. Anything else — dead pid,
// foreign owner, unrelated image (e.g. a recycled pid) — is an error, and the
// caller moves on without sending credentials.
func kimiVerifyInstanceProcess(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("invalid pid %d", pid)
	}
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return fmt.Errorf("process not readable: %w", err)
	}
	uid := -1
	for _, line := range strings.Split(string(status), "\n") {
		if rest, ok := strings.CutPrefix(line, "Uid:"); ok {
			fields := strings.Fields(rest)
			if len(fields) > 0 {
				uid, _ = strconv.Atoi(fields[0]) // real uid
			}
			break
		}
	}
	if uid < 0 {
		return fmt.Errorf("process %d: no uid in status", pid)
	}
	if uid != os.Geteuid() {
		return fmt.Errorf("process %d owned by uid %d, want %d", pid, uid, os.Geteuid())
	}
	// The CLI may be a native binary or a Node script (whose exe is "node"),
	// so accept when the image or any argv token's basename is kimi-ish
	// ("kimi", "kimi-code", "kimi.exe", a kimi-code install path member).
	exe, _ := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	cmdline, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	tokens := append([]string{exe}, strings.Split(string(cmdline), "\x00")...)
	if !kimiProcessTokensMatch(tokens) {
		return fmt.Errorf("process %d image is not kimi", pid)
	}
	return nil
}

// kimiEstablishedPeerOwnedByUser proves the accepting process of an
// established connection belongs to this user: it locates the server side of
// the connection's exact 4-tuple in /proc/net/tcp{,6} (an ESTABLISHED row,
// which carries the accepting process's uid) and compares it to our euid.
// Anything unprovable — a vanished row, a non-TCP conn — fails closed.
func kimiEstablishedPeerOwnedByUser(conn net.Conn) bool {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return false
	}
	local, ok1 := tcp.LocalAddr().(*net.TCPAddr)
	remote, ok2 := tcp.RemoteAddr().(*net.TCPAddr)
	if !ok1 || !ok2 {
		return false
	}
	var tables [][]byte
	for _, name := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		if raw, err := os.ReadFile(name); err == nil {
			tables = append(tables, raw)
		}
	}
	return establishedPeerOwnedByUID(remote.Port, local.Port, os.Geteuid(), tables)
}
