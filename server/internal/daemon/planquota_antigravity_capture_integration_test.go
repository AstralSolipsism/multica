//go:build agentintegration

package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	_ "time/tzdata"

	"github.com/multica-ai/multica/server/pkg/agent"
)

// OL-141 live evidence capture. The goal is to document, against the real
// Antigravity backend, which host/interface/body/token file the quota windows
// come from, without changing any collection behavior. Rules carried over from
// the issue: at most 12 requests with a 1s gap, stop on the first 429, token
// only ever sent to the two fixed googleapis hosts, no token refresh, no file
// writes, no heartbeat, no agy tasks. Only whitelisted field values are
// printed; every other field is listed by name so the response shape and its
// casing remain visible. Tokens, full emails, project IDs and raw bodies are
// never logged. Step [7] additionally runs the production parser over the
// live summary response, which doubles as the issue's pre-merge acceptance
// evidence (third step).
const maxCaptureRequests = 12

var (
	captureBeijing     = captureLoadBeijing()
	captureWindowKeyRE = regexp.MustCompile(`window`)
	captureGroupKeyRE  = regexp.MustCompile(`group`)
	captureDigitRE     = regexp.MustCompile(`[0-9]`)
	// Leaf keys whose values are never printed regardless of the per-step
	// whitelist. cloudaicompanionProject additionally reports length only.
	captureSecretLeafKeys = map[string]bool{
		"token": true, "access_token": true, "accesstoken": true,
		"refresh_token": true, "refreshtoken": true,
		"id_token": true, "idtoken": true,
		"email": true, "project": true, "projectid": true, "project_id": true,
		"cloudaicompanionproject": true,
	}
	captureAllowedHosts = map[string]bool{
		"cloudcode-pa.googleapis.com":       true,
		"daily-cloudcode-pa.googleapis.com": true,
	}
)

func captureLoadBeijing() *time.Location {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return time.FixedZone("UTC+8", 8*3600)
	}
	return loc
}

func TestAntigravityQuotaCaptureLive(t *testing.T) {
	home := livePlanQuotaHome(t)
	hosts := []string{"cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"}
	t.Logf("capture started at %s", formatCaptureInstant(time.Now()))

	// [1] agy version (full discovery line plus the semver used in headers).
	agyPath, versionErr := exec.LookPath("agy")
	versionLine := ""
	if versionErr == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		versionLine, versionErr = agent.DetectVersion(ctx, agent.Command{Path: agyPath})
		cancel()
	}
	version := antigravityCLIVersionRE.FindString(versionLine)
	t.Logf("[1] version: path=%q err=%v version_line=%q semver=%q", agyPath, versionErr, versionLine, version)

	// [2] token file candidates; use the first one that yields an access token.
	token := ""
	for _, rel := range []string{
		".gemini/antigravity-cli/antigravity-oauth-token",
		".gemini/jetski-standalone-oauth-token",
		".gemini/oauth_creds.json",
	} {
		if got := probeCaptureTokenFile(t, filepath.Join(home, rel)); token == "" && got != "" {
			token = got
		}
	}
	if token == "" {
		t.Logf("[2] no usable token file; requests will be sent without Authorization")
	} else {
		t.Logf("[2] using the first usable token file above for Authorization")
	}

	s := &captureSession{
		t: t,
		client: &http.Client{
			Timeout: 15 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		token:   token,
		version: version,
	}

	// [3] project id discovery via loadCodeAssist on both hosts.
	projects := map[string]string{}
	for _, host := range hosts {
		t.Logf("[3] loadCodeAssist on %s", host)
		_, raw, ok := s.post(host, "/v1internal:loadCodeAssist", "{}")
		if !ok {
			continue
		}
		dumpCaptureJSON(t, raw, func(key string) bool { return key == "id" })
		if pid := extractCaptureString(raw, "cloudaicompanionProject"); pid != "" {
			projects[host] = pid
		}
	}

	// [4] legacy per-model interface; kept as evidence for why it cannot
	// back the four-window view (one WTUS number per model, no window type).
	for _, host := range hosts {
		t.Logf("[4] retrieveUserQuota on %s", host)
		_, raw, ok := s.post(host, "/v1internal:retrieveUserQuota", "{}")
		if !ok {
			continue
		}
		dumpCaptureJSON(t, raw, func(key string) bool {
			return key == "modelid" || key == "tokentype" || key == "remainingfraction" || key == "resettime"
		})
	}

	// [5] pool-based summary interface; retry with the project id on failure.
	var platformBody []byte
	var platformObserved time.Time
	for _, host := range hosts {
		t.Logf("[5] retrieveUserQuotaSummary on %s", host)
		_, raw, ok := s.post(host, "/v1internal:retrieveUserQuotaSummary", "{}")
		if !ok {
			if projects[host] == "" {
				t.Logf("  no project id available for %s; skipping project retry", host)
				continue
			}
			t.Logf("[5] retrying retrieveUserQuotaSummary on %s with project id", host)
			_, raw, ok = s.post(host, "/v1internal:retrieveUserQuotaSummary", captureProjectBody(projects[host]))
			if !ok {
				continue
			}
		}
		dumpCaptureJSON(t, raw, captureSummaryAllow)
		if host == hosts[0] {
			platformBody, platformObserved = raw, time.Now()
		}
	}

	// [6] fallback per-model view of available models; same project retry.
	for _, host := range hosts {
		t.Logf("[6] fetchAvailableModels on %s", host)
		_, raw, ok := s.post(host, "/v1internal:fetchAvailableModels", "{}")
		if ok {
			dumpCaptureJSON(t, raw, captureModelsAllow)
			continue
		}
		if projects[host] == "" {
			t.Logf("  no project id available for %s; skipping project retry", host)
			continue
		}
		t.Logf("[6] retrying fetchAvailableModels on %s with project id", host)
		_, raw, ok = s.post(host, "/v1internal:fetchAvailableModels", captureProjectBody(projects[host]))
		if ok {
			dumpCaptureJSON(t, raw, captureModelsAllow)
		}
	}

	// [7] what the platform will show: run the production parser over the
	// live summary response (this is also the pre-merge acceptance the
	// issue's step 3 requires).
	if platformBody != nil {
		t.Logf("[7] parseAntigravityQuotaSummary on %s retrieveUserQuotaSummary observed %s", hosts[0], formatCaptureInstant(platformObserved))
		quota, err := parseAntigravityQuotaSummary(bytes.NewReader(platformBody), platformObserved)
		if err != nil {
			t.Logf("  parse error: %v", err)
		} else {
			t.Logf("  status=%s observed_at=%s windows=%d", quota.Status, formatCaptureInstant(time.Unix(quota.ObservedAt, 0)), len(quota.Windows))
			for _, w := range quota.Windows {
				used, minutes, resets := "<none>", "<none>", "<none>"
				if w.UsedPercent != nil {
					used = fmt.Sprintf("%.2f%%", *w.UsedPercent)
				}
				if w.WindowMinutes != nil {
					minutes = strconv.FormatInt(*w.WindowMinutes, 10)
				}
				if w.ResetsAt != nil {
					resets = formatCaptureInstant(time.Unix(*w.ResetsAt, 0))
				}
				t.Logf("  window name=%s group=%s used=%s window_minutes=%s resets_at=%s", w.Name, w.Group, used, minutes, resets)
			}
		}
	} else {
		t.Logf("[7] %s retrieveUserQuotaSummary response unavailable; cannot show the platform windows", hosts[0])
	}

	t.Logf("capture finished at %s; requests used %d/%d", formatCaptureInstant(time.Now()), s.count, maxCaptureRequests)
	if s.stopped {
		t.Logf("capture stopped early after HTTP 429")
	}
}

type captureSession struct {
	t       *testing.T
	client  *http.Client
	token   string
	version string
	count   int
	stopped bool
}

func (s *captureSession) post(host, apiPath, body string) (int, []byte, bool) {
	if !captureAllowedHosts[host] {
		s.t.Fatalf("capture host not allowed: %s", host)
	}
	if s.stopped {
		s.t.Logf("--- POST https://%s%s %s: skipped (stopped after 429)", host, apiPath, captureBodyLabel(body))
		return 0, nil, false
	}
	if s.count >= maxCaptureRequests {
		s.t.Logf("--- POST https://%s%s %s: skipped (request budget exhausted)", host, apiPath, captureBodyLabel(body))
		return 0, nil, false
	}
	if s.count > 0 {
		time.Sleep(time.Second)
	}
	s.count++
	req, err := http.NewRequest(http.MethodPost, "https://"+host+apiPath, strings.NewReader(body))
	if err != nil {
		s.t.Logf("--- POST https://%s%s: build request: %v", host, apiPath, err)
		return 0, nil, false
	}
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}
	req.Header.Set("User-Agent", "antigravity-cli/"+s.version)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		s.t.Logf("--- POST https://%s%s %s: transport error: %v", host, apiPath, captureBodyLabel(body), err)
		return 0, nil, false
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	s.t.Logf("--- POST https://%s%s %s -> HTTP %d (%d bytes captured)", host, apiPath, captureBodyLabel(body), resp.StatusCode, len(raw))
	if resp.StatusCode == http.StatusTooManyRequests {
		s.stopped = true
		s.t.Logf("  HTTP 429: stopping all further requests")
	} else if resp.StatusCode != http.StatusOK {
		logCaptureHTTPError(s.t, resp.StatusCode, raw)
	}
	return resp.StatusCode, raw, resp.StatusCode == http.StatusOK
}

func captureBodyLabel(body string) string {
	if body == "{}" {
		return "body={}"
	}
	return "body={project:<withheld>}"
}

func captureProjectBody(projectID string) string {
	encoded, err := json.Marshal(map[string]string{"project": projectID})
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

func captureSummaryAllow(key string) bool {
	switch key {
	case "bucketid", "displayname", "remainingfraction", "resettime", "description", "type", "kind", "group", "groupname":
		return true
	}
	// The window-type field name is not confirmed yet, so accept anything
	// window- or group-shaped; values there are quota metadata, not secrets.
	return captureWindowKeyRE.MatchString(key) || captureGroupKeyRE.MatchString(key)
}

func captureModelsAllow(key string) bool {
	switch key {
	case "modelid", "name", "displayname", "id", "remainingfraction", "resettime":
		return true
	}
	return false
}

// probeCaptureTokenFile reports existence, parseability, expiry and a masked
// email for one candidate token file and returns its access token, if any.
func probeCaptureTokenFile(t *testing.T, path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Logf("[2] token %s: exists=no", path)
		return ""
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Logf("[2] token %s: exists=yes access_token=no (not a JSON object)", path)
		return ""
	}
	access := captureStringField(doc, "access_token")
	expiry := captureFirstString(doc, "expiry", "expires_at", "expire_time", "expires")
	email := captureStringField(doc, "email")
	if nested, ok := doc["token"].(map[string]any); ok {
		if access == "" {
			access = captureStringField(nested, "access_token")
		}
		if expiry == "" {
			expiry = captureFirstString(nested, "expiry", "expires_at", "expire_time", "expires")
		}
		if email == "" {
			email = captureStringField(nested, "email")
		}
	}
	expiryNote, emailNote := "<none>", "<none>"
	if expiry != "" {
		expiryNote = formatCaptureTimeValue(expiry)
	}
	if email != "" {
		emailNote = maskCaptureEmail(email)
	}
	t.Logf("[2] token %s: exists=yes access_token=%s expiry=%s email=%s", path, captureYesNo(access != ""), expiryNote, emailNote)
	return access
}

// dumpCaptureJSON prints the response shape: whitelisted leaf keys show their
// value, masked keys show presence only, everything else shows its name so the
// structure and casing stay observable without leaking unknown fields.
func dumpCaptureJSON(t *testing.T, raw []byte, allow func(key string) bool) {
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Logf("  response body is not JSON: %v", err)
		return
	}
	dumpCaptureValue(t, "", doc, allow)
}

func dumpCaptureValue(t *testing.T, prefix string, node any, allow func(key string) bool) {
	switch value := node.(type) {
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			child := key
			if prefix != "" {
				child = prefix + "." + key
			}
			dumpCaptureValue(t, child, value[key], allow)
		}
	case []any:
		for i, item := range value {
			dumpCaptureValue(t, prefix+"["+strconv.Itoa(i)+"]", item, allow)
		}
	default:
		if prefix == "" {
			return
		}
		leaf := captureLeafKey(prefix)
		if captureSecretLeafKeys[leaf] {
			if leaf == "cloudaicompanionproject" {
				t.Logf("  %s: <value withheld, present=%s length=%d>", prefix, captureYesNo(node != nil), captureValueLength(node))
			} else {
				t.Logf("  %s: <value withheld>", prefix)
			}
			return
		}
		if !allow(leaf) {
			t.Logf("  %s: <name only>", prefix)
			return
		}
		if text, ok := node.(string); ok && captureIsTimeKey(leaf) {
			t.Logf("  %s = %q [%s]", prefix, text, formatCaptureTimeValue(text))
			return
		}
		if number, ok := node.(float64); ok && captureIsTimeKey(leaf) {
			t.Logf("  %s = %v [%s]", prefix, number, formatCaptureEpoch(number))
			return
		}
		t.Logf("  %s = %v", prefix, node)
	}
}

func captureLeafKey(prefix string) string {
	if i := strings.LastIndex(prefix, "."); i >= 0 {
		prefix = prefix[i+1:]
	}
	if i := strings.Index(prefix, "["); i >= 0 {
		prefix = prefix[:i]
	}
	return strings.ToLower(prefix)
}

func captureIsTimeKey(leaf string) bool {
	switch leaf {
	case "resettime", "reset_time", "resetsat", "expiry", "expires_at", "expire_time", "expires", "expiredat", "timestamp", "updatetime":
		return true
	}
	return false
}

func logCaptureHTTPError(t *testing.T, status int, raw []byte) {
	var payload struct {
		Error struct {
			Status  string `json:"status"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &payload)
	message := payload.Error.Message
	if len(message) > 120 {
		message = message[:120]
	}
	t.Logf("  http_error status=%d error.status=%s error.message=%s", status, payload.Error.Status, maskCaptureDigits(message))
}

func extractCaptureString(raw []byte, key string) string {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return ""
	}
	value, _ := doc[key].(string)
	return value
}

func captureStringField(doc map[string]any, key string) string {
	value, _ := doc[key].(string)
	return value
}

func captureFirstString(doc map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := captureStringField(doc, key); value != "" {
			return value
		}
	}
	return ""
}

func captureValueLength(node any) int {
	if text, ok := node.(string); ok {
		return len(text)
	}
	return 0
}

func captureYesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

func formatCaptureInstant(ts time.Time) string {
	return fmt.Sprintf("utc=%s bj=%s", ts.UTC().Format("2006-01-02T15:04:05Z07:00"), ts.In(captureBeijing).Format("2006-01-02 15:04:05"))
}

func formatCaptureTimeValue(raw string) string {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05"} {
		if ts, err := time.Parse(layout, raw); err == nil {
			return formatCaptureInstant(ts)
		}
	}
	return "unparsed"
}

func formatCaptureEpoch(number float64) string {
	if number > 1e12 {
		return formatCaptureInstant(time.UnixMilli(int64(number)))
	}
	return formatCaptureInstant(time.Unix(int64(number), 0))
}

func maskCaptureEmail(email string) string {
	at := strings.Index(email, "@")
	if at <= 0 {
		return "<present, shape unrecognized>"
	}
	return email[:1] + "***" + email[at:]
}

func maskCaptureDigits(text string) string {
	return captureDigitRE.ReplaceAllString(text, "#")
}
