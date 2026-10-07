package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

const (
	antigravityQuotaProvider  = "antigravity"
	antigravityQuotaURL       = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
	antigravityOAuthTokenFile = ".gemini/antigravity-cli/antigravity-oauth-token"
)

var (
	errAntigravityQuotaToken   = errors.New("antigravity quota: OAuth token unavailable")
	errAntigravityQuotaAuth    = errors.New("antigravity quota: authorization rejected")
	errAntigravityQuotaVersion = errors.New("antigravity quota: CLI version unavailable")
	errAntigravityQuotaShape   = errors.New("antigravity quota: unusable response")
	antigravityCLIVersionRE    = regexp.MustCompile(`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*`)
)

// The CLI owns token refresh. Read its nested JSON token on every round so a
// remote-control refresh is picked up without restarting the daemon. Only the
// access token goes to Google's fixed HTTPS endpoint; no credentials or account
// metadata enter the heartbeat snapshot or error logs.
type antigravityPlanQuotaCollector struct {
	client   *http.Client
	homeDir  string
	endpoint string // fixed in production; overridable for HTTP fixture tests
}

func newAntigravityPlanQuotaCollector(homeDir string) *antigravityPlanQuotaCollector {
	return &antigravityPlanQuotaCollector{
		client: &http.Client{
			Timeout: 10 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		homeDir:  homeDir,
		endpoint: antigravityQuotaURL,
	}
}

func (c *antigravityPlanQuotaCollector) readToken() (string, error) {
	raw, err := os.ReadFile(filepath.Join(c.homeDir, antigravityOAuthTokenFile))
	if err != nil {
		return "", fmt.Errorf("%w: cannot read token file", errAntigravityQuotaToken)
	}
	var envelope struct {
		Token struct {
			AccessToken string `json:"access_token"`
		} `json:"token"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return "", fmt.Errorf("%w: invalid token file", errAntigravityQuotaToken)
	}
	accessToken := strings.TrimSpace(envelope.Token.AccessToken)
	if accessToken == "" {
		return "", fmt.Errorf("%w: missing access token", errAntigravityQuotaToken)
	}
	return accessToken, nil
}

func (c *antigravityPlanQuotaCollector) collect(ctx context.Context, version string) (*protocol.RuntimePlanQuota, error) {
	// Discovery retains the full --version line (e.g. "agy version 1.3.0").
	// The licensing endpoint expects only the version token in this header.
	version = antigravityCLIVersionRE.FindString(version)
	if version == "" {
		return nil, errAntigravityQuotaVersion
	}
	token, err := c.readToken()
	if err != nil {
		return nil, err
	}
	// Verified against agy 1.2.16: metadata fields cause HTTP 400, and a
	// generic or missing User-Agent causes HTTP 403 ("no valid license").
	// Reverified against 1.3.0 with the summary endpoint (OL-141): an empty
	// body is accepted and no project id is required. A failing summary
	// round is never retried against the legacy per-model endpoint — the
	// collector stays fail-closed so the platform keeps the last snapshot.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, strings.NewReader("{}"))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", "antigravity-cli/"+version)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("antigravity quota request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	switch resp.StatusCode {
	case http.StatusOK:
		return parseAntigravityQuotaSummary(io.LimitReader(resp.Body, 1<<20), time.Now())
	case http.StatusTooManyRequests:
		return nil, &rateLimitError{err: errors.New("antigravity quota: http 429")}
	case http.StatusUnauthorized, http.StatusForbidden:
		return nil, fmt.Errorf("%w (http %d)", errAntigravityQuotaAuth, resp.StatusCode)
	default:
		return nil, fmt.Errorf("antigravity quota: unexpected http %d", resp.StatusCode)
	}
}

// The summary endpoint reports one bucket per quota pool and window type
// (OL-141 live capture against agy 1.3.0, matching the Antigravity client's
// own usage page): bucketId names pool and period (gemini-5h, gemini-weekly,
// 3p-5h, 3p-weekly), window states the period explicitly, and each bucket
// carries its own remainingFraction and resetTime. Every recognized bucket
// maps to exactly one window — no aggregation across buckets, no period
// inference. Unknown pools are skipped; anything malformed inside a known
// pool fails the whole round (fail-closed) so the platform keeps the last
// snapshot instead of half-fresh data.
func parseAntigravityQuotaSummary(body io.Reader, observedAt time.Time) (*protocol.RuntimePlanQuota, error) {
	var response struct {
		Groups []struct {
			Buckets []struct {
				BucketID          string   `json:"bucketId"`
				Window            string   `json:"window"`
				RemainingFraction *float64 `json:"remainingFraction"`
				ResetTime         string   `json:"resetTime"`
			} `json:"buckets"`
		} `json:"groups"`
	}
	if err := json.NewDecoder(body).Decode(&response); err != nil {
		return nil, fmt.Errorf("%w: invalid json", errAntigravityQuotaShape)
	}
	quota := &protocol.RuntimePlanQuota{
		Provider:   antigravityQuotaProvider,
		Status:     protocol.PlanQuotaStatusOK,
		Source:     protocol.PlanQuotaSourceDaemon,
		ObservedAt: observedAt.Unix(),
	}
	seen := make(map[string]bool)
	for _, group := range response.Groups {
		for _, bucket := range group.Buckets {
			var pool string
			switch {
			case strings.HasPrefix(bucket.BucketID, "gemini-"):
				pool = "gemini"
			case strings.HasPrefix(bucket.BucketID, "3p-"):
				pool = "claude_gpt"
			default:
				continue
			}
			if bucket.RemainingFraction == nil || !(*bucket.RemainingFraction >= 0 && *bucket.RemainingFraction <= 1) {
				return nil, fmt.Errorf("%w: bucket %q lacks a valid remaining fraction", errAntigravityQuotaShape, bucket.BucketID)
			}
			window := protocol.RuntimePlanQuotaWindow{Group: pool}
			switch bucket.Window {
			case "5h":
				window.Name = pool + "_5h"
				minutes := int64(300)
				window.WindowMinutes = &minutes
			case "weekly":
				window.Name = pool + "_weekly"
				minutes := int64(10080)
				window.WindowMinutes = &minutes
			default:
				// Unrecognized or missing period: keep the bucket
				// identifiable via its raw id, never guess a length.
				window.Name = bucket.BucketID
			}
			used := math.Round((1-*bucket.RemainingFraction)*10000) / 100
			window.UsedPercent = &used
			// A fully replenished window reports a rolling "now + period"
			// reset that advances on every collection, so it carries no
			// countdown; anything the provider does disclose is parsed with
			// fractional-second tolerance and passed through verbatim.
			if *bucket.RemainingFraction < 1 {
				if reset, err := time.Parse(time.RFC3339Nano, bucket.ResetTime); err == nil {
					unix := reset.Unix()
					window.ResetsAt = &unix
				}
			}
			if seen[window.Name] {
				return nil, fmt.Errorf("%w: duplicate window %q", errAntigravityQuotaShape, window.Name)
			}
			seen[window.Name] = true
			if *bucket.RemainingFraction == 0 {
				quota.Status = protocol.PlanQuotaStatusLimited
			}
			quota.Windows = append(quota.Windows, window)
		}
	}
	if len(quota.Windows) == 0 {
		return nil, fmt.Errorf("%w: no recognized quota pool", errAntigravityQuotaShape)
	}
	// Stable display order: Gemini pool first, 5h before weekly inside a
	// pool, unrecognized buckets last.
	sort.SliceStable(quota.Windows, func(i, j int) bool {
		ri, rj := antigravityWindowRank(quota.Windows[i]), antigravityWindowRank(quota.Windows[j])
		if ri != rj {
			return ri < rj
		}
		return quota.Windows[i].Name < quota.Windows[j].Name
	})
	return quota, nil
}

func antigravityWindowRank(window protocol.RuntimePlanQuotaWindow) int {
	switch window.Name {
	case "gemini_5h":
		return 0
	case "gemini_weekly":
		return 1
	case "claude_gpt_5h":
		return 2
	case "claude_gpt_weekly":
		return 3
	default:
		return 4
	}
}

func (d *Daemon) antigravityPlanQuotaLoop(ctx context.Context) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		d.logger.Debug("antigravity quota collector disabled: no home directory")
		return
	}
	d.runAntigravityPlanQuotaCollector(ctx, newAntigravityPlanQuotaCollector(homeDir), defaultPlanQuotaPollInterval)
}

func (d *Daemon) runAntigravityPlanQuotaCollector(ctx context.Context, collector *antigravityPlanQuotaCollector, interval time.Duration) {
	d.runPlanQuotaCollector(ctx, antigravityQuotaProvider, interval, func() []string {
		return d.runtimeIDsForProvider(antigravityQuotaProvider)
	}, func(ctx context.Context) (*protocol.RuntimePlanQuota, error) {
		entry, ok := d.agents()[antigravityQuotaProvider]
		if !ok || entry.Path == "" {
			d.recordAntigravityQuotaSkip(antigravityQuotaSkipNotRegistered)
			return nil, nil
		}
		version := d.agentVersion(antigravityQuotaProvider)
		if version == "" {
			d.recordAntigravityQuotaSkip(antigravityQuotaSkipNoVersion)
			return nil, nil
		}
		quota, err := collector.collect(ctx, version)
		if err != nil {
			d.recordAntigravityQuotaSkip(antigravityQuotaSkipReasonFor(err))
		} else {
			d.recordAntigravityQuotaSuccess()
		}
		return quota, err
	})
}
