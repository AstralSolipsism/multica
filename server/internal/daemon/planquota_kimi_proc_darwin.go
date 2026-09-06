//go:build darwin

package daemon

import (
	"fmt"
	"net"
	"os"
	"os/exec"
)

// macOS identity probes for the Kimi local server via the system lsof. The
// token file is 0600 same-user, so the trust boundary being enforced is
// exactly "same user".

func kimiIdentitySupported() bool { return true }

// kimiEnumerateOwnedListenPorts runs lsof once and returns the set of ports
// whose loopback-serving LISTEN sockets belong to this user. One enumeration
// per collect round — never a per-port spawn.
func kimiEnumerateOwnedListenPorts() map[int]struct{} {
	out, err := exec.Command("lsof", "-nP", "-F", "pun", "-sTCP:LISTEN", "-iTCP").Output()
	if err != nil {
		return map[int]struct{}{}
	}
	return lsofOwnedListenPorts(string(out), os.Geteuid())
}

// kimiEstablishedPeerOwnedByUser proves the accepting process of an
// established connection belongs to this user via lsof: the server-direction
// tuple 127.0.0.1:<port>->127.0.0.1:<ephemeral> must be owned by our uid.
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
	out, err := exec.Command("lsof", "-nP", "-F", "pun",
		fmt.Sprintf("-iTCP:%d", remote.Port), "-sTCP:ESTABLISHED").Output()
	if err != nil {
		return false
	}
	return lsofEstablishedPeerOwnedBy(string(out), remote.Port, local.Port, os.Geteuid())
}
