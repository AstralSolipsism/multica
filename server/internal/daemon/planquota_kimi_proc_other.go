//go:build !linux && !darwin

package daemon

import (
	"errors"
	"fmt"
)

// Platforms without a cheap, reliable way to prove that a loopback listener
// or registry pid belongs to this user: the collector FAILS CLOSED — no
// identity proof, no credential delivery, and the runtime stays "not
// reported" (OL-5 R1: an unverifiable peer must never receive the token).
// Extending support means implementing the two probes below for the
// platform (e.g. Windows: Get-NetTCPConnection + process owner via CIM).

var errKimiIdentityUnsupported = errors.New("cannot verify local server identity on this platform")

func kimiIdentitySupported() bool { return false }

func kimiSocketOwnedByUser(port int) bool { return false }

func kimiVerifyInstanceProcess(pid int) error {
	return fmt.Errorf("pid %d: %w", pid, errKimiIdentityUnsupported)
}
