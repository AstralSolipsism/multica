//go:build !windows

package processtree

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const processTreeFinishTimeout = 5 * time.Second

type controller struct{}

func newController(cmd *exec.Cmd) (*controller, error) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	return &controller{}, nil
}

func (*controller) attach(_ *exec.Cmd) error { return nil }

func (*controller) interrupt(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return os.ErrProcessDone
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	return nil
}

func (*controller) stop(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return os.ErrProcessDone
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return cmd.Process.Kill()
	}
	return nil
}

func (c *controller) finish(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	pid := cmd.Process.Pid
	if err := syscall.Kill(-pid, 0); errors.Is(err, syscall.ESRCH) {
		return nil
	}
	// A normally-exited leader can still leave a descendant holding inherited
	// pipes or repository locks. Kill the remaining group before returning
	// ownership of the repository to another operation.
	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	deadline := time.Now().Add(processTreeFinishTimeout)
	for time.Now().Before(deadline) {
		if !processGroupAlive(pid) {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return fmt.Errorf("process group %d still active after %s", pid, processTreeFinishTimeout)
}

// processGroupAlive reports whether pgid still names a process group with a
// live member. A signal-0 probe on the group succeeds even when every
// remaining member is a zombie — a process that has exited but whose new
// parent has not reaped it yet. That parent is init, and container inits that
// are themselves daemons often never reap reparented orphans, so the signal
// probe alone can report a group as "still active" long after every member
// has died. Zombies hold no pipes, no locks, and no CPU; once SIGKILL has
// been delivered to the group, zombies are the only possible residue, and a
// group of zombies is finished for every purpose of this package. /proc is
// Linux-only, so a kernel without it keeps the conservative signal-probe
// answer (on those kernels init reaps orphans promptly anyway).
func processGroupAlive(pgid int) bool {
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

func (*controller) close() {}
