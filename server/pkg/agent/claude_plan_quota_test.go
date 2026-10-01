package agent

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestClaudePlanQuotaWindows(t *testing.T) {
	t.Parallel()
	at := time.Unix(1800000000, 0)
	cases := []struct {
		name, body  string
		count       int
		status      string
		percentages []float64
	}{
		{"two windows including zero", `{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0,"resetsAt":1800003600},"seven_day":{"utilization":0.63,"resetsAt":1800604800}}}`, 2, "ok", []float64{0, 63}},
		{"warning is not a block", `{"status":"allowed_warning","rateLimitType":"five_hour","utilization":0.9,"resetsAt":1800003600}`, 1, "ok", []float64{90}},
		{"exhausted without a fabricated percentage", `{"status":"rejected","rateLimitType":"five_hour","resetsAt":1800003600}`, 1, "limited", []float64{-1}},
		{"legitimate overshoot", `{"status":"rejected","rateLimitType":"seven_day","utilization":1.1}`, 1, "limited", []float64{110}},
		{"no quota in API key session", `{"status":"allowed"}`, 0, "", nil},
		{"unknown window", `{"status":"allowed","rateLimitType":"future_pool","utilization":0.1}`, 0, "", nil},
		{"paid extra usage is not a subscription window", `{"status":"rejected","rateLimitType":"overage","utilization":1}`, 0, "", nil},
		{"unknown status", `{"status":"future","rateLimitType":"five_hour","utilization":0.5}`, 0, "", nil},
		{"null unified window does not mean zero", `{"status":"allowed","unifiedWindows":{"five_hour":null,"seven_day":{}}}`, 0, "", nil},
		{"malformed window does not discard its sibling", `{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":"bad"},"seven_day":{"utilization":0.2}}}`, 1, "ok", []float64{20}},
		{"negative rejected", `{"status":"allowed","rateLimitType":"five_hour","utilization":-1}`, 0, "", nil},
		{"out of bounds rejected", `{"status":"allowed","rateLimitType":"five_hour","utilization":101}`, 0, "", nil},
		{"invalid reset rejected", `{"status":"allowed","rateLimitType":"five_hour","utilization":0.5,"resetsAt":-1}`, 0, "", nil},
		{"no duplicate limiting window", `{"status":"allowed_warning","rateLimitType":"five_hour","utilization":0.9,"unifiedWindows":{"five_hour":{"utilization":0.8}}}`, 1, "ok", []float64{80}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q := parseClaudePlanQuota(json.RawMessage(tc.body), at)
			if tc.count == 0 {
				if q != nil {
					t.Fatalf("expected absent quota, got %+v", q)
				}
				return
			}
			if q == nil || len(q.Windows) != tc.count || q.Status != tc.status || q.Provider != "claude" || q.Source != "daemon" || q.ObservedAt != at.Unix() {
				t.Fatalf("quota = %+v", q)
			}
			for i, want := range tc.percentages {
				got := q.Windows[i].UsedPercent
				if want < 0 {
					if got != nil {
						t.Fatalf("fabricated usage %v", *got)
					}
					continue
				}
				if got == nil || *got < want-0.00001 || *got > want+0.00001 {
					t.Fatalf("window %d used = %v; want %v", i, got, want)
				}
			}
		})
	}
}

func TestClaudePlanQuotaModelWindowsAndReset(t *testing.T) {
	q := parseClaudePlanQuota(json.RawMessage(`{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.1,"resetsAt":1800003600},"seven_day_overage_included":{"utilization":0.3,"resetsAt":1800604800}}}`), time.Unix(1800000000, 0))
	if q == nil || len(q.Windows) != 2 || *q.Windows[0].WindowMinutes != 300 || *q.Windows[1].WindowMinutes != 10080 || q.Windows[1].Group != "claude_models" || *q.Windows[0].ResetsAt != 1800003600 {
		t.Fatalf("windows: %+v", q)
	}
	reset := parseClaudePlanQuota(json.RawMessage(`{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0,"resetsAt":1800021600}}}`), time.Unix(1800003601, 0))
	if reset == nil || *reset.Windows[0].UsedPercent != 0 || *reset.Windows[0].ResetsAt != 1800021600 {
		t.Fatalf("reset: %+v", reset)
	}
}

func TestClaudePlanQuotaDeliveredBeforeCompletion(t *testing.T) {
	event := json.RawMessage(`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.25,"resetsAt":1800003600},"seven_day":{"utilization":0.5,"resetsAt":1800604800}}}}`)
	backend := claudeUsageFixtureBackend(t, []json.RawMessage{event}, json.RawMessage(`{"type":"result","is_error":false,"result":"ok","session_id":"quota-fixture"}`), false)
	observed := make(chan *protocol.RuntimePlanQuota, 1)
	resume := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	defer close(resume)
	session, err := backend.Execute(ctx, "fixture", ExecOptions{Timeout: 5 * time.Second, OnPlanQuota: func(q *protocol.RuntimePlanQuota) {
		observed <- q
		select {
		case <-resume:
		case <-ctx.Done():
		}
	}})
	if err != nil {
		t.Fatal(err)
	}
	var q *protocol.RuntimePlanQuota
	select {
	case q = <-observed:
	case <-ctx.Done():
		t.Fatal("no streaming quota observation")
	}
	select {
	case <-session.Result:
		t.Fatal("quota delivered only after completion")
	default:
	}
	resume <- struct{}{}
	for range session.Messages {
	}
	result := <-session.Result
	if result.Status != "completed" || !reflect.DeepEqual(result.PlanQuota, q) {
		t.Fatalf("result = %+v; observed = %+v", result, q)
	}
}

func TestClaudePlanQuotaSurvivesFailedRunAndMalformedEvent(t *testing.T) {
	backend := claudeUsageFixtureBackend(t, []json.RawMessage{
		json.RawMessage(`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","utilization":1,"resetsAt":1800003600}}`),
		json.RawMessage(`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":"bad"}}}}`),
	}, nil, true)
	result := executeClaudeUsageFixture(t, backend, 0)
	if result.Status == "completed" || result.PlanQuota == nil || result.PlanQuota.Status != "limited" || *result.PlanQuota.Windows[0].UsedPercent != 100 {
		t.Fatalf("result = %+v", result)
	}
}
