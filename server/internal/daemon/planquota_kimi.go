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
//   - GET /api/v1/oauth/usage answers the envelope
//     {code, msg, data:{kind:"ok", summary, limits:[...]}} and reports upstream
//     failures in-band as data.kind:"error". The live server (verified
//     2026-09-11) puts the weekly window only in data.summary while
//     data.limits carries the 5-hour row; the published docs put both rows
//     in data.limits with summary duplicating one of them. The snapshot
//     unions the two fields so either shape reports every window the plan
//     actually has — a shape drift must never silently hide a window again
//     (the OL-45 incident: weekly exhausted while the page showed a healthy
//     5-hour window).
//
// Credential safety (OL-5 R1, converged design): there is exactly ONE
// credential gate, and it is bound to the actual connection. Immediately
// after each connection is established — new dial, reconnect, or
// transport-level retry — the dialer locates the server side of the
// connection's exact 4-tuple in the kernel TCP tables (an ESTABLISHED row,
// which carries the ACCEPTING process's uid) and requires it to belong to
// this user. LISTEN checks cannot answer "who accepted this connection" (a
// process can accept, release the port, and keep the connection while our
// user re-binds the listener); the established-tuple proof can. Anything
// unprovable is closed before a single byte — credential or otherwise — is
// written. The client also refuses redirects and dials the IPv4 loopback
// literal only.
//
// The trust boundary is the local user account: the token file is 0600
// same-user, so a same-user process gains nothing by intercepting it — the
// gate exists to stop delivery to OTHER users' processes. Earlier layers
// (pid/image heuristics, a 401 handshake as identity) were removed: they
// either proved something else or were reproducible by any local process,
// and this gate subsumes them.
//
// Cost discipline: each round enumerates this user's loopback LISTEN ports
// ONCE (one /proc read pair on Linux, one lsof run on macOS) and filters
// candidates in memory; the per-connection proof is one table lookup.
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
)

// errKimiIdentityUnsupportedForCollection fails a collect round on platforms
// where the connection peer cannot be proven (the loop normally gates on
// this at startup; collect double-checks so no path can bypass it).
var errKimiIdentityUnsupportedForCollection = errors.New("kimi plan quota: platform cannot prove connection peer ownership")

// kimiPlanQuotaCollector holds the loop-round state: an HTTP client, the
// kimi home directory, the last port that answered, and the current round's
// owned-listen set. The probe functions are fields so tests can simulate
// foreign peers and unsupported platforms; production wires them to the
// per-platform implementations in planquota_kimi_proc_*.go.
type kimiPlanQuotaCollector struct {
	client  *http.Client
	homeDir string
	port    int
	// scanBase/scanCount bound the port-scan fallback (default 58627 +0..99);
	// fields so tests can point the scan at an httptest port.
	scanBase  int
	scanCount int
	// identitySupported reports whether this platform can prove the
	// connection peer at all. When false the collector fails closed.
	identitySupported func() bool
	// enumerateOwnedListenPorts returns, in one enumeration per round, the
	// loopback-serving LISTEN ports owned by this user.
	enumerateOwnedListenPorts func() map[int]struct{}
	// verifyConnPeer proves the accepting process of an established
	// connection belongs to this user — the credential gate.
	verifyConnPeer func(conn net.Conn) bool
	// roundOwned is the current round's owned-listen set, used by the dialer
	// as an in-memory fast-fail before dialing. Nil means no fast-fail (the
	// established-tuple proof still applies).
	roundOwned map[int]struct{}
}

func newKimiPlanQuotaCollector(homeDir string) *kimiPlanQuotaCollector {
	c := &kimiPlanQuotaCollector{
		homeDir:           homeDir,
		scanBase:          kimiServerDefaultPort,
		scanCount:         kimiServerMaxPorts,
		identitySupported: kimiIdentitySupported,
	}
	c.enumerateOwnedListenPorts = kimiEnumerateOwnedListenPorts
	c.verifyConnPeer = kimiEstablishedPeerOwnedByUser
	c.client = newKimiHTTPClient(c.dial)
	return c
}

// newKimiHTTPClient builds the credential-carrying client: no redirects (a
// 30x would otherwise bounce the bearer to an arbitrary target) and the
// given dialer (the collector's, which carries the ownership proofs).
func newKimiHTTPClient(dial func(ctx context.Context, network, addr string) (net.Conn, error)) *http.Client {
	return &http.Client{
		Timeout: 5 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			DialContext:           dial,
			ResponseHeaderTimeout: 4 * time.Second,
		},
	}
}

// dial connects to IPv4 loopback only and binds the ownership proof to the
// ACTUAL connection: after the connection is established it locates the
// server side of this exact 4-tuple (an ESTABLISHED row, which names the
// accepting process's uid) and requires it to belong to this user. Go's
// transport opens a new connection for every reconnect and every automatic
// retry of an idempotent request, so each of those re-proves here. A
// connection that cannot be proven is closed before a single byte is
// written. The round's owned-listen set provides an in-memory fast-fail;
// the established-tuple proof is the authority.
func (c *kimiPlanQuotaCollector) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if host != "127.0.0.1" {
		return nil, fmt.Errorf("plan quota: refusing to dial non-IPv4-loopback target %q", host)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return nil, fmt.Errorf("plan quota: bad port in %q: %w", addr, err)
	}
	if c.roundOwned != nil {
		if _, ok := c.roundOwned[port]; !ok {
			return nil, fmt.Errorf("plan quota: no listener owned by this user on port %d", port)
		}
	}
	conn, err := (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	if c.verifyConnPeer != nil && !c.verifyConnPeer(conn) {
		_ = conn.Close()
		return nil, fmt.Errorf("plan quota: cannot prove the peer of the connection to %s belongs to this user", addr)
	}
	return conn, nil
}

// collect runs one observation round: read the local token, enumerate this
// user's listeners once, find the live server port, fetch usage, normalize.
// Any failure abandons the round.
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

// candidatePorts orders the probe list: the last good port, then ports from
// the instance registry, then the documented 58627..+100 scan range.
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
	for _, p := range c.registryPorts() {
		add(p)
	}
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

// registryPorts reads the instance registry for port discovery only. The
// registry lives under the user's private home and tells us where instances
// claim to listen; identity is NOT established here — the per-connection
// proof in the dialer owns that. Only IPv4-loopback entries are usable.
func (c *kimiPlanQuotaCollector) registryPorts() []int {
	dir := filepath.Join(c.homeDir, kimiServerInstances)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var ports []int
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var inst struct {
			Host string `json:"host"`
			Port int    `json:"port"`
		}
		if err := json.Unmarshal(raw, &inst); err != nil {
			continue
		}
		if inst.Port <= 0 || inst.Port > 65535 {
			continue
		}
		if inst.Host != "" && inst.Host != "127.0.0.1" {
			continue
		}
		ports = append(ports, inst.Port)
	}
	return ports
}

// fetchUsage walks the candidate ports that survived the round's owned-set
// filter and returns the first usable usage payload. A port that answers
// usage is remembered for the next round.
func (c *kimiPlanQuotaCollector) fetchUsage(ctx context.Context, token string) (*kimiUsageData, error) {
	c.roundOwned = c.enumerateOwnedListenPorts()
	defer func() { c.roundOwned = nil }()
	var lastErr error
	for _, port := range c.candidatePorts() {
		if _, ok := c.roundOwned[port]; !ok {
			continue // no listener of ours on this port: skip without dialing
		}
		data, err := c.getUsage(ctx, fmt.Sprintf("http://127.0.0.1:%d", port), token)
		if err != nil {
			lastErr = err
			continue
		}
		c.port = port
		return data, nil
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, errors.New("kimi local server not reachable (kimi web not running?)")
}

// kimiUsageData is the `data` payload of GET /api/v1/oauth/usage. Only the
// fields the snapshot maps are modeled; extra_usage (the pay-as-you-go
// wallet) is deliberately never decoded — credit balances must not cross
// into the snapshot. Summary is merged into the window set (see
// mergeKimiUsageRows): the live server reports the weekly window only here.
type kimiUsageData struct {
	Kind    string              `json:"kind"`
	Message string              `json:"message,omitempty"`
	Summary *kimiUsageLimitRow  `json:"summary,omitempty"`
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
	if resp.StatusCode == http.StatusTooManyRequests {
		// Rate-limited (e.g. the auth-failure ban on non-loopback binds):
		// back off like any other rate-limited source.
		return nil, &rateLimitError{err: errors.New("kimi usage: http 429")}
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

// --- Kernel table / lsof parsers (shared, fixture-tested) ---

// ownedLoopbackListenPorts scans kernel TCP tables (Linux /proc/net/tcp{,6},
// or fixtures) ONCE and returns the set of ports whose LISTEN sockets can
// serve a 127.0.0.1 dial (v4 loopback/wildcard, dual-stack v6 wildcard or
// v4-mapped loopback) and belong to uid. An ::1-only or LAN-bound socket can
// never serve that dial and is excluded.
func ownedLoopbackListenPorts(uid int, tables [][]byte) map[int]struct{} {
	ports := make(map[int]struct{})
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
			if err != nil {
				continue
			}
			if fields[3] != "0A" || !addrServesLoopbackV4Dial(hexAddr) {
				continue
			}
			socketUID, err := strconv.Atoi(fields[7])
			if err != nil || socketUID != uid {
				continue
			}
			ports[int(p)] = struct{}{}
		}
	}
	return ports
}

// addrServesLoopbackV4Dial reports whether a hex-encoded listener address
// from the kernel TCP table can serve a dial to 127.0.0.1. The v6 table
// prints each 32-bit word in host byte order, so ::ffff:127.0.0.1 shows as
// ...FFFF0000 0100007F (verified against a live dual-stack listener;
// /proc/net/tcp6 is not plain network byte order).
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
// always has concrete addresses.
func addrIsLoopbackV4OrMapped(hexAddr string) bool {
	switch strings.ToUpper(hexAddr) {
	case "0100007F", "0000000000000000FFFF00000100007F":
		return true
	}
	return false
}

// lsofOwnedListenPorts parses one `lsof -nP -sTCP:LISTEN -F pun` run (macOS):
// process blocks carry p<pid> and u<uid>; file lines carry n<name>. The set
// contains the ports of this user's listeners whose address can serve a
// 127.0.0.1 dial (127.0.0.1, wildcard, dual-stack [::]); [::1]-only
// listeners cannot and are excluded.
func lsofOwnedListenPorts(out string, uid int) map[int]struct{} {
	ports := make(map[int]struct{})
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
			if blockUID < 0 || blockUID != uid {
				continue
			}
			addr, port, ok := splitAddrPort(lsofListenerName(line[1:]))
			if !ok {
				continue
			}
			switch addr {
			case "127.0.0.1", "0.0.0.0", "*", "::", "[::]":
				ports[port] = struct{}{}
			}
		}
	}
	return ports
}

// lsofListenerName extracts the addr:port from an lsof socket name like
// "127.0.0.1:58627 (LISTEN)" or "*:58627 (LISTEN)".
func lsofListenerName(name string) string {
	if fields := strings.Fields(name); len(fields) > 0 {
		return fields[0]
	}
	return ""
}

// lsofEstablishedPeerOwnedBy parses `lsof -F pun` output (macOS) for the
// server-direction tuple `127.0.0.1:<serverPort>->127.0.0.1:<eph>` and
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
	tuple := lsofListenerName(name)
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

// kimiUsageToPlanQuota normalizes the usage rows. Windows are sorted by
// duration ascending and the two canonical ones renamed to the cross-provider
// window ids ("primary" = shortest, "secondary" = next), matching the codex
// collector; any additional rows keep their provider name. Only known
// durations take a canonical slot — an unknown-duration row (the docs allow
// a row to omit window) is not one of the two canonical windows and keeps
// the provider's own name. Rows whose limit
// is missing or non-positive carry no percentage (never a fabricated 0);
// rows with no usable fields at all are dropped. Nil when nothing reportable
// remains. extra_usage is never part of the input — no credits in, none out.
func kimiUsageToPlanQuota(data *kimiUsageData, observedAt time.Time) *protocol.RuntimePlanQuota {
	if data == nil {
		return nil
	}
	rows := mergeKimiUsageRows(data)
	if len(rows) == 0 {
		return nil
	}
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
	knownSeen := 0
	for i, row := range rows {
		minutes := kimiWindowMinutes(row.Window)
		// Canonical slots are earned by known durations only; an
		// unknown-duration row keeps the provider name (trim, cap and the
		// empty-name fallback in planQuotaWindowName still apply).
		canonicalFor := canonical
		if minutes == nil || knownSeen >= len(canonical) {
			canonicalFor = nil
		} else {
			knownSeen++
		}
		window := protocol.RuntimePlanQuotaWindow{
			Name:          planQuotaWindowName(row.Name, canonicalFor, i),
			WindowMinutes: minutes,
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

// mergeKimiUsageRows unions the summary row into the limits rows. The live
// local server (verified 2026-09-11) reports the weekly window only in
// summary while limits carries the 5-hour row; the published docs show both
// rows in limits with summary duplicating one of them. The union covers
// either shape: a summary whose window duration already exists in limits is
// dropped (limits is the authoritative window list — it is never replaced
// or dropped, only added to), and a summary with an unknown duration cannot
// collide, so it is kept under its provider name.
func mergeKimiUsageRows(data *kimiUsageData) []kimiUsageLimitRow {
	rows := append([]kimiUsageLimitRow(nil), data.Limits...)
	if s := data.Summary; s != nil {
		if m := kimiWindowMinutes(s.Window); m == nil || !kimiRowsHaveWindowMinutes(rows, *m) {
			rows = append(rows, *s)
		}
	}
	return rows
}

func kimiRowsHaveWindowMinutes(rows []kimiUsageLimitRow, minutes int64) bool {
	for i := range rows {
		if m := kimiWindowMinutes(rows[i].Window); m != nil && *m == minutes {
			return true
		}
	}
	return false
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
// Platforms that cannot prove the connection peer run no loop at all —
// fail closed, with one startup log.
func (d *Daemon) kimiPlanQuotaLoop(ctx context.Context) {
	if !kimiIdentitySupported() {
		d.logger.Warn("kimi plan quota collector disabled: this platform cannot prove connection peer ownership; runtimes stay not reported")
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
