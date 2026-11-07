package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// OMP (Oh My Pi) plan-quota collector. OMP pools several vendor
// subscriptions (Kimi Code, Anthropic, Codex, Z.AI, ...) behind one local
// agent database and switches accounts automatically when one is limited.
// The collector shells out to the host's `omp usage --json --redact` — the
// redaction is done by OMP itself (masked emails/ids like "19*", "ca*9*",
// raw provider payloads stripped) so no plaintext identity can even reach
// this process, and a final "@" guard in the parser plus the protocol
// validator keep the snapshot clean by construction.
//
// Output shape (omp usage-cli.ts, verified against @oh-my-pi 17.x/18.x):
// one `report` is one ACCOUNT of one vendor (a vendor with 3 logins has 3
// reports). `accountsWithoutUsage` lists stored credentials no report was
// attributed to; `disabledCredentials` lists actionable OAuth tombstones;
// `capacity` aggregates per-vendor per-window account capacity. Since 18.13
// a report may carry `policy` with `state: eligible | inside-reserve |
// exhausted | unknown` — the account-routing view of the same limits, which
// maps onto the protocol's account statuses (inside-reserve → reserve,
// i.e. NOT usable: OMP keeps the remainder as reserve and stops routing).
// `window` is OPTIONAL on a limit (cursor omits it conditionally; kimi's
// weekly window carries resetsAt but no durationMs).
//
// Failure semantics follow the shared collector loop: fail-soft, log, keep
// the last snapshot. The subprocess gets a hard timeout and inherits the
// daemon environment — omp is often a bun-installed `#!/usr/bin/env bun`
// shim that needs PATH (and vendors need proxy vars), and quota collection
// never runs untrusted code beyond the omp binary the daemon already runs.
const (
	ompQuotaProvider = "omp"
	// ompUsageTimeout bounds the `omp usage` subprocess (it may hit every
	// vendor's usage endpoint once).
	ompUsageTimeout = 20 * time.Second
	ompUsageMaxOut  = 4 << 20 // 4 MiB: multi-vendor multi-account JSON
)

var errOmpQuotaShape = errors.New("omp quota: unusable output")

// ompPlanQuotaCollector runs `omp usage --json --redact` and normalizes the
// payload. runCommand is injectable for tests; timeout too, so the
// fail-soft timeout path is testable without real sleeps.
type ompPlanQuotaCollector struct {
	runCommand func(ctx context.Context) ([]byte, error)
}

func newOmpPlanQuotaCollector(binPath string) *ompPlanQuotaCollector {
	return &ompPlanQuotaCollector{
		runCommand: newOmpUsageRunner(binPath, ompUsageTimeout),
	}
}

// newOmpUsageRunner builds the exec runner as a separate value so tests can
// exercise the REAL exec path (a fake omp executable) with a short timeout.
func newOmpUsageRunner(binPath string, timeout time.Duration) func(ctx context.Context) ([]byte, error) {
	return func(ctx context.Context) ([]byte, error) {
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, binPath, "usage", "--json", "--redact")
		// Inherit the daemon environment: a bun-installed omp is a
		// `#!/usr/bin/env bun` shim that cannot resolve bun on an empty
		// PATH (exit 127), and vendor usage endpoints may need proxy
		// variables. Mirrors how the daemon launches omp elsewhere
		// (pkg/agent/omp_skills.go).
		cmd.Env = os.Environ()
		// A killed omp may leave children holding the stdout pipe; bound
		// how long Wait keeps draining after the kill.
		cmd.WaitDelay = 2 * time.Second
		var stdout bytes.Buffer
		cmd.Stdout = &stdout
		// stderr carries progress chatter; discard it.
		cmd.Stderr = io.Discard
		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("omp usage: %w", err)
		}
		return stdout.Bytes(), nil
	}
}

// --- omp usage --json payload (only the mapped fields) ---

type ompUsagePayload struct {
	GeneratedAt          int64                              `json:"generatedAt"`
	Reports              []ompUsageReport                   `json:"reports"`
	AccountsWithoutUsage []ompAccountIdentity               `json:"accountsWithoutUsage"`
	DisabledCredentials  []ompDisabledCredentialSummary     `json:"disabledCredentials"`
	Capacity             map[string][]ompProviderWindowStat `json:"capacity"`
}

type ompUsageReport struct {
	Provider string          `json:"provider"`
	Limits   []ompUsageLimit `json:"limits"`
	Metadata *ompReportMeta  `json:"metadata"`
	// Policy is the per-account routing view omp ≥18.13 attaches to
	// policy-configured accounts; nil on older omp or unconfigured ones.
	Policy *ompUsagePolicy `json:"policy"`
}

type ompReportMeta struct {
	Email     string `json:"email"`
	AccountID string `json:"accountId"`
}

type ompUsagePolicy struct {
	// State: eligible | inside-reserve | exhausted | unknown.
	State string `json:"state"`
}

type ompUsageLimit struct {
	ID     string          `json:"id"`
	Label  string          `json:"label"`
	Scope  ompUsageScope   `json:"scope"`
	Window *ompUsageWindow `json:"window"` // OPTIONAL
	Amount ompUsageAmount  `json:"amount"`
	Status string          `json:"status"`
}

type ompUsageScope struct {
	AccountID string `json:"accountId"`
	WindowID  string `json:"windowId"`
}

type ompUsageWindow struct {
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	DurationMs float64 `json:"durationMs"`
	// ResetsAt is epoch milliseconds.
	ResetsAt float64 `json:"resetsAt"`
}

type ompUsageAmount struct {
	UsedFraction *float64 `json:"usedFraction"`
}

type ompAccountIdentity struct {
	Provider  string `json:"provider"`
	Type      string `json:"type"`
	Email     string `json:"email"`
	AccountID string `json:"accountId"`
}

type ompDisabledCredentialSummary struct {
	Provider  string `json:"provider"`
	Type      string `json:"type"`
	Email     string `json:"email"`
	AccountID string `json:"accountId"`
	Cause     string `json:"cause"`
}

type ompProviderWindowStat struct {
	Window            string  `json:"window"`
	DurationMs        float64 `json:"durationMs"`
	Accounts          int     `json:"accounts"`
	UsedAccounts      float64 `json:"usedAccounts"`
	RemainingAccounts float64 `json:"remainingAccounts"`
}

func (c *ompPlanQuotaCollector) collect(ctx context.Context) (*protocol.RuntimePlanQuota, error) {
	out, err := c.runCommand(ctx)
	if err != nil {
		return nil, err
	}
	quota, err := ompUsageToPlanQuota(out, time.Now())
	if err != nil {
		return nil, err
	}
	if err := protocol.ValidateRuntimePlanQuota(quota, time.Now()); err != nil {
		return nil, fmt.Errorf("%w: %v", errOmpQuotaShape, err)
	}
	return quota, nil
}

// ompUsageToPlanQuota normalizes the redacted OMP payload into the pooled
// snapshot. The top-level Windows stay EMPTY for OMP: the flat list is a
// single-account shape, and a multi-account pool would either lie (one
// account's windows) or flood (12+ windows, past the 8-window cap). All
// structure lives in AccountPools. Nil return means "logged into nothing" —
// nothing to report, not an error.
func ompUsageToPlanQuota(out []byte, observedAt time.Time) (*protocol.RuntimePlanQuota, error) {
	var payload ompUsagePayload
	if len(out) > ompUsageMaxOut {
		return nil, fmt.Errorf("%w: output exceeds %d bytes", errOmpQuotaShape, ompUsageMaxOut)
	}
	if err := json.Unmarshal(out, &payload); err != nil {
		return nil, fmt.Errorf("%w: invalid json: %v", errOmpQuotaShape, err)
	}
	if len(payload.Reports) == 0 && len(payload.AccountsWithoutUsage) == 0 && len(payload.DisabledCredentials) == 0 {
		return nil, nil
	}

	// Accounts grouped by provider, first-seen order.
	pools := make(map[string]*protocol.RuntimePlanQuotaAccountPool)
	var order []string
	poolOf := func(id string) *protocol.RuntimePlanQuotaAccountPool {
		if p, ok := pools[id]; ok {
			return p
		}
		p := &protocol.RuntimePlanQuotaAccountPool{ID: id}
		pools[id] = p
		order = append(order, id)
		return p
	}

	// One report = one account.
	for i := range payload.Reports {
		report := &payload.Reports[i]
		pool := poolOf(report.Provider)
		windows, status := ompAccountWindows(report, observedAt)
		pool.Accounts = append(pool.Accounts, protocol.RuntimePlanQuotaAccount{
			Label:   ompReportLabel(report, len(pool.Accounts)),
			Status:  status,
			Windows: windows,
		})
	}
	// Stored credentials with no usage report: unknown-state accounts. A
	// fetch failure or an API-key-only vendor lands here; "unknown" is NOT
	// "unavailable", so it never flips a pool to limited by itself (#4).
	for _, account := range payload.AccountsWithoutUsage {
		pool := poolOf(account.Provider)
		pool.Accounts = append(pool.Accounts, protocol.RuntimePlanQuotaAccount{
			Label:  ompIdentityLabel(account.Email, account.AccountID, len(pool.Accounts)),
			Status: protocol.PlanQuotaAccountUnknown,
		})
	}
	// Actionable disabled-credential tombstones: disabled accounts.
	for _, disabled := range payload.DisabledCredentials {
		pool := poolOf(disabled.Provider)
		pool.Accounts = append(pool.Accounts, protocol.RuntimePlanQuotaAccount{
			Label:  ompIdentityLabel(disabled.Email, disabled.AccountID, len(pool.Accounts)),
			Status: protocol.PlanQuotaAccountDisabled,
			Note:   ompDisabledNote(),
		})
	}

	// Pool counts and OR status. A pool is limited only when it has at
	// least one account AND every KNOWN-state account is unavailable — an
	// unknown-only pool (usage endpoint failed, nothing measured) stays ok
	// rather than crying "exhausted" (#4). ResumesAt is per-account "latest
	// reset among its exhausted windows" (windows are AND inside an
	// account), then the earliest account wins (#5).
	anyLimited := false
	for _, id := range order {
		pool := pools[id]
		pool.TotalAccounts = len(pool.Accounts)
		earliest := int64(-1)
		for j := range pool.Accounts {
			acc := &pool.Accounts[j]
			switch acc.Status {
			case protocol.PlanQuotaAccountOK, protocol.PlanQuotaAccountWarning:
				pool.AvailableAccounts++
			case protocol.PlanQuotaAccountDisabled:
				pool.DisabledAccounts++
			}
			if acc.Status != protocol.PlanQuotaAccountExhausted && acc.Status != protocol.PlanQuotaAccountReserve {
				continue
			}
			// The account recovers only after its LATEST exhausted-window
			// reset (serial windows inside one account).
			latest := int64(-1)
			for k := range acc.Windows {
				if r := acc.Windows[k].ResetsAt; r != nil && *r > observedAt.Unix() && *r > latest {
					latest = *r
				}
			}
			if latest > 0 && (earliest < 0 || latest < earliest) {
				earliest = latest
			}
		}
		known := pool.TotalAccounts - countAccounts(pool, protocol.PlanQuotaAccountUnknown)
		if pool.AvailableAccounts > 0 || known == 0 {
			pool.Status = protocol.PlanQuotaStatusOK
		} else {
			pool.Status = protocol.PlanQuotaStatusLimited
			anyLimited = true
			if earliest > 0 {
				pool.ResumesAt = &earliest
			}
		}
	}

	quota := &protocol.RuntimePlanQuota{
		Provider:     ompQuotaProvider,
		Status:       protocol.PlanQuotaStatusOK,
		ObservedAt:   observedAt.Unix(),
		Source:       protocol.PlanQuotaSourceDaemon,
		AccountPools: make([]protocol.RuntimePlanQuotaAccountPool, 0, len(order)),
	}
	for _, id := range order {
		quota.AccountPools = append(quota.AccountPools, *pools[id])
	}
	sort.SliceStable(quota.AccountPools, func(i, j int) bool {
		return quota.AccountPools[i].ID < quota.AccountPools[j].ID
	})
	if anyLimited {
		quota.Status = protocol.PlanQuotaStatusLimited
	}
	return quota, nil
}

func countAccounts(pool *protocol.RuntimePlanQuotaAccountPool, status string) int {
	n := 0
	for i := range pool.Accounts {
		if pool.Accounts[i].Status == status {
			n++
		}
	}
	return n
}

// ompReportLabel picks the account's redacted label: metadata.email >
// metadata.accountId > first limit's scope.accountId > positional.
func ompReportLabel(report *ompUsageReport, index int) string {
	if report.Metadata != nil {
		if report.Metadata.Email != "" {
			return report.Metadata.Email
		}
		if report.Metadata.AccountID != "" {
			return report.Metadata.AccountID
		}
	}
	for i := range report.Limits {
		if id := report.Limits[i].Scope.AccountID; id != "" {
			return id
		}
	}
	return fmt.Sprintf("account %d", index+1)
}

func ompIdentityLabel(email, accountID string, index int) string {
	if email != "" {
		return email
	}
	if accountID != "" {
		return accountID
	}
	return fmt.Sprintf("account %d", index+1)
}

// ompAccountWindows maps one report's limits to protocol windows, bucketed
// like OMP's own capacity view: one window per distinct duration (or window
// id when the duration is unknown), the most-burned meter winning inside a
// bucket. Returns the account's overall status too: the report-level policy
// state wins when present (it is the routing truth); otherwise exhausted
// when any window is fully used, else the worst limit status OMP named.
func ompAccountWindows(report *ompUsageReport, observedAt time.Time) ([]protocol.RuntimePlanQuotaWindow, string) {
	type bucket struct {
		window    protocol.RuntimePlanQuotaWindow
		usedFrac  float64
		hasFrac   bool
		exhausted bool
	}
	buckets := make(map[string]*bucket)
	var order []string
	worst := ""
	for i := range report.Limits {
		limit := &report.Limits[i]
		// window is OPTIONAL: key by window id, else scope.windowId,
		// else the limit's own id.
		key := ""
		if limit.Window != nil {
			key = limit.Window.ID
		}
		if key == "" {
			key = limit.Scope.WindowID
		}
		if key == "" {
			key = limit.ID
		}
		frac, hasFrac := ompLimitUsedFraction(limit)
		b, ok := buckets[key]
		if !ok {
			w := protocol.RuntimePlanQuotaWindow{Name: ompWindowName(limit)}
			if limit.Window != nil {
				// resetsAt is independent of durationMs (kimi's weekly
				// window carries only a reset time).
				if limit.Window.ResetsAt > 0 {
					unix := int64(limit.Window.ResetsAt / 1000)
					if unix > observedAt.Unix() {
						w.ResetsAt = &unix
					}
				}
				minutes := ompWindowMinutes(limit.Window)
				if minutes > 0 {
					w.WindowMinutes = &minutes
				}
			}
			b = &bucket{window: w}
			buckets[key] = b
			order = append(order, key)
		}
		if hasFrac && (!b.hasFrac || frac > b.usedFrac) {
			b.usedFrac = frac
			b.hasFrac = true
			used := math.Round(frac * 100)
			b.window.UsedPercent = &used
			if frac >= 1 {
				b.exhausted = true
			}
		}
		if s := ompAccountStatusFor(limit.Status); s != "" && ompWorseAccountStatus(s, worst) {
			worst = s
		}
	}
	windows := make([]protocol.RuntimePlanQuotaWindow, 0, len(order))
	exhausted := false
	for _, key := range order {
		b := buckets[key]
		if b.exhausted {
			exhausted = true
		}
		windows = append(windows, b.window)
	}
	// Policy state is the routing truth (>=18.13): map it directly.
	if report.Policy != nil {
		switch report.Policy.State {
		case "exhausted":
			return windows, protocol.PlanQuotaAccountExhausted
		case "inside-reserve":
			return windows, protocol.PlanQuotaAccountReserve
		case "eligible":
			return windows, protocol.PlanQuotaAccountOK
		case "unknown":
			return windows, protocol.PlanQuotaAccountUnknown
		}
	}
	if exhausted {
		return windows, protocol.PlanQuotaAccountExhausted
	}
	if worst == "" {
		worst = protocol.PlanQuotaAccountOK
	}
	return windows, worst
}

// ompWindowMinutes resolves a window's duration: explicit durationMs, else
// the canonical ids (5h/300m, 7d, 30d) — kimi's weekly window reports no
// durationMs but a canonical id.
func ompWindowMinutes(window *ompUsageWindow) int64 {
	if window.DurationMs > 0 {
		minutes := int64(window.DurationMs / 60000)
		if minutes > 0 {
			return minutes
		}
	}
	switch strings.ToLower(strings.TrimSpace(window.ID)) {
	case "5h", "300m":
		return 300
	case "7d":
		return 10080
	case "30d":
		return 43200
	}
	return 0
}

// ompLimitUsedFraction mirrors OMP's resolveUsedFraction precedence:
// explicit fraction > (no used/limit here) > percent unit. Only the
// explicit fraction is modeled — the JSON always carries it when the
// provider reported one.
func ompLimitUsedFraction(limit *ompUsageLimit) (float64, bool) {
	if limit.Amount.UsedFraction == nil {
		return 0, false
	}
	f := *limit.Amount.UsedFraction
	if !(f >= 0) { // NaN or negative: not usable
		return 0, false
	}
	return f, true
}

// ompWindowName prefers the window id, then the label, then the scope's
// window id, then the limit's own id, capped to the wire bound. Safe on a
// nil window.
func ompWindowName(limit *ompUsageLimit) string {
	name := ""
	if limit.Window != nil {
		name = limit.Window.ID
		if name == "" {
			name = limit.Window.Label
		}
	}
	if name == "" {
		name = limit.Scope.WindowID
	}
	if name == "" {
		name = limit.ID
	}
	if name == "" {
		return "window"
	}
	if len(name) > protocol.PlanQuotaMaxWindowName {
		name = name[:protocol.PlanQuotaMaxWindowName]
	}
	return name
}

// ompAccountStatusFor maps an OMP limit status to the protocol account
// status vocabulary; "" keeps the positional default.
func ompAccountStatusFor(status string) string {
	switch status {
	case "ok":
		return protocol.PlanQuotaAccountOK
	case "warning":
		return protocol.PlanQuotaAccountWarning
	case "exhausted":
		return protocol.PlanQuotaAccountExhausted
	default:
		return ""
	}
}

// ompWorseAccountStatus ranks statuses for worst-of: exhausted > warning >
// ok, unknown trailing.
func ompWorseAccountStatus(candidate, current string) bool {
	rank := map[string]int{
		protocol.PlanQuotaAccountOK:        0,
		protocol.PlanQuotaAccountWarning:   1,
		protocol.PlanQuotaAccountExhausted: 2,
		protocol.PlanQuotaAccountReserve:   1,
		protocol.PlanQuotaAccountDisabled:  2,
		protocol.PlanQuotaAccountUnknown:   0,
	}
	return rank[candidate] > rank[current]
}

// ompDisabledNote is a FIXED note for disabled credentials. OMP stores the
// disable cause verbatim (unredacted upstream text); forwarding it would
// let an identity-bearing cause reject the whole snapshot or leak org
// names, so the protocol carries a stable message instead.
func ompDisabledNote() string {
	return "credential disabled; re-login required"
}

// ompPlanQuotaLoop is the daemon-loop entry point for the OMP collector.
// It resolves the registered omp executable (tests inject a fake path) and
// targets every local omp runtime; snapshots ride the shared heartbeat
// channel like the other collectors.
func (d *Daemon) ompPlanQuotaLoop(ctx context.Context) {
	d.runPlanQuotaCollector(ctx, ompQuotaProvider, d.cfg.PlanQuotaOmpInterval,
		func() []string { return d.runtimeIDsForProvider(ompQuotaProvider) },
		func(ctx context.Context) (*protocol.RuntimePlanQuota, error) {
			entry, ok := d.agents()[ompQuotaProvider]
			if !ok || entry.Path == "" {
				return nil, nil // omp not installed here: nothing to poll
			}
			return newOmpPlanQuotaCollector(entry.Path).collect(ctx)
		})
}
