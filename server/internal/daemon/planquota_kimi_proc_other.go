//go:build !linux && !darwin

package daemon

import (
	"errors"
	"net"
)

// Platforms without a cheap, reliable way to prove who accepted a loopback
// connection: the collector FAILS CLOSED — no proof, no credential delivery,
// and runtimes stay "not reported" (OL-5 R1).

var errKimiIdentityUnsupported = errors.New("cannot verify connection peer ownership on this platform")

func kimiIdentitySupported() bool { return false }

func kimiEnumerateOwnedListenPorts() map[int]struct{} { return nil }

// kimiEstablishedPeerOwnedByUser fails closed on platforms without a way to
// prove the accepting process of a loopback connection.
func kimiEstablishedPeerOwnedByUser(conn net.Conn) bool { return false }
