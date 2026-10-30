package media

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/pkg/protocol"
	"os"
	"sync"
	"time"
)

type Instance struct {
	Profile  *Profile
	Executor Executor
}

// Slow probes run outside the heartbeat path. Snapshot reads a bounded cache.
type Registry struct {
	mu           sync.RWMutex
	refreshMu    sync.Mutex
	connectionID string
	instances    []Instance
	report       protocol.MediaExecutorReport
}

func NewRegistry(instances []Instance) *Registry {
	id := uuid.NewString()
	return &Registry{connectionID: id, instances: instances, report: protocol.MediaExecutorReport{ConnectionID: id, Executors: []protocol.MediaExecutorDescriptor{}}}
}
func (r *Registry) Snapshot() *protocol.MediaExecutorReport {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var report protocol.MediaExecutorReport
	body, _ := json.Marshal(r.report)
	_ = json.Unmarshal(body, &report)
	return &report
}
func (r *Registry) Refresh(ctx context.Context) {
	r.refreshMu.Lock()
	defer r.refreshMu.Unlock()
	out := make([]protocol.MediaExecutorDescriptor, 0, len(r.instances))
	for _, instance := range r.instances {
		if ctx.Err() != nil {
			break
		}
		p := instance.Profile
		e := protocol.MediaExecutorDescriptor{ExecutorID: p.ExecutorID, CredentialScopeID: p.CredentialScopeID, Provider: p.Provider, ResolvedProvider: p.Provider, Capability: protocol.MediaCapability(p.Provider), DescriptorVersion: protocol.MediaDescriptorVersion, MaxConcurrency: 1, Readiness: protocol.MediaUnsupported, ReasonCode: "native_contract_unverified", ObservedAt: time.Now().Unix(), QuotaRef: protocol.MediaQuotaRef{ScopeID: p.CredentialScopeID}}
		if p.Provider == "whisk" {
			e.ResolvedProvider = "flow"
		}
		lock, err := p.Lock()
		if err != nil {
			e.Readiness = protocol.MediaUnhealthy
			e.ReasonCode = "credential_lock_unavailable"
		} else {
			if instance.Executor != nil {
				probeExecutor(ctx, instance.Executor, &e)
			}
			lock.Close()
		}
		out = append(out, e)
	}
	r.mu.Lock()
	r.report = protocol.MediaExecutorReport{ConnectionID: r.connectionID, Executors: out}
	r.mu.Unlock()
}
func probeExecutor(ctx context.Context, executor Executor, e *protocol.MediaExecutorDescriptor) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	result, err := executor.Probe(ctx)
	if err != nil {
		e.Readiness = protocol.MediaUnhealthy
		e.ReasonCode = "probe_failed"
		return
	}
	d := executor.Describe()
	if d.Provider != e.Provider || d.ResolvedProvider != e.ResolvedProvider {
		e.ReasonCode = "provider_mismatch"
		return
	}
	e.Readiness, e.ReasonCode = result.Readiness, result.ReasonCode
	e.Models, e.InputRoles, e.OutputFormats = d.Models, d.InputRoles, d.OutputFormats
	e.MaxConcurrency = d.MaxConcurrency
	e.QuotaRef.Windows = d.QuotaWindows
	if quota, err := executor.ObserveQuota(ctx); err == nil {
		e.PlanQuota = quota
	}
	report := &protocol.MediaExecutorReport{ConnectionID: uuid.NewString(), Executors: []protocol.MediaExecutorDescriptor{*e}}
	if protocol.ValidateMediaExecutorReport(report, time.Now()) != nil {
		e.Readiness, e.ReasonCode, e.PlanQuota = protocol.MediaUnsupported, "invalid_native_descriptor", nil
		e.Models, e.InputRoles, e.OutputFormats, e.QuotaRef.Windows = nil, nil, nil, nil
		e.MaxConcurrency = 1
	}
}

// Directory presence is never proof of a usable model or subscription. Native
// factories are installed only after host-level invocation and auth validation.
func Discover(root, home, profile string) (*Registry, error) {
	var instances []Instance
	for _, provider := range []string{"codex", "agy", "flow", "whisk"} {
		p, err := OpenProfile(root, home, profile, provider, false)
		if os.IsNotExist(err) || err == ErrContractUnverified {
			continue
		}
		if err != nil {
			return nil, err
		}
		instances = append(instances, Instance{Profile: p})
	}
	r := NewRegistry(instances)
	r.Refresh(context.Background())
	return r, nil
}
