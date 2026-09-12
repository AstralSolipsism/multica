//go:build !windows

package agent

import (
	"bytes"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// processAlive reports whether pid names a process that is still RUNNING.
//
// A signal-0 probe is the classic check, but it succeeds for zombies too — a
// process that has exited but whose parent has not reaped it. After a group
// SIGKILL the parent of a descendant is init (the descendant was orphaned and
// reparented), and container inits that are themselves daemons often never
// reap, so the probe alone reports killed descendants as "alive" forever.
// A zombie holds no pipes, no locks, and no CPU: for every property these
// tests guard against — leaked compute, held stdout, repository locks — a
// zombie is gone. So the probe is refined with the Linux /proc state letter
// where one is available; kernels without /proc keep the plain probe answer,
// which is correct there because their init reaps orphans promptly.
func processAlive(pid int) bool {
	if err := syscall.Kill(pid, 0); err != nil {
		return false // ESRCH or an unusable pid: nothing is running
	}
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return true // no /proc: fall back to the signal probe's answer
	}
	// comm is parenthesized and may itself contain parentheses; the state
	// letter is the first field after the last ')'.
	i := bytes.LastIndexByte(data, ')')
	if i < 0 || i+2 >= len(data) {
		return true
	}
	fields := strings.Fields(string(data[i+2:]))
	if len(fields) == 0 {
		return true
	}
	return fields[0][0] != 'Z'
}
