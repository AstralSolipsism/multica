package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestWorkspaceIssueUsageAccountingAndIsolation(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	agentID := createHandlerTestAgent(t, "card usage", []byte("[]"))
	runtimeID := handlerTestRuntimeID(t)
	parent := dbfx.Issue(t, "parent usage")
	child := dbfx.Issue(t, "child usage", testutil.Cols{"parent_issue_id": parent})
	empty := dbfx.Issue(t, "no usage")
	zero := dbfx.Issue(t, "metered zero")
	foreignWS := dbfx.Workspace(t, "foreign usage", "foreign-card-usage")
	foreign := dbfx.Issue(t, "foreign usage", testutil.Cols{"workspace_id": foreignWS})
	addUsage := func(issueID, provider, model, status string, tokens int64, cost any) {
		t.Helper()
		task := dbfx.Task(t, agentID, testutil.Cols{"issue_id": issueID, "status": status, "runtime_id": runtimeID})
		dbfx.Insert(t, "task_usage", testutil.Cols{
			"task_id": task, "provider": provider, "model": model,
			"input_tokens": tokens, "output_tokens": tokens * 2,
			"cache_read_tokens": tokens * 3, "cache_write_tokens": tokens * 4,
			"cost_usd_ticks": cost,
		})
	}
	addUsage(parent, "OpenAI", "gpt-5.4", "completed", 100, int64(10_000_000_000))
	addUsage(parent, "openai", "gpt-5.4", "failed", 200, nil)
	addUsage(parent, "OPENAI", "gpt-5.4", "cancelled", 300, int64(0))
	addUsage(parent, "anthropic", "claude-opus-4-6", "running", 400, nil)
	addUsage(child, "openai", "gpt-5.4", "completed", 500, int64(20_000_000_000))
	addUsage(zero, "openai", "gpt-5.4", "completed", 0, int64(0))
	addUsage(foreign, "openai", "gpt-5.4", "completed", 999, int64(99_000_000_000))
	dbfx.Task(t, agentID, testutil.Cols{"issue_id": empty, "status": "completed", "runtime_id": runtimeID})

	var rows []IssueUsageRowResponse
	testutil.Call(t, testHandler.ListWorkspaceIssueUsage, newRequest("GET", "/api/issues/usage-summary", nil)).Want(http.StatusOK).JSON(&rows)
	byIssue := map[string][]IssueUsageRowResponse{}
	for _, row := range rows {
		byIssue[row.IssueID] = append(byIssue[row.IssueID], row)
	}
	if len(byIssue[empty]) != 0 || len(byIssue[foreign]) != 0 {
		t.Fatal("unmetered or foreign issues leaked into summary")
	}
	if len(byIssue[zero]) != 1 {
		t.Fatalf("metered zero missing: %+v", byIssue[zero])
	}
	if len(byIssue[parent]) != 2 || len(byIssue[child]) != 1 {
		t.Fatalf("wrong aggregation grain: %+v", byIssue)
	}

	// Partially priced row keeps the split fields with real values.
	for _, row := range byIssue[parent] {
		if row.Provider == "openai" {
			if row.InputTokens != 600 || row.OutputTokens != 1200 || row.CacheReadTokens != 1800 || row.CacheWriteTokens != 2400 ||
				row.CostUsdTicks == nil || *row.CostUsdTicks != 10_000_000_000 ||
				row.UncostedInputTokens == nil || *row.UncostedInputTokens != 200 ||
				row.UncostedOutputTokens == nil || *row.UncostedOutputTokens != 400 ||
				row.UncostedCacheReadTokens == nil || *row.UncostedCacheReadTokens != 600 ||
				row.UncostedCacheWriteTokens == nil || *row.UncostedCacheWriteTokens != 800 {
				t.Fatalf("priced / unpriced split (including authoritative zero): %+v", row)
			}
		}
	}

	// Fully uncosted rows omit the five cost-split fields (nil here, absent on
	// the wire) — the contract clients read as "all tokens unpriced". The
	// metered-zero row (every counter 0, cost reported as 0) is omitted too:
	// it carries no information the totals don't.
	for _, row := range append(append([]IssueUsageRowResponse{}, byIssue[parent]...), byIssue[zero]...) {
		if row.Provider != "anthropic" && row.IssueID != zero {
			continue
		}
		if row.CostUsdTicks != nil || row.UncostedInputTokens != nil || row.UncostedOutputTokens != nil ||
			row.UncostedCacheReadTokens != nil || row.UncostedCacheWriteTokens != nil {
			t.Fatalf("all-uncosted row must omit cost-split fields: %+v", row)
		}
	}

	// Pin every accounting column against the existing single-issue SQL,
	// applying the client contract (absent split ⇒ uncosted == totals).
	for _, id := range []string{parent, child, zero} {
		single, err := testHandler.Queries.GetIssueUsageSummary(context.Background(), parseUUID(id))
		if err != nil {
			t.Fatal(err)
		}
		var totals [9]int64
		for _, row := range byIssue[id] {
			uncostedIn, uncostedOut, uncostedCR, uncostedCW := row.InputTokens, row.OutputTokens, row.CacheReadTokens, row.CacheWriteTokens
			if row.UncostedInputTokens != nil {
				uncostedIn, uncostedOut, uncostedCR, uncostedCW = *row.UncostedInputTokens, *row.UncostedOutputTokens, *row.UncostedCacheReadTokens, *row.UncostedCacheWriteTokens
			}
			cost := int64(0)
			if row.CostUsdTicks != nil {
				cost = *row.CostUsdTicks
			}
			values := [9]int64{row.InputTokens, row.OutputTokens, row.CacheReadTokens, row.CacheWriteTokens, cost,
				uncostedIn, uncostedOut, uncostedCR, uncostedCW}
			for i, value := range values {
				totals[i] += value
			}
		}
		want := [9]int64{single.TotalInputTokens, single.TotalOutputTokens, single.TotalCacheReadTokens, single.TotalCacheWriteTokens,
			single.TotalCostUsdTicks, single.UncostedInputTokens, single.UncostedOutputTokens, single.UncostedCacheReadTokens, single.UncostedCacheWriteTokens}
		if totals != want {
			t.Fatalf("%s batch = %v, single = %v", id, totals, want)
		}
	}

	// Wire check: omitted means absent from the JSON object, not null.
	var raw []map[string]json.RawMessage
	testutil.Call(t, testHandler.ListWorkspaceIssueUsage, newRequest("GET", "/api/issues/usage-summary", nil)).Want(http.StatusOK).JSON(&raw)
	omitted, present := 0, 0
	for _, obj := range raw {
		if _, ok := obj["cost_usd_ticks"]; ok {
			present++
		} else {
			omitted++
		}
	}
	if omitted != 2 || present != 2 {
		t.Fatalf("cost-split omission: want 2 omitted / 2 present, got %d / %d", omitted, present)
	}

	req := newRequest("GET", "/api/issues/usage-summary", nil)
	req.Header.Set("X-Workspace-ID", foreignWS)
	testutil.Call(t, testHandler.ListWorkspaceIssueUsage, req).Want(http.StatusNotFound)
}

func TestWorkspaceIssueUsageEmptyWorkspace(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ws := dbfx.Workspace(t, "empty usage", "empty-card-usage")
	dbfx.Member(t, ws, testUserID, "owner")
	req := newRequest("GET", "/api/issues/usage-summary", nil)
	req.Header.Set("X-Workspace-ID", ws)
	var rows []IssueUsageRowResponse
	testutil.Call(t, testHandler.ListWorkspaceIssueUsage, req).Want(http.StatusOK).JSON(&rows)
	if rows == nil || len(rows) != 0 {
		t.Fatalf("want [], got %#v", rows)
	}
}
