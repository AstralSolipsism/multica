package agent

import (
	"context"
	"crypto/tls"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Antigravity quota probe.
//
// While an agy process is alive it serves an embedded Connect-RPC language
// server on a loopback port, and `RetrieveUserQuotaSummary` on it returns the
// account's model-quota summary: two pools ("Gemini models" and "Claude and
// GPT models"), each with a five-hour and a weekly bucket — four numbers that
// a single 5h/weekly window pair would collapse.
//
// IMPORTANT: this is an UNDOCUMENTED INTERNAL protocol, reverse-engineered by
// the community (CodexBar / usagebar provider notes); Google may change or
// drop it in any release without notice. The probe is therefore built to fail
// soft in every dimension:
//
//   - it only ever talks to an ALREADY RUNNING local agy process the user
//     started (it never launches agy, never touches its credentials, and
//     never sends anything off the machine);
//   - it is version-gated to the release range where the community-verified
//     response shape was observed — an unknown version is skipped rather than
//     probed;
//   - every call is time-boxed and every malformed answer is discarded;
//   - the community is not even unanimous about CSRF handling (the CLI
//     endpoint is documented as requiring no token by one source and as
//     taking an empty token by another), so the header is sent empty —
//     satisfying both readings — and a CSRF rejection is just another
//     silent "not reported", never an assumed-unauthenticated call.
//
// The parsed result feeds protocol.RuntimePlanQuota. The privacy red line
// holds end to end: the request carries only static UI metadata, the parser
// reads group/bucket names and remaining fractions, and account identity
// fields the backend also returns (account email, plan name, credits) are
// never surfaced — the wire shape has nowhere to put them.

const (
	// antigravityQuotaService is the Connect-RPC service prefix of agy's
	// embedded language server, as served on every loopback port it binds.
	antigravityQuotaService = "/exa.language_server_pb.LanguageServerService/"
	// antigravityQuotaMethod is the quota-summary RPC. Community docs
	// describe GetUserStatus / GetCommandModelConfigs fallbacks, but those
	// return per-model rows without the two-group weekly/5h grouping, so
	// without the primary method the probe reports nothing rather than
	// inventing a window split the backend did not send.
	antigravityQuotaMethod = "RetrieveUserQuotaSummary"
	// antigravityQuotaProvider is the runtime provider the snapshot is
	// reported under.
	antigravityQuotaProvider = "antigravity"

	// antigravityQuotaProbeBudget bounds one whole probe round (process scan,
	// port scan, and the RPC attempts), so a wedged agy or a full loopback
	// scan can never hold up anything the daemon does around it.
	antigravityQuotaProbeBudget = 6 * time.Second
	// antigravityQuotaRequestTimeout bounds one Connect-RPC call.
	antigravityQuotaRequestTimeout = 2500 * time.Millisecond
	// antigravityQuotaIdleConnTimeout is the transport's idle-connection
	// lifetime. The probe closes pooled connections at the end of every round
	// anyway; this is the backstop that bounds any connection a panic or
	// future code path leaves behind.
	antigravityQuotaIdleConnTimeout = time.Minute
	// antigravityQuotaResponseLimit caps how much of a response body is read.
	// The quota summary with its two groups is a few KB; 1 MiB is generous.
	antigravityQuotaResponseLimit = 1 << 20

	// antigravityQuotaMaxProcesses caps how many agy processes are considered
	// per round (a machine can host an interactive TUI plus daemon-spawned
	// one-shot runs).
	antigravityQuotaMaxProcesses = 4
	// antigravityQuotaMaxPorts caps how many listening ports per process are
	// probed.
	antigravityQuotaMaxPorts = 8
)

// antigravityQuotaProcesses / antigravityQuotaListeningPorts are the
// per-platform discovery steps, indirected so tests can pin them to a fake
// process landscape. The vars hold the platform implementations by default
// (antigravity_quota_{linux,unix,windows}.go define the real functions).
// Both take the probe's context: a caller deadline (the per-task sampler's
// discovery window) must cancel a scan in flight and stop the ones not yet
// started, not merely be checked between rounds.
var (
	antigravityQuotaProcesses      = antigravityQuotaProcessesImpl
	antigravityQuotaListeningPorts = listeningLoopbackPorts
)

// Sentinel probe failures. They add no behavior — every failure still
// degrades to the same silent "not reported" — but they let the daemon tell
// the one failure that can resolve itself by retrying while a task runs
// (no live agy process: not spawned yet, or already exited) apart from the
// terminal ones, and name a stable reason on /health without string-matching
// error text.
var (
	// ErrAntigravityNotRunning: the process scan found no live agy process.
	ErrAntigravityNotRunning = errors.New("antigravity quota probe: no running agy process")
	// ErrAntigravityVersionUnsupported: the detected version sits outside the
	// range the response parser was written against.
	ErrAntigravityVersionUnsupported = errors.New("antigravity quota probe: agy version")
)

// antigravityQuotaWindowMinutes maps the two documented window kinds onto
// the minute counts the plan-quota wire shape (and the UI's "5h"/"wk"
// labels) understand.
const (
	antigravityQuotaWindow5hMinutes    = 300
	antigravityQuotaWindowWeeklyMinute = 10080
)

// antigravityQuotaMinVersion / antigravityQuotaMaxVersion bound the agy
// releases the probe is willing to question. The response shape below was
// observed on 1.0.x/1.1.x; a 2.0 (or anything else) may serve different
// fields entirely, and probing an unknown shape buys nothing — the snapshot
// would be dropped at parse time anyway. The probe treats "version outside
// the observed range" the same as "agy not running": silently not reported.
var (
	antigravityQuotaMinVersion = semver{Major: 1, Minor: 0, Patch: 0}
	// Exclusive upper bound.
	antigravityQuotaMaxVersion = semver{Major: 2, Minor: 0, Patch: 0}
)

// AntigravityQuotaProbeSupported reports whether the detected agy version is
// inside the range the probe's parser was written against. Unknown (empty or
// unparsable) versions fail closed.
func AntigravityQuotaProbeSupported(version string) bool {
	parsed, err := parseSemver(version)
	if err != nil {
		return false
	}
	return !parsed.lessThan(antigravityQuotaMinVersion) && parsed.lessThan(antigravityQuotaMaxVersion)
}

// ProbeAntigravityQuota runs one probe round against the local agy install:
// find live agy processes, discover their loopback listeners, and return the
// first four-bucket quota summary that parses. execPath is the resolved agy
// executable the daemon would launch; version is its detected version string.
//
// Fail-soft contract: ANY failure — agy not running, unsupported version, no
// reachable listener, timeout, unrecognized payload — returns (nil, err) and
// the caller reports nothing. A nil error always carries a snapshot with at
// least one understood bucket.
func ProbeAntigravityQuota(ctx context.Context, execPath, version string, now time.Time) (*protocol.RuntimePlanQuota, error) {
	if !AntigravityQuotaProbeSupported(version) {
		return nil, fmt.Errorf("%w %q outside the probed range", ErrAntigravityVersionUnsupported, version)
	}
	ctx, cancel := context.WithTimeout(ctx, antigravityQuotaProbeBudget)
	defer cancel()
	if err := ctx.Err(); err != nil {
		// A caller that already spent its window (or cancelled) gets a
		// cancellation, not a misleading "agy not running" from a scan that
		// would answer nothing.
		return nil, fmt.Errorf("antigravity quota probe: %w", err)
	}

	pids := antigravityQuotaProcesses(ctx, execPath)
	if len(pids) == 0 {
		return nil, ErrAntigravityNotRunning
	}
	if len(pids) > antigravityQuotaMaxProcesses {
		pids = pids[:antigravityQuotaMaxProcesses]
	}

	client := newProbeQuotaClient()
	// Round-scoped connection lifecycle: whatever connections the round
	// pooled are closed when it returns, so a daemon probing every few
	// minutes never leaves idle sockets with the dead agy of a previous
	// round (R5).
	defer client.CloseIdleConnections()
	for _, pid := range pids {
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("antigravity quota probe: %w", err)
		}
		ports := antigravityQuotaListeningPorts(ctx, pid)
		if len(ports) > antigravityQuotaMaxPorts {
			ports = ports[:antigravityQuotaMaxPorts]
		}
		for _, port := range ports {
			if err := ctx.Err(); err != nil {
				return nil, fmt.Errorf("antigravity quota probe: %w", err)
			}
			body, err := antigravityQuotaRPC(ctx, client, port)
			if err != nil {
				continue
			}
			quota, err := parseAntigravityQuotaSummary(body, now)
			if err != nil {
				continue
			}
			return quota, nil
		}
	}
	return nil, errors.New("antigravity quota probe: no agy listener answered with a quota summary")
}

// newProbeQuotaClient is the probe's HTTP client constructor, indirected so
// tests can instrument dialing (the default is newLoopbackQuotaClient).
var newProbeQuotaClient = newLoopbackQuotaClient

// newLoopbackQuotaClient builds the HTTP client used for probe calls. Three
// hard walls (R4):
//
//   - redirects are refused before any second request is sent — a compromised
//     or hijacked listener cannot bounce the probe at an outside host;
//   - the transport's dialer only completes connections whose destination is
//     a LITERAL loopback IP address, so even a bug elsewhere in the request
//     path cannot produce an off-machine dial;
//   - the self-signed-certificate allowance therefore only ever applies to
//     loopback connections: with the dialer refusing every non-loopback
//     literal (and every hostname — no DNS resolution to hijack), there is no
//     reachable target the relaxed verification could be stretched to.
func newLoopbackQuotaClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy:       nil, // never route a loopback probe through a configured proxy
			DialContext: antigravityQuotaDialGuard,
			// Belt and braces for the round-scoped CloseIdleConnections: a
			// pooled connection that somehow outlives the probe still dies
			// far before the next 5-minute round.
			IdleConnTimeout: antigravityQuotaIdleConnTimeout,
			TLSClientConfig: &tls.Config{
				// Self-signed loopback cert, see above: reachable only for
				// connections the loopback dial guard already vetted.
				InsecureSkipVerify: true,
			},
		},
		Timeout: antigravityQuotaRequestTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// ErrUseLastResponse: client.Do returns the 3xx itself (which
			// then fails the status check) without following it.
			return http.ErrUseLastResponse
		},
	}
}

// antigravityQuotaDialGuard is the transport's dial hook: it verifies the
// destination before any bytes leave the process. Only literal loopback IP
// literals pass — hostnames are rejected without resolution so a redirected
// or future-bugged URL can only ever fail, never resolve somewhere.
func antigravityQuotaDialGuard(ctx context.Context, network, addr string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("antigravity quota probe: dial target %q is not host:port", addr)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return nil, fmt.Errorf("antigravity quota probe: refusing non-loopback dial target %q", addr)
	}
	var dialer net.Dialer
	dialer.Timeout = antigravityQuotaRequestTimeout
	return dialer.DialContext(ctx, network, addr)
}

// parseAntigravityTasklistPIDs extracts the PIDs from `tasklist /FO CSV /NH`
// output. Real tasklist rows look like
//
//	"agy.exe","1234","Console","1","12,345 K"
//
// — five quoted columns where the memory cell legitimately contains a comma —
// so the parse goes through encoding/csv (whole records, RFC-4180 quoting,
// CRLF) rather than any per-line shortcut. Lives in the shared file because
// it is pure text handling; the Windows scanner is its only caller. The
// `INFO: no tasks…` line tasklist prints when nothing matches parses as a
// single-column record and is dropped by the column check.
func parseAntigravityTasklistPIDs(data string) []int {
	// Some tool hosts prefix output with a UTF-8 BOM; strip it so the first
	// record's image cell compares clean.
	data = strings.TrimPrefix(data, "\uFEFF")
	reader := csv.NewReader(strings.NewReader(data))
	// Tolerate ragged rows: a malformed trailing line should cost its own
	// record, not the whole batch (SetFieldsPerRecord(0) would enforce equal
	// widths and ReadAll would drop everything on the first deviation).
	reader.FieldsPerRecord = -1
	// tasklist quotes fields consistently, but accept lazy quotes so one odd
	// cell cannot abort the scan of every running instance.
	reader.LazyQuotes = true
	records, err := reader.ReadAll()
	if err != nil && len(records) == 0 {
		return nil
	}
	seen := make(map[int]bool)
	var pids []int
	for _, record := range records {
		// CSV columns: "image","pid","session name","session #","mem usage".
		if len(record) < 2 {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(record[1]))
		if err != nil || pid <= 0 || seen[pid] {
			continue
		}
		seen[pid] = true
		pids = append(pids, pid)
	}
	return pids
}

// parseAntigravityNetstatPorts extracts the TCP ports one PID owns from
// `netstat -ano -p tcp` output (the Windows scanner's second parser, kept in
// the shared file so the cross-platform suite can regression-test it).
// Column positions are stable across locales; the state TEXT is not, so the
// parse is structural: proto=TCP, local address second, owning PID last.
// Both listening and established sockets count — the caller's dial decides
// reachability, and a non-listening port simply fails its RPC attempt.
func parseAntigravityNetstatPorts(data string, pid int) []int {
	want := strconv.Itoa(pid)
	seen := make(map[int]bool)
	var ports []int
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(line)
		// Active Connections rows: Proto Local Foreign State PID. The header
		// line has four fields and no PID, so the count check drops it.
		if len(fields) != 5 || !strings.EqualFold(fields[0], "TCP") {
			continue
		}
		if fields[4] != want {
			continue
		}
		// Local address carries the port after its last colon.
		idx := strings.LastIndex(fields[1], ":")
		if idx < 0 {
			continue
		}
		port, err := strconv.ParseUint(fields[1][idx+1:], 10, 16)
		if err != nil || port == 0 || seen[int(port)] {
			continue
		}
		seen[int(port)] = true
		ports = append(ports, int(port))
	}
	return ports
}

// antigravityQuotaURL builds the Connect-RPC endpoint for one method. The
// loopback host is a hard invariant here — the insecure-TLS client above must
// never be pointed anywhere else — so the port is the only free dimension.
func antigravityQuotaURL(port int) string {
	host := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	if ip := net.ParseIP("127.0.0.1"); ip == nil || !ip.IsLoopback() {
		// Unreachable by construction; guards future edits that touch the host.
		panic("antigravity quota probe: host must stay loopback")
	}
	return "https://" + host + antigravityQuotaService + antigravityQuotaMethod
}

// antigravityQuotaRPC issues one Connect-RPC (JSON-over-HTTP) call. The CSRF
// header is sent EMPTY: the CLI server is documented both as requiring no
// token and as taking an empty one, and the daemon deliberately does not read
// app/IDE token material to fill it. A CSRF rejection is a failed probe round
// (silent "not reported"), never an assumed-unauthenticated call.
func antigravityQuotaRPC(ctx context.Context, client *http.Client, port int) ([]byte, error) {
	body := `{"metadata":{"ideName":"antigravity","extensionName":"antigravity","ideVersion":"unknown","locale":"en"}}`
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, antigravityQuotaURL(port), strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connect-Protocol-Version", "1")
	req.Header.Set("X-Codeium-Csrf-Token", "")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("antigravity quota rpc: status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, antigravityQuotaResponseLimit))
	if err != nil {
		return nil, err
	}
	return data, nil
}

// antigravityQuotaSummary mirrors the undocumented RetrieveUserQuotaSummary
// response. The documented shape nests the group list under `response`,
// older payloads hang it off the top level, and buckets may carry the
// remaining fraction either under a `remaining` object or flat. Raw messages
// let the parser try both homes without failing on either.
type antigravityQuotaSummary struct {
	Response json.RawMessage `json:"response"`
	Groups   json.RawMessage `json:"groups"`
}

type antigravityQuotaGroups struct {
	Groups []antigravityQuotaGroup `json:"groups"`
}

type antigravityQuotaGroup struct {
	DisplayName string                   `json:"displayName"`
	Name        string                   `json:"name"`
	ID          string                   `json:"id"`
	Buckets     []antigravityQuotaBucket `json:"buckets"`
}

type antigravityQuotaBucket struct {
	BucketID    string `json:"bucketId"`
	DisplayName string `json:"displayName"`
	Description string `json:"description"`
	Remaining   *struct {
		RemainingFraction *float64 `json:"remainingFraction"`
		ResetTime         string   `json:"resetTime"`
	} `json:"remaining"`
	RemainingFraction *float64 `json:"remainingFraction"`
	ResetTime         string   `json:"resetTime"`
}

// parseAntigravityQuotaSummary converts a quota summary payload into the
// unified plan-quota snapshot: one window per understood bucket, each carrying
// its quota pool as the optional Group. Buckets without a remaining fraction
// are dropped (the UI must never render a fabricated percentage), and a
// payload that yields no window at all is a parse failure — the caller
// reports nothing rather than an empty "everything fine" snapshot.
func parseAntigravityQuotaSummary(body []byte, now time.Time) (*protocol.RuntimePlanQuota, error) {
	var parsed antigravityQuotaSummary
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("antigravity quota: %w", err)
	}
	// The documented shape nests the groups under `response`; the top level
	// carries them as a bare array. Prefer the nested one, but fall through
	// when it carries no groups at all.
	var groups []antigravityQuotaGroup
	if len(parsed.Response) > 0 {
		var nested antigravityQuotaGroups
		if err := json.Unmarshal(parsed.Response, &nested); err == nil {
			groups = nested.Groups
		}
	}
	if len(groups) == 0 && len(parsed.Groups) > 0 {
		_ = json.Unmarshal(parsed.Groups, &groups)
	}
	if len(groups) == 0 {
		return nil, errors.New("antigravity quota: no groups in response")
	}

	quota := &protocol.RuntimePlanQuota{
		Provider:   antigravityQuotaProvider,
		Status:     protocol.PlanQuotaStatusOK,
		ObservedAt: now.Unix(),
		Source:     protocol.PlanQuotaSourceDaemon,
	}
	seen := make(map[string]bool)
	for _, group := range groups {
		groupKey := antigravityQuotaGroupKey(group)
		for _, bucket := range group.Buckets {
			fraction := bucketRemainingFraction(bucket)
			if fraction == nil {
				// A bucket without a fraction (reset metadata only, in the
				// community docs) cannot be rendered honestly — skip it.
				continue
			}
			if *fraction < 0 || *fraction > 1 {
				// Outside the documented 0..1 contract; not a number this
				// parser was shown, so not a number the UI should carry.
				continue
			}
			window := antigravityQuotaWindow(groupKey, bucket, *fraction, now)
			if window.Name == "" || seen[window.Name] {
				continue
			}
			seen[window.Name] = true
			if *fraction <= 0 {
				// An empty pool means the account is being rate limited on
				// that group — the closest thing this backend has to a
				// "limited" signal.
				quota.Status = protocol.PlanQuotaStatusLimited
			}
			quota.Windows = append(quota.Windows, window)
		}
	}
	if len(quota.Windows) == 0 {
		return nil, errors.New("antigravity quota: no bucket with a remaining fraction")
	}
	return quota, nil
}

// bucketRemainingFraction reads the fraction from whichever documented spot
// the bucket carries it.
func bucketRemainingFraction(bucket antigravityQuotaBucket) *float64 {
	if bucket.Remaining != nil && bucket.Remaining.RemainingFraction != nil {
		return bucket.Remaining.RemainingFraction
	}
	return bucket.RemainingFraction
}

// antigravityQuotaWindow builds one wire window from a bucket: a stable
// `group_window` name, the used percent, the window length when the bucket's
// wording identifies it, and the reset timestamp when one is parseable.
func antigravityQuotaWindow(groupKey string, bucket antigravityQuotaBucket, fraction float64, now time.Time) protocol.RuntimePlanQuotaWindow {
	haystack := strings.ToLower(bucket.BucketID + " " + bucket.DisplayName + " " + bucket.Description)
	windowMinutes := antigravityQuotaWindowMinutesFor(haystack)
	// Two decimals keep binary-fraction noise (1-0.72 == 0.28000…4) out of
	// the snapshot without pretending the backend sent more precision than a
	// fraction does.
	usedPercent := math.Round((1-fraction)*100*100) / 100

	var suffix string
	switch {
	case windowMinutes != nil && *windowMinutes == antigravityQuotaWindowWeeklyMinute:
		suffix = "weekly"
	case windowMinutes != nil && *windowMinutes == antigravityQuotaWindow5hMinutes:
		suffix = "5h"
	default:
		suffix = antigravityQuotaSlug(bucket.BucketID, bucket.DisplayName)
	}
	name := groupKey + "_" + suffix
	if len(name) > protocol.PlanQuotaMaxWindowName {
		name = name[:protocol.PlanQuotaMaxWindowName]
	}

	window := protocol.RuntimePlanQuotaWindow{
		Name:          name,
		Group:         groupKey,
		UsedPercent:   float64Pointer(usedPercent),
		WindowMinutes: windowMinutes,
		ResetsAt:      antigravityQuotaResetAt(bucket, now),
	}
	return window
}

// antigravityQuotaWindowMinutesFor classifies a bucket's wording into one of
// the two documented windows, or nil when the wording matches neither — an
// unclassifiable bucket keeps its name but carries no window length, so the
// UI renders it as an unlabeled bar instead of guessing "5h".
func antigravityQuotaWindowMinutesFor(haystack string) *int64 {
	switch {
	case strings.Contains(haystack, "week"):
		return int64Pointer(antigravityQuotaWindowWeeklyMinute)
	case strings.Contains(haystack, "hour"), strings.Contains(haystack, "session"), strings.Contains(haystack, "5h"):
		return int64Pointer(antigravityQuotaWindow5hMinutes)
	default:
		return nil
	}
}

// antigravityQuotaGroupKey maps a quota group onto a stable wire group key:
// the two documented pools get fixed keys (the i18n layer renders them as
// "Gemini" / "Claude + GPT"); anything else keeps a slug of the backend's own
// label so a future third pool degrades to readable-but-untranslated.
func antigravityQuotaGroupKey(group antigravityQuotaGroup) string {
	label := strings.ToLower(group.DisplayName + " " + group.Name + " " + group.ID)
	switch {
	case strings.Contains(label, "gemini"):
		return "gemini"
	case strings.Contains(label, "claude"), strings.Contains(label, "gpt"):
		return "claude_gpt"
	default:
		return antigravityQuotaSlug(group.DisplayName, group.Name, group.ID)
	}
}

// antigravityQuotaSlug builds a lowercase identifier from the first non-empty
// piece of backend-provided text: letters/digits survive, runs of anything
// else collapse to one underscore. Empty input falls through to "other" so a
// window name is never just a bare separator.
func antigravityQuotaSlug(pieces ...string) string {
	source := ""
	for _, piece := range pieces {
		if strings.TrimSpace(piece) != "" {
			source = piece
			break
		}
	}
	var b strings.Builder
	lastUnderscore := false
	for _, r := range strings.ToLower(source) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			lastUnderscore = false
		default:
			if !lastUnderscore && b.Len() > 0 {
				b.WriteByte('_')
				lastUnderscore = true
			}
		}
	}
	slug := strings.Trim(b.String(), "_")
	if len(slug) > protocol.PlanQuotaMaxGroupName {
		slug = slug[:protocol.PlanQuotaMaxGroupName]
	}
	if slug == "" {
		slug = "other"
	}
	return slug
}

// antigravityQuotaResetAt extracts a reset timestamp for a bucket. The
// documented reset prose is free text, so the parser only commits to shapes
// it can read exactly: an explicit resetTime field in RFC3339 or epoch-seconds
// form, else an RFC3339-looking timestamp inside the description. No match —
// no reset time; the UI keeps the row without a countdown.
func antigravityQuotaResetAt(bucket antigravityQuotaBucket, now time.Time) *int64 {
	candidates := make([]string, 0, 3)
	if bucket.Remaining != nil {
		candidates = append(candidates, bucket.Remaining.ResetTime)
	}
	candidates = append(candidates, bucket.ResetTime, bucket.Description)
	for _, candidate := range candidates {
		if seconds, ok := parseAntigravityTimestamp(candidate, now); ok {
			return &seconds
		}
	}
	return nil
}

// antigravityISOTimeRe matches an ISO-8601 timestamp anywhere in free text
// ("resets 2026-09-06T14:23:01Z …").
var antigravityISOTimeRe = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?`)

// parseAntigravityTimestamp parses one reset timestamp in the shapes the
// community docs observed: RFC3339 (optionally embedded in prose) or bare
// epoch seconds. Anything else reports failure.
func parseAntigravityTimestamp(raw string, now time.Time) (int64, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, false
	}
	if epoch, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
		// Epoch seconds are the fallback shape; reject values that would
		// parse but cannot be a plausible wall-clock second count either side
		// of now.
		if epoch > 1_000_000_000 && epoch < now.Unix()+10*365*24*3600 {
			return epoch, true
		}
		return 0, false
	}
	if ts := antigravityISOTimeRe.FindString(trimmed); ts != "" {
		// Go's RFC3339 handles the Z and ±hh:mm zone suffixes; the ±hhmm
		// variant needs its colon restored first.
		if t, err := time.Parse(time.RFC3339, ts); err == nil {
			return t.Unix(), true
		}
		normalized := antigravityZoneColonRe.ReplaceAllString(ts, "$1:$2")
		if t, err := time.Parse(time.RFC3339, normalized); err == nil {
			return t.Unix(), true
		}
	}
	return 0, false
}

// antigravityZoneColonRe rewrites a ±hhmm UTC offset into the ±hh:mm shape
// time.RFC3339 parses.
var antigravityZoneColonRe = regexp.MustCompile(`([+-]\d{2})(\d{2})$`)

func int64Pointer(v int64) *int64 {
	if v <= 0 {
		return nil
	}
	return &v
}

func float64Pointer(v float64) *float64 {
	return &v
}

// antigravityExecutableMatches reports whether one process's argv tokens
// refer to the resolved agy executable. Only argv[0] may match by basename —
// an interactive `agy` started from a PATH shell shows its bare name there
// while the daemon resolved the absolute path — later tokens must equal the
// resolved path exactly, so `ccms agy` (agy as an argument) never matches.
// The per-platform scanners normalize their process listing into tokens and
// delegate here.
func antigravityExecutableMatches(tokens []string, execPath, base string) bool {
	if base == "" {
		return false
	}
	for i, token := range tokens {
		if token == "" {
			continue
		}
		if token == execPath {
			return true
		}
		if i == 0 && filepath.Base(token) == base {
			return true
		}
	}
	return false
}
