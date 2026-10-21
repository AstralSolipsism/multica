// Package jev implements the daemon-local decision client for the Jev
// (System One, POST .../v1/systemone) structured decision model used by
// adaptive thinking levels (OL-992 S1-3). The client is fail-open by
// design: every failure mode (timeout, network error, bad payload, open
// breaker, local opt-out) degrades to a typed *FallbackError and never
// blocks the caller beyond one timeout-bounded attempt per source.
//
// Credentials follow the MULTICA_ZENMUX_MANAGEMENT_API_KEY handling: they
// are read from the environment only, travel exclusively in Authorization
// headers, and never appear in logs, error strings, or reported structs.
package jev

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultTimeout is the per-source hard timeout (MULTICA_JEV_TIMEOUT_MS).
	DefaultTimeout = 1500 * time.Millisecond

	// DefaultSources is the default ordered source list (MULTICA_JEV_SOURCES).
	DefaultSources = "opencode-free"

	// breakerThreshold is how many consecutive all-source Decide failures
	// open the breaker; breakerCooldown is how long it then refuses requests
	// before letting a single trial through.
	breakerThreshold = 3
	breakerCooldown  = 60 * time.Second

	opencodeBaseURL   = "https://opencode.ai/zen/v1/systemone"
	opencodeFreeModel = "jev-1.13-free"
	opencodeModel     = "jev-1.13"
	dashscopeModel    = "decision-model-preview"

	maxResponseBytes = 1 << 20
)

// Status values of the health snapshot (contract §3).
const (
	StatusIdle        = "idle"
	StatusAvailable   = "available"
	StatusDegraded    = "degraded"
	StatusUnavailable = "unavailable"
)

// FallbackReason classifies why no decision was produced. Contract values:
// timeout | error | invalid | breaker | disabled.
type FallbackReason string

const (
	ReasonTimeout  FallbackReason = "timeout"
	ReasonError    FallbackReason = "error"
	ReasonInvalid  FallbackReason = "invalid"
	ReasonBreaker  FallbackReason = "breaker"
	ReasonDisabled FallbackReason = "disabled"
)

// Source describes one decision endpoint. BearerToken is empty for
// unauthenticated sources; when set it is a secret that must never be
// logged, serialized, or reported.
type Source struct {
	Name        string
	BaseURL     string
	Model       string
	BearerToken string
}

// SourceEnv carries the Jev credentials read by daemon config loading.
// The key fields are secrets in the MULTICA_ZENMUX_MANAGEMENT_API_KEY
// sense: environment-only, never logged, never serialized.
type SourceEnv struct {
	OpenCodeAPIKey       string
	DashScopeAPIKey      string
	DashScopeWorkspaceID string
	DashScopeRegion      string
}

// ResolveSources maps the ordered, comma-separated source names
// (MULTICA_JEV_SOURCES) to endpoints. Sources whose required variables are
// missing, and unknown names, are skipped with a single warning each.
func ResolveSources(namesCSV string, env SourceEnv) []Source {
	var sources []Source
	for _, name := range strings.Split(namesCSV, ",") {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		switch name {
		case "opencode-free":
			sources = append(sources, Source{Name: name, BaseURL: opencodeBaseURL, Model: opencodeFreeModel})
		case "opencode":
			key := strings.TrimSpace(env.OpenCodeAPIKey)
			if key == "" {
				slog.Warn("jev source skipped: MULTICA_JEV_OPENCODE_API_KEY not set", "source", name)
				continue
			}
			sources = append(sources, Source{Name: name, BaseURL: opencodeBaseURL, Model: opencodeModel, BearerToken: key})
		case "dashscope":
			key := strings.TrimSpace(env.DashScopeAPIKey)
			workspace := strings.TrimSpace(env.DashScopeWorkspaceID)
			if key == "" || workspace == "" {
				slog.Warn("jev source skipped: MULTICA_JEV_DASHSCOPE_API_KEY or MULTICA_JEV_DASHSCOPE_WORKSPACE_ID not set", "source", name)
				continue
			}
			region := strings.TrimSpace(env.DashScopeRegion)
			if region == "" {
				region = "cn-beijing"
			}
			if region != "cn-beijing" && region != "ap-southeast-1" {
				// Only documented MaaS regions resolve; anything else is a
				// silent DNS failure per call, so skip with one warning.
				slog.Warn("jev source skipped: MULTICA_JEV_DASHSCOPE_REGION must be cn-beijing or ap-southeast-1", "source", name, "region", region)
				continue
			}
			sources = append(sources, Source{
				Name:        name,
				BaseURL:     fmt.Sprintf("https://%s.%s.maas.aliyuncs.com/compatible-mode/v1/systemone", workspace, region),
				Model:       dashscopeModel,
				BearerToken: key,
			})
		default:
			slog.Warn("jev source skipped: unknown source name", "source", name)
		}
	}
	return sources
}

// Option is one candidate effort level with the semantic description the
// model uses as its selection criteria.
type Option struct {
	Value       string
	Description string
}

// Request is one decision question. State is a string or a JSON-marshalable
// object, already redacted and truncated by the caller (contract §4).
type Request struct {
	State        any
	Instructions string
	Options      []Option
}

// Decision is a successful Jev answer. LatencyMS is the locally measured
// end-to-end time of the whole Decide call, including failed attempts on
// earlier sources.
type Decision struct {
	Level         string
	Confidence    float64
	Probabilities map[string]float64
	LatencyMS     int64
	Source        string
}

// Snapshot is the daemon-local health view of the engine (contract §3).
// It carries no credentials and no business content. Since is the epoch
// the cumulative counters started at (daemon start) and never moves;
// UpdatedAt advances on every change.
type Snapshot struct {
	Status            string    `json:"status"` // idle|available|degraded|unavailable
	ActiveSource      string    `json:"active_source"`
	LastLatencyMS     int64     `json:"last_latency_ms"`
	DecisionsOK       int64     `json:"decisions_ok"`
	DecisionsFallback int64     `json:"decisions_fallback"`
	Since             time.Time `json:"since"`
	UpdatedAt         time.Time `json:"updated_at"`
}

// FallbackError is returned by Decide and Probe when no usable decision
// was produced; callers proceed with their default level (fail-open). Err
// carries the first source's failure for diagnostics; it is built by this
// package and never contains credentials.
type FallbackError struct {
	Reason FallbackReason
	Err    error
}

func (e *FallbackError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("jev: fallback (%s): %v", e.Reason, e.Err)
	}
	return fmt.Sprintf("jev: fallback (%s)", e.Reason)
}

func (e *FallbackError) Unwrap() error { return e.Err }

// decideRequest is the /v1/systemone wire format. The body is always plain
// JSON: the OpenCode Zen gateway rejects compressed request bodies, so
// Content-Encoding must never be set on the outgoing request.
type decideRequest struct {
	Model     string          `json:"model"`
	State     any             `json:"state"`
	Questions decideQuestions `json:"questions"`
}

type decideQuestions struct {
	Effort decideQuestion `json:"effort"`
}

type decideQuestion struct {
	Type         string          `json:"type"`
	Instructions string          `json:"instructions"`
	Criteria     orderedCriteria `json:"criteria"`
}

// orderedCriteria marshals option→description pairs as a JSON object that
// preserves the caller's option order (encoding/json would sort map keys,
// losing the low→high level ordering the contract relies on).
type orderedCriteria []Option

func (o orderedCriteria) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, opt := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := json.Marshal(opt.Value)
		if err != nil {
			return nil, err
		}
		val, err := json.Marshal(opt.Description)
		if err != nil {
			return nil, err
		}
		b.Write(key)
		b.WriteByte(':')
		b.Write(val)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

type decideResponse struct {
	Answers struct {
		Effort struct {
			Choice        string             `json:"choice"`
			Confidence    float64            `json:"confidence"`
			Probabilities map[string]float64 `json:"probabilities"`
		} `json:"effort"`
	} `json:"answers"`
	// Server-reported latency; may be absent. Snapshot and Decision use the
	// locally measured end-to-end latency instead.
	LatencyMS int64 `json:"latency_ms"`
}

// Options configures New.
type Options struct {
	Disabled bool
	Timeout  time.Duration    // per-source hard timeout; DefaultTimeout when <= 0
	Sources  []Source         // ordered primary → fallback
	Now      func() time.Time // injectable clock for tests; time.Now default
}

// Client is the Jev decision client. It is safe for concurrent use.
type Client struct {
	disabled bool
	timeout  time.Duration
	sources  []Source
	hc       *http.Client
	now      func() time.Time

	mu   sync.Mutex
	snap Snapshot
	brk  breaker
}

// New builds a client sharing one keep-alive transport across all sources.
// The http.Client carries no overall timeout: each attempt gets its own
// context deadline (Options.Timeout).
func New(opts Options) *Client {
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	start := now()
	status := StatusIdle
	if opts.Disabled {
		// Contract §3: 本机关闭或熔断中为 unavailable — a disabled engine
		// starts unavailable, not idle.
		status = StatusUnavailable
	}
	return &Client{
		disabled: opts.Disabled,
		timeout:  timeout,
		sources:  opts.Sources,
		hc: &http.Client{
			Transport: &http.Transport{
				Proxy:               http.ProxyFromEnvironment,
				MaxIdleConns:        4,
				MaxIdleConnsPerHost: 2,
				IdleConnTimeout:     60 * time.Second,
			},
		},
		now:  now,
		snap: Snapshot{Status: status, Since: start, UpdatedAt: start},
	}
}

// Decide asks the configured sources, in order, to pick an effort level.
// On success it returns the winning decision whose LatencyMS covers the
// whole call, including failed attempts on earlier sources; on any failure
// it returns a *FallbackError and the caller proceeds with its default.
func (c *Client) Decide(ctx context.Context, req Request) (Decision, error) {
	started := c.now()
	if c.disabled {
		c.recordDisabled()
		return Decision{}, &FallbackError{Reason: ReasonDisabled}
	}

	c.mu.Lock()
	allowed := c.brk.allow(c.now())
	c.mu.Unlock()
	if !allowed {
		c.recordBreakerFallback()
		return Decision{}, &FallbackError{Reason: ReasonBreaker}
	}

	var firstReason FallbackReason
	var firstErr error
	for i, src := range c.sources {
		dec, reason, err := c.trySource(ctx, src, req)
		if err == nil {
			dec.LatencyMS = c.now().Sub(started).Milliseconds()
			c.recordSuccess(src.Name, dec.LatencyMS)
			return dec, nil
		}
		if i == 0 {
			firstReason, firstErr = reason, err
		}
		// A cancelled caller context fails every source instantly; that is
		// the caller going away, not the sources being down, so it must
		// not count against the breaker or flip the snapshot.
		if ctx.Err() != nil {
			return Decision{}, &FallbackError{Reason: reason, Err: err}
		}
	}
	if len(c.sources) == 0 {
		firstReason, firstErr = ReasonError, errors.New("no sources configured")
	}
	c.recordAllSourcesFailed()
	return Decision{}, &FallbackError{Reason: firstReason, Err: firstErr}
}

// probeRequest is the fixed, business-content-free request Probe sends.
var probeRequest = Request{
	State:        map[string]any{"kind": "health-probe", "component": "jev"},
	Instructions: "Pick the reasoning effort for a routine health check of a decision endpoint.",
	Options: []Option{
		{Value: "low", Description: "routine health check"},
		{Value: "medium", Description: "standard health check"},
		{Value: "high", Description: "thorough health check"},
	},
}

// Probe sends one fixed request to refresh the health snapshot. It never
// touches the decision counters or the breaker; scheduling is owned by the
// caller (S2-2). A successful probe must not mask an open or half-open
// breaker: the status stays unavailable while the breaker holds it, even
// if the probe itself reached a source.
func (c *Client) Probe(ctx context.Context) error {
	started := c.now()
	if c.disabled {
		return &FallbackError{Reason: ReasonDisabled}
	}
	c.mu.Lock()
	blocked := c.brk.probeBlocked(c.now())
	c.mu.Unlock()
	if blocked {
		return &FallbackError{Reason: ReasonBreaker}
	}

	var firstReason FallbackReason
	for i, src := range c.sources {
		_, reason, err := c.trySource(ctx, src, probeRequest)
		if err == nil {
			latency := c.now().Sub(started).Milliseconds()
			c.mu.Lock()
			// Only a closed breaker may report available; the breaker's
			// unavailable verdict wins over a probe success.
			if c.brk.state == brkClosed {
				c.snap.Status = StatusAvailable
			}
			c.snap.ActiveSource = src.Name
			c.snap.LastLatencyMS = latency
			c.snap.UpdatedAt = c.now()
			c.mu.Unlock()
			return nil
		}
		if i == 0 {
			firstReason = reason
		}
	}

	c.mu.Lock()
	if len(c.sources) == 0 {
		firstReason = ReasonError
	}
	// A probe failure never upgrades an open breaker's unavailable status.
	if c.brk.state == brkClosed && c.snap.Status != StatusUnavailable {
		c.snap.Status = StatusDegraded
	}
	c.snap.UpdatedAt = c.now()
	c.mu.Unlock()
	if firstReason == "" {
		firstReason = ReasonError
	}
	return &FallbackError{Reason: firstReason}
}

// Snapshot returns a copy of the current health snapshot.
func (c *Client) Snapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snap
}

// trySource performs one timeout-bounded attempt against one source. The
// returned Decision carries no latency; Decide/Probe measure end-to-end.
func (c *Client) trySource(ctx context.Context, src Source, req Request) (Decision, FallbackReason, error) {
	sctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	criteria := make(orderedCriteria, 0, len(req.Options))
	for _, opt := range req.Options {
		criteria = append(criteria, opt)
	}
	body, err := json.Marshal(decideRequest{
		Model: src.Model,
		State: req.State,
		Questions: decideQuestions{Effort: decideQuestion{
			Type:         "choice",
			Instructions: req.Instructions,
			Criteria:     criteria,
		}},
	})
	if err != nil {
		return Decision{}, ReasonInvalid, fmt.Errorf("source %s: encode request: %w", src.Name, err)
	}

	hreq, err := http.NewRequestWithContext(sctx, http.MethodPost, src.BaseURL, bytes.NewReader(body))
	if err != nil {
		return Decision{}, ReasonError, fmt.Errorf("source %s: %w", src.Name, err)
	}
	// Plain JSON only — the OpenCode Zen gateway rejects Content-Encoding.
	hreq.Header.Set("Content-Type", "application/json")
	if src.BearerToken != "" {
		hreq.Header.Set("Authorization", "Bearer "+src.BearerToken)
	}

	resp, err := c.hc.Do(hreq)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return Decision{}, ReasonTimeout, fmt.Errorf("source %s: %w", src.Name, err)
		}
		return Decision{}, ReasonError, fmt.Errorf("source %s: %w", src.Name, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return Decision{}, ReasonError, fmt.Errorf("source %s: http %d", src.Name, resp.StatusCode)
	}

	// Read once, capped at maxResponseBytes+1: the extra byte detects an
	// oversized response without buffering it all.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return Decision{}, ReasonTimeout, fmt.Errorf("source %s: read response: %w", src.Name, err)
		}
		return Decision{}, ReasonError, fmt.Errorf("source %s: read response: %w", src.Name, err)
	}
	if len(raw) > maxResponseBytes {
		return Decision{}, ReasonInvalid, fmt.Errorf("source %s: response exceeds %d bytes", src.Name, maxResponseBytes)
	}
	// Unmarshal (unlike a streaming Decode) rejects trailing garbage and
	// any second JSON value after the object.
	var out decideResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return Decision{}, ReasonInvalid, fmt.Errorf("source %s: decode response: %w", src.Name, err)
	}
	choice := out.Answers.Effort.Choice
	valid := false
	for _, opt := range req.Options {
		if opt.Value == choice {
			valid = true
			break
		}
	}
	if !valid {
		// Never echo the raw choice: it is untrusted upstream content and
		// could carry anything, including credentials a hostile endpoint
		// reflects back.
		return Decision{}, ReasonInvalid, fmt.Errorf("source %s: choice not in options", src.Name)
	}
	return Decision{
		Level:         choice,
		Confidence:    out.Answers.Effort.Confidence,
		Probabilities: out.Answers.Effort.Probabilities,
		Source:        src.Name,
	}, "", nil
}

// setStatus records the status; caller holds c.mu. Since is the immutable
// counter epoch (contract §3) and deliberately never moves here.
func (c *Client) setStatus(status string) {
	c.snap.Status = status
}

func (c *Client) recordSuccess(source string, latencyMS int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.brk.record(true, c.now())
	c.setStatus(StatusAvailable)
	c.snap.ActiveSource = source
	c.snap.LastLatencyMS = latencyMS
	c.snap.DecisionsOK++
	c.snap.UpdatedAt = c.now()
}

func (c *Client) recordAllSourcesFailed() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.brk.record(false, c.now())
	if c.brk.state == brkOpen {
		c.setStatus(StatusUnavailable)
	} else {
		c.setStatus(StatusDegraded)
	}
	c.snap.DecisionsFallback++
	c.snap.UpdatedAt = c.now()
}

func (c *Client) recordBreakerFallback() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.setStatus(StatusUnavailable)
	c.snap.DecisionsFallback++
	c.snap.UpdatedAt = c.now()
}

func (c *Client) recordDisabled() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.snap.DecisionsFallback++
	c.snap.UpdatedAt = c.now()
}

// breaker refuses requests after breakerThreshold consecutive all-source
// Decide failures, for breakerCooldown, then lets exactly one trial
// through (half-open). Guarded by the client mutex.
type breakerState int

const (
	brkClosed breakerState = iota
	brkOpen
	brkHalfOpen
)

type breaker struct {
	state       breakerState
	consecutive int
	openedAt    time.Time
}

// allow reports whether a Decide request may proceed, transitioning an
// expired open breaker to its single half-open trial.
func (b *breaker) allow(now time.Time) bool {
	switch b.state {
	case brkClosed:
		return true
	case brkOpen:
		if now.Sub(b.openedAt) >= breakerCooldown {
			b.state = brkHalfOpen
			return true
		}
		return false
	default: // brkHalfOpen: one trial already in flight
		return false
	}
}

// probeBlocked is allow's read-only view for probes: a probe must not
// consume the half-open trial slot.
func (b *breaker) probeBlocked(now time.Time) bool {
	switch b.state {
	case brkOpen:
		return now.Sub(b.openedAt) < breakerCooldown
	case brkHalfOpen:
		return true
	default:
		return false
	}
}

func (b *breaker) record(ok bool, now time.Time) {
	if ok {
		b.state = brkClosed
		b.consecutive = 0
		return
	}
	if b.state == brkHalfOpen {
		b.state = brkOpen
		b.openedAt = now
		return
	}
	b.consecutive++
	if b.consecutive >= breakerThreshold {
		b.state = brkOpen
		b.openedAt = now
	}
}
