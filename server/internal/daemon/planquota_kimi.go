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
// foreign-owned services. The HTTP client additionally refuses redirects and
// dials loopback literals only, so the token cannot be bounced off-box.
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
}

func newKimiPlanQuotaCollector(homeDir string) *kimiPlanQuotaCollector {
	return &kimiPlanQuotaCollector{
		client:            newKimiHTTPClient(),
		homeDir:           homeDir,
		scanBase:          kimiServerDefaultPort,
		scanCount:         kimiServerMaxPorts,
		identitySupported: kimiIdentitySupported,
		socketOwnedByUser: kimiSocketOwnedByUser,
		verifyProcess:     kimiVerifyInstanceProcess,
	}
}

// newKimiHTTPClient builds the credential-carrying client: no redirects (a
// 30x would otherwise bounce the bearer to an arbitrary target) and a dialer
// that accepts loopback literals only.
func newKimiHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 5 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Transport: &http.Transport{
			DialContext:           loopbackOnlyDialContext,
			ResponseHeaderTimeout: 4 * time.Second,
		},
	}
}

// loopbackOnlyDialContext refuses to dial anything but a loopback literal.
// The collector constructs URLs as http://127.0.0.1:<port> itself; this is
// the belt-and-braces guarantee at the actual connection point.
func loopbackOnlyDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if host != "127.0.0.1" && host != "::1" {
		return nil, fmt.Errorf("plan quota: refusing to dial non-loopback target %q", host)
	}
	return (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, network, addr)
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
		if inst.Host != "127.0.0.1" && inst.Host != "::1" && inst.Host != "" {
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
