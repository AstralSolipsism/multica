//go:build linux

package daemon

import (
	"net"
	"os"
)

// Linux identity probes for the Kimi local server, all from /proc. The token
// file is 0600 same-user, so the trust boundary being enforced is exactly
// "same user".

func kimiIdentitySupported() bool { return true }

// kimiEnumerateOwnedListenPorts reads /proc/net/tcp{,6} once and returns the
// set of ports whose loopback-serving LISTEN sockets belong to this user.
// One enumeration per collect round — never a per-port re-read.
func kimiEnumerateOwnedListenPorts() map[int]struct{} {
	var tables [][]byte
	for _, name := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		if raw, err := os.ReadFile(name); err == nil {
			tables = append(tables, raw)
		}
	}
	return ownedLoopbackListenPorts(os.Geteuid(), tables)
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
