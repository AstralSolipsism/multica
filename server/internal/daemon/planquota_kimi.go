package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Kimi plan-quota collector: observes the Kimi Code local Server API
// (experimental) on this machine and normalizes its plan usage rows into a
// plan-quota snapshot for every kimi runtime registered on this daemon.
//
// Source contract (https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html):
//   - `kimi web` serves http://127.0.0.1:58627, retrying busy ports with +1
//     (up to 100), and registers running instances under
//     ~/.kimi-code/server/instances/.
//   - The bearer token is generated on first server boot and persisted at
//     ~/.kimi-code/server.token (mode 0600). It never leaves this machine.
//   - Failed authentication returns HTTP 401 with envelope code 40101;
//     GET /api/v1/oauth/usage answers the envelope
//     {code, msg, data:{kind:"ok", limits:[...]}} and reports upstream
//     failures in-band as data.kind:"error".
//
// Credential safety (OL-5 R1): the token is sent only to a peer that proves
// itself BEFORE receiving any credential —
//  1. the candidate port's LISTEN socket must belong to this process's own
//     user (Linux /proc/net/tcp{,6} uid check; skipped where /proc is
//     unavailable), which rules out ports claimed by other users' processes;
//  2. the peer must answer an UNAUTHENTICATED /api/v1/oauth/usage probe with
//     exactly HTTP 401 and envelope code 40101 — Kimi's auth-middleware
//     signature. An unrelated service returning a public 200 (or anything
//     else) never sees the token. A healthz-style liveness 200 is
//     deliberately NOT used: it proves liveness, not identity.
//
// A same-user process could read ~/.kimi-code/server.token directly (it is
// the user's own 0600 file), so protocol mimicry by the same user grants no
// new privilege; the binding above exists to stop delivery to unrelated or
// foreign-owned services. The ownership proof is bound to the actual
// connection: the dialer re-proves the listener on every new connection,
// reconnection and transport-level retry, immediately before anything is
// written to it — a port that changed hands between the probe and the
// credential-carrying request fails closed. The client additionally refuses
// redirects and dials IPv4 loopback only, so the token cannot be bounced
// off-box.
//
// The API is marked experimental, so every step is fail-soft: a missing
// token file, a dead local server, or a drifted response shape ends the
// round with an error for the loop to log — never a panic, never a blocked
// daemon.

const (
	kimiServerDefaultPort = 58627
	kimiServerMaxPorts    = 100 // docs: a busy port is retried +1 up to 100 times
	kimiServerHomeDir     = ".kimi-code"
	kimiServerTokenFile   = "server.token"
	kimiServerInstances   = "server/instances"
	// kimiAuthRequiredCode is the envelope code Kimi's auth middleware returns
	// with HTTP 401 when the bearer is missing or invalid.
	kimiAuthRequiredCode = 40101
)

// errKimiIdentityUnsupportedForCollection fails a collect round on platforms
// where local server ownership cannot be proven (the loop normally gates on
// this at startup; collect double-checks so no path can bypass it).
var errKimiIdentityUnsupportedForCollection = errors.New("kimi plan quota: platform cannot verify local server identity")

// kimiPlanQuotaCollector holds the loop-round state: an HTTP client, the
// kimi home directory, and the last port that answered (re-tried first next
// round so the common case is a single probe). The identity probes are
// fields so tests can simulate foreign-owned sockets/processes and
// unsupported platforms; production wires them to the per-platform
// implementations in planquota_kimi_proc_*.go.
type kimiPlanQuotaCollector struct {
	client  *http.Client
	homeDir string
	port    int
	// scanBase/scanCount bound the port-scan fallback (default 58627 +0..99);
	// fields so tests can point the scan at an httptest port.
	scanBase  int
	scanCount int
	// identitySupported reports whether this platform can prove local server
	// ownership at all. When false the collector fails closed.
	identitySupported func() bool
	// socketOwnedByUser binds a scanned port's LISTEN socket to this user.
	socketOwnedByUser func(port int) bool
	// verifyProcess binds a registry-claimed pid to a live same-user
	// kimi-image process.
	verifyProcess func(pid int) error
	// verifyConnPeer proves the accepting process of an established
	// connection belongs to this user (per-connection proof; see
	// loopbackOwnedDialContext).
	verifyConnPeer func(conn net.Conn) bool
}

func newKimiPlanQuotaCollector(homeDir string) *kimiPlanQuotaCollector {
	c := &kimiPlanQuotaCollector{
		homeDir:           homeDir,
		scanBase:          kimiServerDefaultPort,
		scanCount:         kimiServerMaxPorts,
		identitySupported: kimiIdentitySupported,
		socketOwnedByUser: kimiSocketOwnedByUser,
		verifyProcess:     kimiVerifyInstanceProcess,
		verifyConnPeer:    kimiEstablishedPeerOwnedByUser,
	}
	// The indirection matters: tests swap the probe fields after
	// construction, and the dialer must consult the current values.
	c.client = newKimiHTTPClient(
		func(port int) bool { return c.socketOwnedByUser(port) },
		func(conn net.Conn) bool { return c.verifyConnPeer(conn) },
	)
	return c
}

// newKimiHTTPClient builds the credential-carrying client: no redirects (a
// 30x would otherwise bounce the bearer to an arbitrary target) and a dialer
// that proves the connection's peer on every connection (see
// loopbackOwnedDialContext).
func newKimiHTTPClient(socketOwnedByUser func(port int) bool, verifyConnPeer func(conn net.Conn) bool) *http.Client {
	return &http.Client{
		Timeout: 5 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return loopbackOwnedDialContext(ctx, network, addr, socketOwnedByUser, verifyConnPeer)
			},
			ResponseHeaderTimeout: 4 * time.Second,
		},
	}
}

// loopbackOwnedDialContext dials IPv4 loopback only, and — this is the OL-5
// R1 fix — binds the ownership proof to the ACTUAL connection, not to the
// port: after the connection is established it locates the server side of
// this exact 4-tuple (an ESTABLISHED record, which names the accepting
// process's uid) and requires it to belong to this user. A listener that
// released the port after accepting our connection — while another same-user
// listener re-bound it — is invisible to LISTEN checks but not to this one.
// Go's transport opens a new connection for every reconnect and every
// automatic retry of an idempotent request, so each of those re-proves here.
// A connection that cannot be proven is closed before a single byte —
// credential or otherwise — is written to it.
func loopbackOwnedDialContext(ctx context.Context, network, addr string, socketOwnedByUser func(port int) bool, verifyConnPeer func(conn net.Conn) bool) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if host != "127.0.0.1" {
		// IPv4 loopback only: the collector constructs 127.0.0.1 URLs itself,
		// and the ownership proof is evaluated for exactly the dialed family —
		// an ::1 socket cannot serve this dial.
		return nil, fmt.Errorf("plan quota: refusing to dial non-IPv4-loopback target %q", host)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return nil, fmt.Errorf("plan quota: bad port in %q: %w", addr, err)
	}
	if socketOwnedByUser != nil && !socketOwnedByUser(port) {
		return nil, fmt.Errorf("plan quota: no listener owned by this user on port %d", port)
	}
	conn, err := (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	if verifyConnPeer != nil && !verifyConnPeer(conn) {
		_ = conn.Close()
		return nil, fmt.Errorf("plan quota: cannot prove the peer of the connection to %s belongs to this user", addr)
	}
	return conn, nil
}

// collect runs one observation round: read the local token, find the live
// server port, fetch usage, normalize. Any failure abandons the round.
func (c *kimiPlanQuotaCollector) collect(ctx context.Context) (*protocol.RuntimePlanQuota, error) {
	if !c.identitySupported() {
		return nil, errKimiIdentityUnsupportedForCollection
	}
	token, err := c.readToken()
	if err != nil {
		return nil, err
	}
	data, err := c.fetchUsage(ctx, token)
	if err != nil {
		return nil, err
	}
	return kimiUsageToPlanQuota(data, time.Now()), nil
}

// readToken loads the bearer token from <home>/server.token. A missing or
// empty file means the local server was never started here — the caller
// degrades to "not reported".
func (c *kimiPlanQuotaCollector) readToken() (string, error) {
	raw, err := os.ReadFile(filepath.Join(c.homeDir, kimiServerTokenFile))
	if err != nil {
		return "", fmt.Errorf("kimi server token: %w", err)
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return "", errors.New("kimi server token: empty file")
	}
	return token, nil
}

// candidatePorts is the scan fallback used when the instance registry has no
// usable entries (e.g. a server too old to register): the last good port,
// then the documented 58627..+100 range. Scanned ports carry no pid, so they
// are bound via socket ownership instead.
func (c *kimiPlanQuotaCollector) candidatePorts() []int {
	seen := make(map[int]struct{})
	var ports []int
	add := func(p int) {
		if p <= 0 || p > 65535 {
			return
		}
		if _, dup := seen[p]; dup {
			return
		}
		seen[p] = struct{}{}
		ports = append(ports, p)
	}
	add(c.port)
	base, count := c.scanBase, c.scanCount
	if base <= 0 {
		base = kimiServerDefaultPort
	}
	if count <= 0 {
		count = kimiServerMaxPorts
	}
	for i := 0; i < count; i++ {
		add(base + i)
	}
	return ports
}

// kimiProcessTokensMatch reports whether any token looks like the Kimi CLI:
// its basename (lowercased) is kimi / kimi-code / kimi.exe, or the token is
// a path inside a kimi-code installation. Basename-prefix matching keeps
// unrelated processes that merely mention kimi in a flag from passing.
func kimiProcessTokensMatch(tokens []string) bool {
	for _, tok := range tokens {
		base := strings.ToLower(filepath.Base(strings.TrimSpace(tok)))
		if base == "kimi" || base == "kimi.exe" || strings.HasPrefix(base, "kimi-code") {
			return true
		}
		if strings.Contains(strings.ToLower(tok), "kimi-code") {
			return true
		}
	}
	return false
}

// loopbackListenOwnedByUID scans kernel TCP tables (Linux /proc/net/tcp{,6},
// or fixtures) for LISTEN sockets that can actually serve a 127.0.0.1:<port>
// dial: v4 loopback or wildcard, and dual-stack v6 wildcard / v4-mapped
// loopback. An ::1-only or LAN-bound socket can never serve that dial and is
// ignored. The check passes only when at least one such socket exists AND
// every socket that could serve the dial belongs to uid — a foreign listener
// on the same port (any family) fails closed.
func loopbackListenOwnedByUID(port, uid int, tables [][]byte) bool {
	found := false
	for _, table := range tables {
		for i, line := range strings.Split(string(table), "\n") {
			if i == 0 { // header row
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 8 {
				continue
			}
			// local_address is hex ip:hex port; st 0A is LISTEN; uid is field 7.
			hexAddr, hexPort, ok := strings.Cut(fields[1], ":")
			if !ok {
				continue
			}
			p, err := strconv.ParseUint(hexPort, 16, 32)
			if err != nil || int(p) != port {
				continue
			}
			if fields[3] != "0A" || !addrServesLoopbackV4Dial(hexAddr) {
				continue
			}
			found = true
			socketUID, err := strconv.Atoi(fields[7])
			if err != nil || socketUID != uid {
				return false
			}
		}
	}
	return found
}

// establishedPeerOwnedByUID locates the SERVER side of one exact loopback
// connection in kernel TCP tables: st 01 (ESTABLISHED), local
// 127.0.0.1:<serverPort> (or v4-mapped), remote 127.0.0.1:<ephemeralPort>.
// That row's uid is the process that ACCEPTED the connection — the actual
// peer — and it must equal uid. A row owned by another uid fails; no row at
// all means the peer cannot be proven (fail closed). LISTEN rows are
// deliberately ignored: they say nothing about who accepted THIS connection.
func establishedPeerOwnedByUID(serverPort, ephemeralPort, uid int, tables [][]byte) bool {
	for _, table := range tables {
		for i, line := range strings.Split(string(table), "\n") {
			if i == 0 { // header row
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 8 || fields[3] != "01" { // 01 = ESTABLISHED
				continue
			}
			localAddr, localPort, ok := strings.Cut(fields[1], ":")
			if !ok {
				continue
			}
			remAddr, remPort, ok := strings.Cut(fields[2], ":")
			if !ok {
				continue
			}
			lp, err := strconv.ParseUint(localPort, 16, 32)
			if err != nil || int(lp) != serverPort {
				continue
			}
			rp, err := strconv.ParseUint(remPort, 16, 32)
			if err != nil || int(rp) != ephemeralPort {
				continue
			}
			if !addrIsLoopbackV4OrMapped(localAddr) || !addrIsLoopbackV4OrMapped(remAddr) {
				continue
			}
			peerUID, err := strconv.Atoi(fields[7])
			if err != nil {
				return false
			}
			return peerUID == uid
		}
	}
	return false
}

// addrIsLoopbackV4OrMapped reports whether a hex table address is exactly
// 127.0.0.1 (v4 or v4-mapped-in-v6) — no wildcards: an ESTABLISHED row
// always has concrete addresses. The v6 table prints each 32-bit word in
// host byte order, so ::ffff:127.0.0.1 shows as ...FFFF0000 0100007F
// (verified against a live dual-stack listener; /proc/net/tcp6 is not
// plain network byte order).
func addrIsLoopbackV4OrMapped(hexAddr string) bool {
	switch strings.ToUpper(hexAddr) {
	case "0100007F", "0000000000000000FFFF00000100007F":
		return true
	}
	return false
}

// lsofEstablishedPeerOwnedBy parses `lsof -F pun` output (macOS): process
// blocks carry p<pid> and u<uid>; file lines carry n<name>. The proof finds
// the server-direction tuple `127.0.0.1:<serverPort>->127.0.0.1:<eph>` and
// requires the owning process block's uid to match. Endpoints are compared
// EXACTLY (parsed addr + port), never by prefix — "5000" must not match
// "50001". Client-direction rows are our own and ignored.
func lsofEstablishedPeerOwnedBy(out string, serverPort, ephemeralPort, uid int) bool {
	blockUID := -1
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			blockUID = -1
		case 'u':
			if u, err := strconv.Atoi(line[1:]); err == nil {
				blockUID = u
			}
		case 'n':
			if lsofNameMatchesEstablishedPeer(line[1:], serverPort, ephemeralPort) {
				return blockUID >= 0 && blockUID == uid
			}
		}
	}
	return false
}

// lsofNameMatchesEstablishedPeer reports whether an lsof socket name like
// "127.0.0.1:58627->127.0.0.1:40000 (ESTABLISHED)" is exactly the
// server-direction tuple of this connection.
func lsofNameMatchesEstablishedPeer(name string, serverPort, ephemeralPort int) bool {
	fields := strings.Fields(name)
	if len(fields) == 0 {
		return false
	}
	tuple := fields[0]
	local, remote, ok := strings.Cut(tuple, "->")
	if !ok {
		return false
	}
	laddr, lport, lok := splitAddrPort(local)
	raddr, rport, rok := splitAddrPort(remote)
	if !lok || !rok {
		return false
	}
	return laddr == "127.0.0.1" && lport == serverPort &&
		raddr == "127.0.0.1" && rport == ephemeralPort
}

func splitAddrPort(s string) (string, int, bool) {
	i := strings.LastIndex(s, ":")
	if i < 0 {
		return "", 0, false
	}
	port, err := strconv.Atoi(s[i+1:])
	if err != nil {
		return "", 0, false
	}
	return s[:i], port, true
}

// addrServesLoopbackV4Dial reports whether a hex-encoded listener address
// from the kernel TCP table can serve a dial to 127.0.0.1.
func addrServesLoopbackV4Dial(hexAddr string) bool {
	switch strings.ToUpper(hexAddr) {
	case "0100007F", // 127.0.0.1
		"00000000",                         // 0.0.0.0 (v4 wildcard)
		"00000000000000000000000000000000", // :: (dual-stack wildcard)
		"0000000000000000FFFF00000100007F", // ::ffff:127.0.0.1 (host-order words)
		"0000000000000000FFFF000000000000": // ::ffff:0.0.0.0
		return true
	}
	return false
}

// kimiInstance is one entry of the Kimi local server's instance registry
// (~/.kimi-code/server/instances/<server-id>.json). The registry lives under
// the user's private home, so only this user's processes can plant entries —
// that is what makes the pid/port pair a trustworthy starting point.
type kimiInstance struct {
	ServerID string `json:"server_id"`
	PID      int    `json:"pid"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
}

// instances reads the instance registry, keeping only well-formed loopback
// entries (pid > 0, valid port). Files that fail to parse are skipped — a
// corrupt entry must not take the collector down with it.
func (c *kimiPlanQuotaCollector) instances() []kimiInstance {
	dir := filepath.Join(c.homeDir, kimiServerInstances)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []kimiInstance
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var inst kimiInstance
		if err := json.Unmarshal(raw, &inst); err != nil {
			continue
		}
		if inst.PID <= 0 || inst.Port <= 0 || inst.Port > 65535 {
			continue
		}
		// Only IPv4-loopback binds are usable: the collector dials 127.0.0.1
		// and the socket-ownership proof is evaluated for exactly that target,
		// so an entry claiming any other host (including ::1) is refused
		// rather than silently dialed at a different address than proven.
		if inst.Host != "" && inst.Host != "127.0.0.1" {
			continue
		}
		out = append(out, inst)
	}
	return out
}

// fetchUsage returns the first usable usage payload. Registry instances are
// tried first: their pid must verify as a live same-user kimi process before
// any request is made. When the registry has no usable entries, the scan
// fallback binds each candidate port via socket ownership. Both paths then
// run the unauthenticated 40101 handshake; only a peer passing every gate
// receives the bearer. A port that answers usage is remembered for the next
// round.
func (c *kimiPlanQuotaCollector) fetchUsage(ctx context.Context, token string) (*kimiUsageData, error) {
	var lastErr error
	if instances := c.instances(); len(instances) > 0 {
		for _, inst := range instances {
			if err := c.verifyProcess(inst.PID); err != nil {
				lastErr = fmt.Errorf("kimi instance %s (pid %d): %w", inst.ServerID, inst.PID, err)
				continue
			}
			// The pid proves the registry writer; the socket check proves the
			// process actually serving 127.0.0.1:<port> — the target the
			// bearer is about to be sent to — belongs to this user. Both are
			// required: neither a stale/forged registry entry nor a foreign
			// port squatter alone can pass.
			if !c.socketOwnedByUser(inst.Port) {
				lastErr = fmt.Errorf("kimi instance %s (pid %d): listener on port %d not owned by this user", inst.ServerID, inst.PID, inst.Port)
				continue
			}
			if data, err := c.tryPort(ctx, inst.Port, token); err == nil {
				return data, nil
			} else {
				lastErr = err
			}
		}
		return nil, lastErr
	}
	for _, port := range c.candidatePorts() {
		if !c.socketOwnedByUser(port) {
			// No listener, or the listener belongs to another user — never
			// dial it with credentials.
			continue
		}
		if data, err := c.tryPort(ctx, port, token); err == nil {
			return data, nil
		} else {
			lastErr = err
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, errors.New("kimi local server not reachable (kimi web not running?)")
}

// tryPort runs the identity handshake and the usage call against one port.
func (c *kimiPlanQuotaCollector) tryPort(ctx context.Context, port int, token string) (*kimiUsageData, error) {
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	if err := c.checkKimiAuthSurface(ctx, base); err != nil {
		return nil, err
	}
	data, err := c.getUsage(ctx, base, token)
	if err != nil {
		return nil, err
	}
	c.port = port
	return data, nil
}

// checkKimiAuthSurface proves the peer is Kimi Code's local server WITHOUT
// sending the token: an unauthenticated call to a protected /api/* path must
// come back as HTTP 401 with envelope code 40101. Anything else — a public
// 200, a redirect, a foreign 401 shape — is not Kimi and gets no credential.
func (c *kimiPlanQuotaCollector) checkKimiAuthSurface(ctx context.Context, base string) error {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/v1/oauth/usage", nil)
	if err != nil {
		return err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("kimi auth probe: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusUnauthorized {
		return fmt.Errorf("kimi auth probe: expected 401, got %d", resp.StatusCode)
	}
	var envelope struct {
		Code int `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&envelope); err != nil {
		return fmt.Errorf("kimi auth probe: decode: %w", err)
	}
	if envelope.Code != kimiAuthRequiredCode {
		return fmt.Errorf("kimi auth probe: expected envelope code %d, got %d", kimiAuthRequiredCode, envelope.Code)
	}
	return nil
}

// kimiUsageData is the `data` payload of GET /api/v1/oauth/usage. Only the
// fields the snapshot maps are modeled; extra_usage (the pay-as-you-go
// wallet) is deliberately never decoded — credit balances must not cross
// into the snapshot.
type kimiUsageData struct {
	Kind    string              `json:"kind"`
	Message string              `json:"message,omitempty"`
	Limits  []kimiUsageLimitRow `json:"limits,omitempty"`
}

type kimiUsageLimitRow struct {
	Name    string           `json:"name,omitempty"`
	Window  *kimiUsageWindow `json:"window,omitempty"`
	Used    *float64         `json:"used,omitempty"`
	Limit   *float64         `json:"limit,omitempty"`
	ResetAt any              `json:"reset_at,omitempty"`
}

type kimiUsageWindow struct {
	Duration float64 `json:"duration"`
	Unit     string  `json:"unit"`
}

func (c *kimiPlanQuotaCollector) getUsage(ctx context.Context, base, token string) (*kimiUsageData, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/v1/oauth/usage", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("kimi usage request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusTooManyRequests {
		return nil, fmt.Errorf("kimi usage: http %d", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("kimi usage: unexpected http %d", resp.StatusCode)
	}
	var envelope struct {
		Code int            `json:"code"`
		Msg  string         `json:"msg,omitempty"`
		Data *kimiUsageData `json:"data,omitempty"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("kimi usage: decode envelope: %w", err)
	}
	if envelope.Code != 0 {
		return nil, fmt.Errorf("kimi usage: envelope code %d (%s)", envelope.Code, envelope.Msg)
	}
	if envelope.Data == nil {
		return nil, errors.New("kimi usage: empty data")
	}
	if envelope.Data.Kind != "ok" {
		// In-band upstream failure (the account service is down, the login
		// expired, ...): a collection failure, not a malformed response.
		msg := envelope.Data.Message
		if msg == "" {
			msg = "kind=" + envelope.Data.Kind
		}
		return nil, fmt.Errorf("kimi usage: %s", msg)
	}
	return envelope.Data, nil
}

// kimiUsageToPlanQuota normalizes the usage rows. Windows are sorted by
// duration ascending and the two canonical ones renamed to the cross-provider
// window ids ("primary" = shortest, "secondary" = next), matching the codex
// collector; any additional rows keep their provider name. Rows whose limit
// is missing or non-positive carry no percentage (never a fabricated 0);
// rows with no usable fields at all are dropped. Nil when nothing reportable
// remains. extra_usage is never part of the input — no credits in, none out.
func kimiUsageToPlanQuota(data *kimiUsageData, observedAt time.Time) *protocol.RuntimePlanQuota {
	if data == nil || len(data.Limits) == 0 {
		return nil
	}
	rows := append([]kimiUsageLimitRow(nil), data.Limits...)
	minutesOrMax := func(w *kimiUsageWindow) int64 {
		if m := kimiWindowMinutes(w); m != nil {
			return *m
		}
		return 1<<63 - 1 // unknown durations sort after known ones
	}
	sort.SliceStable(rows, func(i, j int) bool {
		return minutesOrMax(rows[i].Window) < minutesOrMax(rows[j].Window)
	})
	quota := &protocol.RuntimePlanQuota{
		Provider:   "kimi",
		Status:     protocol.PlanQuotaStatusOK,
		ObservedAt: observedAt.Unix(),
		Source:     protocol.PlanQuotaSourceDaemon,
	}
	canonical := []string{"primary", "secondary"}
	limited := false
	for i, row := range rows {
		window := protocol.RuntimePlanQuotaWindow{
			Name:          planQuotaWindowName(row.Name, canonical, i),
			WindowMinutes: kimiWindowMinutes(row.Window),
			ResetsAt:      unixSecondsPtr(row.ResetAt),
		}
		if row.Used != nil && row.Limit != nil && *row.Limit > 0 {
			used := *row.Used / *row.Limit * 100
			window.UsedPercent = &used
			if used >= 100 {
				limited = true
			}
		}
		if window.UsedPercent == nil && window.WindowMinutes == nil && window.ResetsAt == nil {
			continue
		}
		quota.Windows = append(quota.Windows, window)
	}
	if len(quota.Windows) == 0 {
		return nil
	}
	if limited {
		quota.Status = protocol.PlanQuotaStatusLimited
	}
	return quota
}

// planQuotaWindowName picks the window id: the canonical slot name for the
// two shortest windows, otherwise the provider's own name (bounded to the
// wire limit), otherwise a positional fallback so validation never rejects.
func planQuotaWindowName(providerName string, canonical []string, index int) string {
	if index < len(canonical) {
		return canonical[index]
	}
	name := strings.TrimSpace(providerName)
	if name == "" {
		return fmt.Sprintf("window_%d", index+1)
	}
	if len(name) > protocol.PlanQuotaMaxWindowName {
		name = name[:protocol.PlanQuotaMaxWindowName]
	}
	return name
}

// kimiWindowMinutes converts {duration, unit} to whole minutes; unknown or
// non-positive input yields nil (the window carries no duration).
func kimiWindowMinutes(window *kimiUsageWindow) *int64 {
	if window == nil || window.Duration <= 0 {
		return nil
	}
	var factor float64
	switch strings.ToLower(window.Unit) {
	case "minute", "minutes":
		factor = 1
	case "hour", "hours":
		factor = 60
	case "day", "days":
		factor = 1440
	case "week", "weeks":
		factor = 10080
	default:
		return nil
	}
	minutes := int64(window.Duration * factor)
	if minutes <= 0 {
		return nil
	}
	return &minutes
}

// unixSecondsPtr coerces a provider timestamp — unix seconds as a JSON
// number or numeric string, or an RFC3339 string — into *int64. Anything
// else yields nil: a reset time we cannot read is "not disclosed", never a
// made-up one.
func unixSecondsPtr(v any) *int64 {
	switch t := v.(type) {
	case nil:
		return nil
	case float64:
		if t <= 0 {
			return nil
		}
		sec := int64(t)
		return &sec
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return nil
		}
		if n, err := strconv.ParseInt(s, 10, 64); err == nil && n > 0 {
			return &n
		}
		if ts, err := time.Parse(time.RFC3339, s); err == nil {
			sec := ts.Unix()
			return &sec
		}
		return nil
	default:
		return nil
	}
}

// kimiPlanQuotaLoop is the daemon-loop entry point for the Kimi collector.
// Platforms that cannot prove local server ownership run no loop at all —
// fail closed, with one startup log.
func (d *Daemon) kimiPlanQuotaLoop(ctx context.Context) {
	if !kimiIdentitySupported() {
		d.logger.Warn("kimi plan quota collector disabled: this platform cannot verify local server ownership; runtimes stay not reported")
		return
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		d.logger.Debug("kimi plan quota collector disabled: no home directory", "error", err)
		return
	}
	collector := newKimiPlanQuotaCollector(filepath.Join(homeDir, kimiServerHomeDir))
	d.runPlanQuotaCollector(ctx, "kimi", d.cfg.PlanQuotaKimiInterval,
		func() []string { return d.runtimeIDsForProvider("kimi") }, collector.collect)
}
