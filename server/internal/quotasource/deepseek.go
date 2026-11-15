package quotasource

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ---------------------------------------------------------------------------
// DeepSeek official open-platform balance driver.
// ---------------------------------------------------------------------------

// DeepSeekDriver collects the pay-as-you-go account balance from the official
// open platform: GET {base}/user/balance with a Bearer platform API key.
// Unlike glm/zenmux this is a money balance, not percentage windows: the
// per-currency amounts land in the snapshot's Balances, which is allowed only
// because quota_source rows are the owner's explicit registrations.
type DeepSeekDriver struct{}

func (DeepSeekDriver) Kind() string           { return "deepseek" }
func (DeepSeekDriver) DefaultBaseURL() string { return "https://api.deepseek.com" }
func (DeepSeekDriver) AllowedHosts() []string {
	return []string{"api.deepseek.com"}
}
func (DeepSeekDriver) RequiresCredential() bool { return true }

// The provider reports amounts as strings ("48.50"); numbers are tolerated.
// json.RawMessage keeps both shapes parseable.
type deepSeekBalanceInfo struct {
	Currency        string          `json:"currency"`
	TotalBalance    json.RawMessage `json:"total_balance"`
	GrantedBalance  json.RawMessage `json:"granted_balance"`
	ToppedUpBalance json.RawMessage `json:"topped_up_balance"`
}

type deepSeekBalanceResponse struct {
	IsAvailable  *bool                 `json:"is_available"`
	BalanceInfos []deepSeekBalanceInfo `json:"balance_infos"`
}

func (DeepSeekDriver) Fetch(ctx context.Context, client *http.Client, baseURL, credential string, now time.Time) (*protocol.QuotaSourceSnapshot, error) {
	url := strings.TrimRight(baseURL, "/") + "/user/balance"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+credential)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, &ProbeError{Code: "invalid_credential", Status: resp.StatusCode}
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, &ProbeError{Code: "rate_limited", Status: resp.StatusCode}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &ProbeError{Code: "provider_error", Status: resp.StatusCode}
	}
	var raw deepSeekBalanceResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&raw); err != nil {
		return nil, &ProbeError{Code: "unexpected_response", Err: err}
	}

	snap := &protocol.QuotaSourceSnapshot{}
	snap.Provider = "deepseek"
	snap.Status = protocol.PlanQuotaStatusOK
	snap.ObservedAt = now.Unix()
	snap.Source = protocol.PlanQuotaSourceSubscription
	snap.Available = raw.IsAvailable
	for _, info := range raw.BalanceInfos {
		balance := protocol.QuotaSourceBalance{Currency: strings.TrimSpace(info.Currency)}
		balance.TotalBalance = amountFromRaw(info.TotalBalance)
		balance.GrantedBalance = amountFromRaw(info.GrantedBalance)
		balance.ToppedUpBalance = amountFromRaw(info.ToppedUpBalance)
		if balance.TotalBalance == nil && balance.GrantedBalance == nil && balance.ToppedUpBalance == nil {
			continue
		}
		snap.Balances = append(snap.Balances, balance)
	}
	if len(snap.Balances) == 0 {
		return nil, &ProbeError{Code: "unexpected_response", Err: errors.New("no balance info in response")}
	}
	// Unavailable account or drained primary balance → limited (the card
	// renders the destructive "balance exhausted" state). A drained account
	// reports available=false even when the provider's flag said true.
	exhausted := raw.IsAvailable != nil && !*raw.IsAvailable
	if !exhausted {
		primary := snap.Balances[0]
		if primary.TotalBalance != nil && *primary.TotalBalance <= 0 {
			exhausted = true
		}
	}
	if exhausted {
		snap.Status = protocol.PlanQuotaStatusLimited
		unavailable := false
		snap.Available = &unavailable
	}
	return snap, nil
}

// amountFromRaw parses a provider amount that arrives as either a JSON
// string ("48.50") or a bare number. Nil when absent, null or unparsable —
// a real 0 stays distinguishable from "not reported".
func amountFromRaw(raw json.RawMessage) *float64 {
	s := strings.TrimSpace(string(raw))
	s = strings.Trim(s, "\"")
	if s == "" || s == "null" {
		return nil
	}
	value, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return &value
}
