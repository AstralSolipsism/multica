package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func adaptCatalogModel(id string, isDefault bool, levels ...string) ModelEntry {
	model := ModelEntry{ID: id, Default: isDefault}
	if levels != nil {
		model.Thinking = &ModelThinking{}
		for _, value := range levels {
			model.Thinking.SupportedLevels = append(model.Thinking.SupportedLevels, ThinkingLevel{Value: value, Label: value})
		}
	}
	return model
}

func TestAgentAdaptValidation(t *testing.T) {
	type validationCase struct {
		name, provider, model, rejection string
		models                           []ModelEntry
	}
	var cases []validationCase
	for _, provider := range []string{"codex", "omp", "deveco"} {
		cases = append(cases, validationCase{name: provider + "/blank model", provider: provider, model: " 	", rejection: thinkingNeedsExplicitModelRejection(provider)})
	}
	for _, provider := range []string{"claude", "codex", "pi", "omp", "opencode", "deveco", "kimi", "dsh", "grok", "codebuddy"} {
		for _, model := range []string{"", "test/model"} {
			rejection := ""
			if model == "" && (provider == "codex" || provider == "omp" || provider == "deveco") {
				rejection = thinkingNeedsExplicitModelRejection(provider)
			}
			cases = append(cases, validationCase{name: provider + "/" + model, provider: provider, model: model, rejection: rejection})
		}
	}
	for _, provider := range []string{"antigravity", "cursor", "copilot", "qwen", "qwenpaw", "qoder", "qoderclicn", "traecli", "kiro", "openclaw", "mcode", "codearts", "zeroclaw", "unknown"} {
		for _, model := range []string{"", "test/model"} {
			cases = append(cases, validationCase{name: provider + "/" + model, provider: provider, model: model, rejection: thinkingCapabilityRejection(provider)})
		}
	}
	for _, provider := range []string{"reasonix", "hermes", "dim"} {
		for _, model := range []string{"", "test/model"} {
			cases = append(cases, validationCase{
				name: provider + "/no catalog/" + model, provider: provider, model: model,
				rejection: thinkingCapabilityUnknownRejection(provider),
			})
			for _, catalog := range []struct {
				name                                string
				models                              []ModelEntry
				defaultSupported, selectedSupported bool
			}{
				{"two candidates", []ModelEntry{adaptCatalogModel("test/model", true, "auto", "disabled", "low", "high")}, true, true},
				{"max ultra", []ModelEntry{adaptCatalogModel("test/model", true, "max", "ultra")}, true, true},
				{"one candidate after filtering", []ModelEntry{adaptCatalogModel("test/model", true, "auto", "off", "none", "disabled", "high")}, false, false},
				{"no thinking", []ModelEntry{adaptCatalogModel("test/model", true)}, false, false},
				{"other model has candidates", []ModelEntry{adaptCatalogModel("test/model", true, "high"), adaptCatalogModel("other", false, "low", "high")}, false, false},
				{"unknown model or missing default", []ModelEntry{adaptCatalogModel("other", false, "low", "high")}, false, false},
				{"default has candidates but selected model has none", []ModelEntry{adaptCatalogModel("default", true, "low", "high"), adaptCatalogModel("test/model", false)}, true, false},
				{"default has candidates but selected model is missing", []ModelEntry{adaptCatalogModel("default", true, "low", "high")}, true, false},
				{"selected model has candidates but default has none", []ModelEntry{adaptCatalogModel("default", true), adaptCatalogModel("test/model", false, "low", "high")}, false, true},
			} {
				rejection := ""
				supported := catalog.defaultSupported
				if model != "" {
					supported = catalog.selectedSupported
				}
				if !supported {
					rejection = fmt.Sprintf("thinking_level %q requires at least two reasoning effort candidates for model %q on runtime %q; choose a supported model or leave thinking_level empty to use the runtime default", "_adapt", model, provider)
				}
				cases = append(cases, validationCase{
					name: provider + "/" + catalog.name + "/" + model, provider: provider, model: model,
					models: catalog.models, rejection: rejection,
				})
			}
		}
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runtimeID := dbfx.Runtime(t, "adapt validation", testutil.Cols{"provider": tc.provider})
			h := *testHandler
			h.ModelCatalogCache = NewInMemoryModelCatalogCache()
			if tc.models != nil {
				if err := h.ModelCatalogCache.Put(context.Background(), runtimeID, tc.models, nil, true); err != nil {
					t.Fatal(err)
				}
			}
			for _, operation := range []string{"create", "update"} {
				t.Run(operation, func(t *testing.T) {
					body := map[string]any{"thinking_level": agent.ThinkingLevelAdapt, "model": tc.model}
					call := h.CreateAgent
					req := newRequest(http.MethodPost, "/api/agents", body)
					want := http.StatusCreated
					if operation == "create" {
						body["name"], body["runtime_id"], body["visibility"] = "adapt create", runtimeID, "private"
						body["max_concurrent_tasks"] = 1
						t.Cleanup(func() {
							dbfx.Exec(t, "DELETE FROM agent WHERE runtime_id=$1 AND name=$2", runtimeID, "adapt create")
						})
						req = newRequest(http.MethodPost, "/api/agents", body)
					} else {
						id := dbfx.Agent(t, "adapt update", runtimeID)
						req = withURLParam(newRequest(http.MethodPatch, "/api/agents/"+id, body), "id", id)
						call, want = h.UpdateAgent, http.StatusOK
					}
					if tc.rejection != "" {
						want = http.StatusBadRequest
					}
					var response map[string]any
					testutil.Call(t, call, req).Want(want).JSON(&response)
					if tc.rejection != "" {
						if response["error"] != tc.rejection {
							t.Fatalf("error = %v, want %q", response["error"], tc.rejection)
						}
						return
					}
					id := response["id"].(string)
					var stored string
					dbfx.QueryRow(t, "SELECT thinking_level FROM agent WHERE id=$1", id).Scan(&stored)
					if response["thinking_level"] != agent.ThinkingLevelAdapt || stored != agent.ThinkingLevelAdapt {
						t.Fatalf("adaptive mode not persisted: response=%v stored=%q", response["thinking_level"], stored)
					}
				})
			}
		})
	}
}

func TestAgentAdaptUpdateTransitions(t *testing.T) {
	for _, tc := range []struct {
		name, provider, targetProvider, model, want string
		patch                                       map[string]any
		catalog                                     bool
	}{
		{"runtime change clears", "claude", "cursor", "", "", nil, false},
		{"same provider new runtime clears", "claude", "claude", "", "", nil, false},
		{"explicit choice on new runtime", "claude", "pi", "", "_adapt", map[string]any{"thinking_level": "_adapt"}, false},
		{"runtime resubmit preserves", "claude", "", "", "_adapt", map[string]any{"runtime_id": "same"}, false},
		{"codex clear model clears", "codex", "", "test/model", "", map[string]any{"model": ""}, false},
		{"omp clear model clears", "omp", "", "test/model", "", map[string]any{"model": ""}, false},
		{"codex change model preserves", "codex", "", "test/model", "_adapt", map[string]any{"model": "other"}, false},
		{"eligible ACP model preserves", "reasonix", "", "test/model", "_adapt", map[string]any{"model": "other"}, true},
		{"ineligible ACP model clears", "reasonix", "", "test/model", "", map[string]any{"model": "unsupported"}, true},
		{"unknown ACP model clears", "dim", "", "test/model", "", map[string]any{"model": "unknown"}, true},
		{"ACP no default clears", "hermes", "", "test/model", "", map[string]any{"model": ""}, true},
		{"ACP missing catalog clears on model change", "dim", "", "test/model", "", map[string]any{"model": "other"}, false},
		{"unrelated edit preserves without catalog", "hermes", "", "test/model", "_adapt", map[string]any{"description": "new description"}, false},
		{"same model preserves without catalog", "reasonix", "", "test/model", "_adapt", map[string]any{"model": "test/model"}, false},
		{"explicit clear", "claude", "", "", "", map[string]any{"thinking_level": ""}, false},
		{"replace with native token", "reasonix", "", "test/model", "auto", map[string]any{"thinking_level": "auto"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runtimeID := dbfx.Runtime(t, "adapt transition", testutil.Cols{"provider": tc.provider})
			id := dbfx.Agent(t, "adapt transition", runtimeID, testutil.Cols{"model": tc.model, "thinking_level": "_adapt"})
			h := *testHandler
			h.ModelCatalogCache = NewInMemoryModelCatalogCache()
			if tc.catalog {
				if err := h.ModelCatalogCache.Put(context.Background(), runtimeID, []ModelEntry{
					adaptCatalogModel("test/model", false, "auto", "low", "high"),
					adaptCatalogModel("other", false, "low", "high"),
					adaptCatalogModel("unsupported", false, "auto", "high"),
				}, nil, true); err != nil {
					t.Fatal(err)
				}
			}
			patch := tc.patch
			if patch == nil {
				patch = map[string]any{}
			}
			if tc.targetProvider != "" {
				patch["runtime_id"] = dbfx.Runtime(t, "adapt target", testutil.Cols{"provider": tc.targetProvider})
			} else if patch["runtime_id"] == "same" {
				patch["runtime_id"] = runtimeID
			}
			var response AgentResponse
			testutil.Call(t, h.UpdateAgent, withURLParam(newRequest(http.MethodPatch, "/api/agents/"+id, patch), "id", id)).Want(http.StatusOK).JSON(&response)
			var stored string
			dbfx.QueryRow(t, "SELECT COALESCE(thinking_level, '') FROM agent WHERE id=$1", id).Scan(&stored)
			if response.ThinkingLevel != tc.want || stored != tc.want {
				t.Fatalf("thinking_level response=%q stored=%q, want %q", response.ThinkingLevel, stored, tc.want)
			}
		})
	}
}

func TestAgentAdaptUpdateToNonDefaultModelClears(t *testing.T) {
	for _, provider := range []string{"reasonix", "hermes", "dim"} {
		for _, model := range []string{"unsupported", "unknown"} {
			t.Run(provider+"/"+model, func(t *testing.T) {
				runtimeID := dbfx.Runtime(t, "adapt default model", testutil.Cols{"provider": provider})
				id := dbfx.Agent(t, "adapt default model", runtimeID, testutil.Cols{"thinking_level": "_adapt"})
				h := *testHandler
				h.ModelCatalogCache = NewInMemoryModelCatalogCache()
				if err := h.ModelCatalogCache.Put(context.Background(), runtimeID, []ModelEntry{
					adaptCatalogModel("default", true, "low", "high"),
					adaptCatalogModel("unsupported", false),
				}, nil, true); err != nil {
					t.Fatal(err)
				}
				var response AgentResponse
				testutil.Call(t, h.UpdateAgent, withURLParam(newRequest(http.MethodPatch, "/api/agents/"+id, map[string]any{"model": model}), "id", id)).Want(http.StatusOK).JSON(&response)
				var stored string
				dbfx.QueryRow(t, "SELECT COALESCE(thinking_level, '') FROM agent WHERE id=$1", id).Scan(&stored)
				if response.Model != model || response.ThinkingLevel != "" || stored != "" {
					t.Fatalf("non-default model borrowed default effort: model=%q thinking_level=%q stored=%q", response.Model, response.ThinkingLevel, stored)
				}
			})
		}
	}
}

func TestAgentNativeAutoUnaffected(t *testing.T) {
	for _, provider := range []string{"reasonix", "dim"} {
		t.Run(provider, func(t *testing.T) {
			runtimeID := dbfx.Runtime(t, "native auto", testutil.Cols{"provider": provider})
			h := *testHandler
			h.ModelCatalogCache = NewInMemoryModelCatalogCache()
			id := dbfx.Agent(t, "native auto", runtimeID, testutil.Cols{"thinking_level": "auto"})
			var created AgentResponse
			testutil.Call(t, h.CreateAgent, newRequest(http.MethodPost, "/api/agents", map[string]any{
				"name": "native auto create", "runtime_id": runtimeID, "visibility": "private", "max_concurrent_tasks": 1, "thinking_level": "auto",
			})).Want(http.StatusCreated).JSON(&created)
			t.Cleanup(func() { dbfx.Exec(t, "DELETE FROM agent WHERE id=$1", created.ID) })
			if created.ThinkingLevel != "auto" {
				t.Fatalf("native auto create changed to %q", created.ThinkingLevel)
			}
			for _, patch := range []map[string]any{{"description": "updated"}, {"model": "unknown"}, {"thinking_level": "auto"}, {"runtime_id": runtimeID}} {
				var response AgentResponse
				testutil.Call(t, h.UpdateAgent, withURLParam(newRequest(http.MethodPatch, "/api/agents/"+id, patch), "id", id)).Want(http.StatusOK).JSON(&response)
				if response.ThinkingLevel != "auto" {
					t.Fatalf("native auto changed to %q", response.ThinkingLevel)
				}
			}
		})
	}
}

func TestClaimAdaptiveThinkingCapability(t *testing.T) {
	for _, level := range []string{"_adapt", "auto", "high", ""} {
		t.Run(level, func(t *testing.T) {
			runtimeID := dbfx.Runtime(t, "adapt claim", testutil.Cols{
				"provider": "reasonix", "metadata": `{"capabilities":["thinking-adapt-v1"]}`,
			})
			agentID := dbfx.Agent(t, "adapt claim", runtimeID, testutil.Cols{"thinking_level": level})
			issueID := dbfx.Issue(t, "adapt claim")
			taskID := dbfx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "runtime_id": runtimeID, "status": "dispatched"})
			task, err := testHandler.Queries.GetAgentTask(context.Background(), parseUUID(taskID))
			if err != nil {
				t.Fatal(err)
			}
			rt, err := testHandler.Queries.GetAgentRuntime(context.Background(), parseUUID(runtimeID))
			if err != nil {
				t.Fatal(err)
			}
			for _, caps := range []string{"", "unrelated-v1", "thinking-adapt-v10", "unrelated-v1, " + protocol.DaemonCapabilityThinkingAdaptV1} {
				req := httptest.NewRequest(http.MethodPost, "/claim", nil)
				req.Header.Set("X-Client-Capabilities", caps)
				resp, _, _, _, _, failure := testHandler.buildClaimedTaskResponse(req, &task, rt, runtimeID, testWorkspaceID)
				if failure != nil || resp.Agent == nil {
					t.Fatalf("build claim: %+v", failure)
				}
				want := level
				if level == "_adapt" && caps != "unrelated-v1, "+protocol.DaemonCapabilityThinkingAdaptV1 {
					want = ""
				}
				if resp.Agent.ThinkingLevel != want {
					t.Fatalf("claim caps=%q level=%q, want %q", caps, resp.Agent.ThinkingLevel, want)
				}
			}
			var stored string
			dbfx.QueryRow(t, "SELECT thinking_level FROM agent WHERE id=$1", agentID).Scan(&stored)
			if stored != level {
				t.Fatalf("claim rewrote persisted thinking_level: %q, want %q", stored, level)
			}
		})
	}
}
