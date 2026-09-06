//go:build darwin

package daemon

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// macOS identity proofs for the Kimi local server via the system lsof and
// ps: the listening socket's owner uid (lsof field output) and the registry
// pid's uid + image (ps). The token file is 0600 same-user, so the trust
// boundary enforced here is exactly "same user".

func kimiIdentitySupported() bool { return true }

// kimiSocketOwnedByUser reports whether the port's LISTEN socket belongs to
// this process's effective user, from `lsof -F pu` field output (p<pid> /
// u<uid> records).
func kimiSocketOwnedByUser(port int) bool {
	out, err := exec.Command("lsof", "-nP", "-F", "pu",
		fmt.Sprintf("-iTCP:%d", port), "-sTCP:LISTEN").Output()
	if err != nil {
		return false // lsof exits 1 when nothing matches: nothing (ours) listens
	}
	return lsofListenersAllOwnedBy(string(out), os.Geteuid())
}

// lsofListenersAllOwnedBy parses -F pu output: at least one listener record,
// and every record's uid must match. Pid lines are ignored beyond grouping.
func lsofListenersAllOwnedBy(out string, uid int) bool {
	found := false
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			found = true
		case 'u':
			u, err := strconv.Atoi(line[1:])
			if err != nil || u != uid {
				return false
			}
		}
	}
	return found
}

// kimiVerifyInstanceProcess binds a registry-claimed pid to a live, same-user
// process whose image looks like the Kimi CLI.
func kimiVerifyInstanceProcess(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("invalid pid %d", pid)
	}
	out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "uid=,command=").Output()
	if err != nil {
		return fmt.Errorf("process %d not readable: %w", pid, err)
	}
	fields := strings.Fields(string(out))
	if len(fields) < 2 {
		return fmt.Errorf("process %d: unparsable ps output %q", pid, strings.TrimSpace(string(out)))
	}
	uid, err := strconv.Atoi(fields[0])
	if err != nil {
		return fmt.Errorf("process %d: bad uid %q", pid, fields[0])
	}
	if uid != os.Geteuid() {
		return fmt.Errorf("process %d owned by uid %d, want %d", pid, uid, os.Geteuid())
	}
	image := strings.ToLower(strings.Join(fields[1:], " "))
	if !strings.Contains(image, "kimi") {
		return fmt.Errorf("process %d image %q is not kimi", pid, image)
	}
	return nil
}
