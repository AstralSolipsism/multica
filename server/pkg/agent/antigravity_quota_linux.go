//go:build linux

package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// antigravityQuotaProcessesImpl lists the pids of running agy processes whose
// command line matches the daemon's resolved executable (absolute path or
// basename). Best-effort: a missing or unreadable /proc yields no candidates,
// which the caller reports as "no running agy process".
func antigravityQuotaProcessesImpl(execPath string) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	base := filepath.Base(execPath)
	var pids []int
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			// Not a numeric /proc entry (boot cpuinfo, sys, ...) — skip.
			continue
		}
		cmdline, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "cmdline"))
		if err != nil {
			// The process may have exited between ReadDir and here, or belong
			// to another user; either way it is not a candidate.
			continue
		}
		// cmdline is NUL-separated argv; only argv[0] identifies the binary.
		argv0, _, ok := strings.Cut(string(cmdline), "\x00")
		if !ok {
			continue
		}
		if antigravityExecutableMatches([]string{argv0}, execPath, base) {
			pids = append(pids, pid)
		}
	}
	return pids
}

// listeningLoopbackPorts returns the TCP ports a process is listening on, read
// straight from /proc (no external tools): the process's socket inodes are
// matched against the system-wide LISTEN tables for IPv4 and IPv6. The caller
// only ever dials 127.0.0.1, so a listener bound to a wider address is still
// reached over loopback.
func listeningLoopbackPorts(pid int) []int {
	inodes := procSocketInodes(pid)
	if len(inodes) == 0 {
		return nil
	}
	seen := make(map[int]bool)
	var ports []int
	for _, table := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		data, err := os.ReadFile(table)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n")[1:] {
			fields := strings.Fields(line)
			// Columns: sl, local_address, rem_address, st, ... inode. The
			// header line was dropped above; malformed lines are skipped.
			if len(fields) < 10 {
				continue
			}
			// st 0A is TCP_LISTEN.
			if fields[3] != "0A" {
				continue
			}
			inode, err := strconv.ParseUint(fields[9], 10, 64)
			if err != nil || !inodes[inode] {
				continue
			}
			_, portText, ok := strings.Cut(fields[1], ":")
			if !ok {
				continue
			}
			port, err := strconv.ParseUint(portText, 16, 16)
			if err != nil || port == 0 || seen[int(port)] {
				continue
			}
			seen[int(port)] = true
			ports = append(ports, int(port))
		}
	}
	return ports
}

// procSocketInodes collects the socket inodes a process holds by reading the
// socket:[<inode>] symlinks under /proc/<pid>/fd.
func procSocketInodes(pid int) map[uint64]bool {
	fdDir := filepath.Join("/proc", strconv.Itoa(pid), "fd")
	names, err := os.ReadDir(fdDir)
	if err != nil {
		return nil
	}
	inodes := make(map[uint64]bool)
	for _, name := range names {
		link, err := os.Readlink(filepath.Join(fdDir, name.Name()))
		if err != nil {
			continue
		}
		var inode uint64
		if _, err := fmt.Sscanf(link, "socket:[%d]", &inode); err != nil {
			continue
		}
		inodes[inode] = true
	}
	return inodes
}
