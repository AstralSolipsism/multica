package daemon

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/pkg/agent"
)

func TestResolveTaskModelSelectionAdaptNeverReachesExecution(t *testing.T) {
	original := listModels
	t.Cleanup(func() { listModels = original })
	for _, discovery := range []string{"verified", "fallback", "error"} {
		for _, provider := range []string{"claude", "codex", "pi", "omp", "opencode", "deveco", "kimi", "dsh", "grok", "codebuddy", "reasonix", "hermes", "dim"} {
			t.Run(discovery+"/"+provider, func(t *testing.T) {
				listModels = func(context.Context, string, agent.Command) (agent.Catalog, error) {
					if discovery == "error" {
						return agent.Catalog{}, errors.New("discovery unavailable")
					}
					return agent.Catalog{
						Fallback: discovery == "fallback",
						Models: []agent.Model{{ID: "test/model", Thinking: &agent.ModelThinking{
							SupportedLevels: []agent.ThinkingLevel{{Value: agent.ThinkingLevelAdapt}, {Value: "high"}},
						}}},
					}, nil
				}
				var logs bytes.Buffer
				log := slog.New(slog.NewTextHandler(&logs, nil))
				for _, model := range []string{"", "test/model"} {
					// This is the selection copied into the shared agent.Config for
					// both CLI flags and ACP session configuration.
					got := resolveTaskModelSelection(context.Background(), provider, agent.Command{},
						taskModelSelection{Model: model, ThinkingLevel: agent.ThinkingLevelAdapt}, log)
					if got.ThinkingLevel != "" {
						t.Fatalf("execution received reserved mode: %+v", got)
					}
				}
				if !strings.Contains(logs.String(), "level=INFO") || !strings.Contains(logs.String(), "following CLI config") {
					t.Fatalf("missing adaptive fallback info log: %s", logs.String())
				}
			})
		}
	}
}

func TestResolveTaskModelSelectionAdaptKeepsServiceTier(t *testing.T) {
	reads := stubModelDiscovery(t, thinkingCatalogs())
	got := resolveTaskModelSelection(context.Background(), "codex", agent.Command{},
		taskModelSelection{Model: "gpt-5.6-sol", ThinkingLevel: agent.ThinkingLevelAdapt, ServiceTier: "priority"}, quietTaskLog())
	if got.ThinkingLevel != "" || got.ServiceTier != "priority" || got.Model != "gpt-5.6-sol" || reads() != 1 {
		t.Fatalf("adaptive fallback changed model/service tier: %+v, reads %d", got, reads())
	}
}
