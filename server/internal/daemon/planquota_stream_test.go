package daemon

import (
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestPlanQuotaOlderRunCannotReplaceNewerObservation(t *testing.T) {
	d := newQuotaLoopTestDaemon()
	newest := &protocol.RuntimePlanQuota{Provider: "claude", ObservedAt: 200, Status: "ok"}
	d.recordRuntimePlanQuota("rt-claude", newest)
	d.recordRuntimePlanQuota("rt-claude", &protocol.RuntimePlanQuota{Provider: "claude", ObservedAt: 100, Status: "limited"})
	got, _ := d.planQuotaCache.Load("rt-claude")
	if got.(planQuotaCacheEntry).quota != newest {
		t.Fatal("older task completion replaced the live observation")
	}
}

func TestPlanQuotaInvalidObservationCannotReplaceCache(t *testing.T) {
	d := newQuotaLoopTestDaemon()
	good := &protocol.RuntimePlanQuota{Provider: "codex", ObservedAt: 100, Status: "ok"}
	d.recordRuntimePlanQuota("rt-codex", good)
	invalid := &protocol.RuntimePlanQuota{Provider: "codex", ObservedAt: 200, Windows: []protocol.RuntimePlanQuotaWindow{{}}}
	d.recordRuntimePlanQuota("rt-codex", invalid)
	got, _ := d.planQuotaCache.Load("rt-codex")
	if got.(planQuotaCacheEntry).quota != good {
		t.Fatal("invalid observation replaced the last valid quota")
	}
	if invalid.Status != "" {
		t.Fatal("validation mutated the caller's snapshot")
	}
}

func TestPlanQuotaConcurrentObservationsKeepNewest(t *testing.T) {
	d := newQuotaLoopTestDaemon()
	var wg sync.WaitGroup
	for i := int64(1); i <= 100; i++ {
		wg.Add(1)
		go func(at int64) {
			defer wg.Done()
			d.recordRuntimePlanQuota("rt-claude", &protocol.RuntimePlanQuota{Provider: "claude", ObservedAt: at, Status: "ok"})
		}(i)
	}
	wg.Wait()
	got, _ := d.planQuotaCache.Load("rt-claude")
	if got.(planQuotaCacheEntry).quota.ObservedAt != 100 {
		t.Fatal("newest concurrent observation lost")
	}
}
