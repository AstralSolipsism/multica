package metrics_test

import (
	"testing"

	"github.com/multica-ai/multica/server/internal/metrics"
)

func TestRuntimePlanQuotaDropLabelsAreBounded(t *testing.T) {
	m := metrics.NewBusinessMetrics()
	for _, provider := range []string{"antigravity", "kimi", "zenmux", "codex", "claude", "custom-a", "custom-b"} {
		m.RecordRuntimePlanQuotaDropped(provider)
	}
	family := metrics.GatherForTest(t, m)["multica_runtime_plan_quota_dropped_total"]
	if family == nil || len(family.GetMetric()) != 6 {
		t.Fatalf("unexpected series: %v", family)
	}
	for _, sample := range family.GetMetric() {
		if len(sample.Label) != 1 || sample.Label[0].GetName() != "provider" {
			t.Fatalf("unsafe labels: %v", sample.Label)
		}
		want := float64(1)
		if labelPair(sample, "provider") == "other" {
			want = 2
		}
		if sample.GetCounter().GetValue() != want {
			t.Fatalf("count: %v", sample)
		}
	}
	var disabled *metrics.BusinessMetrics
	disabled.RecordRuntimePlanQuotaDropped("codex")
}
