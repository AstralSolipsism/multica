package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

const (
	antigravityQuotaProvider  = "antigravity"
	antigravityQuotaURL       = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota"
	antigravityOAuthTokenFile = ".gemini/antigravity-cli/antigravity-oauth-token"
)

var (
	errAntigravityQuotaToken   = errors.New("antigravity quota: OAuth token unavailable")
	errAntigravityQuotaAuth    = errors.New("antigravity quota: authorization rejected")
	errAntigravityQuotaVersion = errors.New("antigravity quota: CLI version unavailable")
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
	// Discovery retains the full --version line (e.g. "agy version 1.2.16").
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
		return parseAntigravityRemoteQuota(io.LimitReader(resp.Body, 1<<20), time.Now())
	case http.StatusTooManyRequests:
		return nil, &rateLimitError{err: errors.New("antigravity quota: http 429")}
	case http.StatusUnauthorized, http.StatusForbidden:
		return nil, fmt.Errorf("%w (http %d)", errAntigravityQuotaAuth, resp.StatusCode)
	default:
		return nil, fmt.Errorf("antigravity quota: unexpected http %d", resp.StatusCode)
	}
}

// The remote API reports model buckets with optional reset times. Use the most
// constrained model and earliest valid reset in each known pool. Window identity
// is not part of retrieveUserQuota's BucketInfo contract (modelId, tokenType,
// remainingAmount, remainingFraction, resetTime); tokenType names the metered
// resource, not the period. Prefer explicit window metadata if that API adds it.
func parseAntigravityRemoteQuota(body io.Reader, observedAt time.Time) (*protocol.RuntimePlanQuota, error) {
	var response struct {
		Buckets []struct {
			ModelID           string   `json:"modelId"`
			RemainingFraction *float64 `json:"remainingFraction"`
			ResetTime         string   `json:"resetTime"`
		} `json:"buckets"`
	}
	if err := json.NewDecoder(body).Decode(&response); err != nil {
		return nil, errors.New("antigravity quota: invalid response")
	}
	remaining := make(map[string]float64)
	earliestReset := make(map[string]time.Time)
	for _, bucket := range response.Buckets {
		fraction := bucket.RemainingFraction
		if fraction == nil || !(*fraction >= 0 && *fraction <= 1) {
			continue
		}
		var group string
		switch {
		case strings.HasPrefix(bucket.ModelID, "gemini-"):
			group = "gemini"
		case strings.HasPrefix(bucket.ModelID, "claude-"), strings.HasPrefix(bucket.ModelID, "gpt-"):
			group = "claude_gpt"
		default:
			continue
		}
		if current, ok := remaining[group]; !ok || *fraction < current {
			remaining[group] = *fraction
		}
		if t, err := time.Parse(time.RFC3339, bucket.ResetTime); err == nil {
			if current, ok := earliestReset[group]; !ok || t.Before(current) {
				earliestReset[group] = t
			}
		}
	}
	if len(remaining) == 0 {
		return nil, errors.New("antigravity quota: no recognized bucket with a remaining fraction")
	}
	quota := &protocol.RuntimePlanQuota{
		Provider:   antigravityQuotaProvider,
		Status:     protocol.PlanQuotaStatusOK,
		Source:     protocol.PlanQuotaSourceDaemon,
		ObservedAt: observedAt.Unix(),
	}
	for _, group := range []string{"gemini", "claude_gpt"} {
		fraction, ok := remaining[group]
		if !ok {
			continue
		}
		used := (1 - fraction) * 100
		var resetsAt *int64
		var windowMinutes *int64
		if t, ok := earliestReset[group]; ok {
			unix := t.Unix()
			resetsAt = &unix
			// Without explicit window metadata, use the remaining time as a
			// heuristic. A weekly window in its last six hours will look like
			// a 5h window; other periods can also be misclassified. The reset
			// timestamp itself remains authoritative. Anchor the heuristic to
			// this observation so replaying a response gives the same result.
			untilReset := t.Sub(observedAt)
			if untilReset > 0 && untilReset <= 6*time.Hour {
				minutes := int64(300) // 5h rolling window
				windowMinutes = &minutes
			} else if untilReset > 6*time.Hour {
				minutes := int64(10080) // weekly window
				windowMinutes = &minutes
			}
		}
		quota.Windows = append(quota.Windows, protocol.RuntimePlanQuotaWindow{
			Name:          group,
			Group:         group,
			UsedPercent:   &used,
			ResetsAt:      resetsAt,
			WindowMinutes: windowMinutes,
		})
		if fraction == 0 {
			quota.Status = protocol.PlanQuotaStatusLimited
		}
	}
	return quota, nil
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
