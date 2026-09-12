//go:build !windows

package agent

import (
	"bytes"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// hideAgentWindow is a no-op on non-Windows platforms.
func hideAgentWindow(cmd *exec.Cmd) {}

// configureProcessGroup puts the child into its own process group (it becomes
// the group leader, so the group id equals the child pid). This lets the
// daemon signal the entire tree — the agent CLI plus any tool subprocess it
// spawns — in one call, instead of killing only the direct child and leaking
// grandchildren that keep running (and, for opencode, spinning on EPIPE) after
// a task is cancelled or the daemon restarts. See signalProcessGroup.
//
// Called by newRuntimeCmd in launch.go, which is the single point where a
// runtime process is constructed. No backend calls it directly: the group has
// to exist for every runtime process, and per-backend opt-in did not deliver
// that (GH #7522).
func configureProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// startOwnedProcessTree is a plain Start on non-Windows platforms:
// newRuntimeCmd already put the child in its own process group before it
// existed, so there is nothing left to claim once it is running. The logger is
// unused here; Windows needs it to report degraded ownership.
//
// It is still the only way this package starts a long-lived runtime process,
// so the two platforms share one call site per backend.
func startOwnedProcessTree(cmd *exec.Cmd, _ *slog.Logger) error { return cmd.Start() }

// releaseProcessGroup is a no-op on non-Windows platforms: a process group needs
// no handle and is gone once its members are.
func releaseProcessGroup(cmd *exec.Cmd) {}

func codexInitializeRetrySupported() bool { return true }

// signalProcessGroup sends sig to the whole process group led by the command
// (when it was started with configureProcessGroup), falling back to the single
// process if the group send fails. Targeting the group (negative pid) reaches
// the descendants the agent spawned, not just the leader.
func signalProcessGroup(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if err := syscall.Kill(-cmd.Process.Pid, sig); err != nil {
		_ = cmd.Process.Signal(sig)
	}
}

func waitProcessGroupGone(cmd *exec.Cmd, timeout time.Duration) bool {
	if cmd == nil || cmd.Process == nil {
		return false
	}
	deadline := time.Now().Add(timeout)
	for {
		if !processGroupAlive(cmd.Process.Pid) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// processGroupAlive reports whether the group led by pgid still has a live
// member. A signal-0 probe on the group succeeds even when every remaining
// member is a zombie — a process that has exited but whose new parent has not
// reaped it. After a group SIGKILL the only possible residue is zombies,
// because each orphan's new parent is init, and container inits that are
// themselves daemons often never reap reparented orphans. Zombies hold no
// pipes, no locks, and no CPU, so a group whose members are all zombies is
// gone for every purpose of the callers (cleanup confirmation, repository and
// terminal ownership). /proc is Linux-only; a kernel without it keeps the
// conservative signal-probe answer, which is correct there because their init
// reaps orphans promptly.
func processGroupAlive(pgid int) bool {
	// A reaped group needs no /proc scan. On busy hosts, walking every
	// process here can exceed the caller's entire interrupt deadline.
	if err := syscall.Kill(-pgid, 0); err == syscall.ESRCH {
		return false
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return syscall.Kill(-pgid, 0) == nil
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue // not a process entry
		}
		if state, memberPgid, ok := procStatStateAndPgid(pid); ok && memberPgid == pgid && state != 'Z' {
			return true
		}
	}
	return false
}

// procStatStateAndPgid reads one process's state letter and process-group id
// from /proc/<pid>/stat. ok is false when the process vanished mid-scan or
// the kernel does not expose /proc.
func procStatStateAndPgid(pid int) (state byte, pgid int, ok bool) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, 0, false
	}
	// comm is parenthesized and may itself contain parentheses; every field
	// after it is fixed-position, so parse from the last ')'.
	i := bytes.LastIndexByte(data, ')')
	if i < 0 || i+2 >= len(data) {
		return 0, 0, false
	}
	fields := strings.Fields(string(data[i+2:]))
	if len(fields) < 3 {
		return 0, 0, false
	}
	pgid, err = strconv.Atoi(fields[2])
	if err != nil {
		return 0, 0, false
	}
	return fields[0][0], pgid, true
}
