package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
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

	var rows []db.ListWorkspaceIssueUsageRow
	testutil.Call(t, testHandler.ListWorkspaceIssueUsage, newRequest("GET", "/api/issues/usage-summary", nil)).Want(http.StatusOK).JSON(&rows)
	byIssue := map[string][]db.ListWorkspaceIssueUsageRow{}
	for _, row := range rows {
		byIssue[uuidToString(row.IssueID)] = append(byIssue[uuidToString(row.IssueID)], row)
	}
	if len(byIssue[empty]) != 0 || len(byIssue[foreign]) != 0 {
		t.Fatal("unmetered or foreign issues leaked into summary")
	}
	if len(byIssue[zero]) != 1 || byIssue[zero][0].CostUsdTicks != 0 {
		t.Fatalf("metered zero missing: %+v", byIssue[zero])
	}
	if len(byIssue[parent]) != 2 || len(byIssue[child]) != 1 {
		t.Fatalf("wrong aggregation grain: %+v", byIssue)
	}
	for _, row := range byIssue[parent] {
		if row.Provider == "openai" {
			if row.InputTokens != 600 || row.OutputTokens != 1200 || row.CacheReadTokens != 1800 || row.CacheWriteTokens != 2400 ||
				row.CostUsdTicks != 10_000_000_000 || row.UncostedInputTokens != 200 || row.UncostedOutputTokens != 400 ||
				row.UncostedCacheReadTokens != 600 || row.UncostedCacheWriteTokens != 800 {
				t.Fatalf("priced / unpriced split (including authoritative zero): %+v", row)
			}
		}
	}
	// Pin every accounting column against the existing single-issue SQL.
	for _, id := range []string{parent, child, zero} {
		single, err := testHandler.Queries.GetIssueUsageSummary(context.Background(), parseUUID(id))
		if err != nil {
			t.Fatal(err)
		}
		var totals [9]int64
		for _, row := range byIssue[id] {
			values := [9]int64{row.InputTokens, row.OutputTokens, row.CacheReadTokens, row.CacheWriteTokens, row.CostUsdTicks,
				row.UncostedInputTokens, row.UncostedOutputTokens, row.UncostedCacheReadTokens, row.UncostedCacheWriteTokens}
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
	var rows []db.ListWorkspaceIssueUsageRow
	testutil.Call(t, testHandler.ListWorkspaceIssueUsage, req).Want(http.StatusOK).JSON(&rows)
	if rows == nil || len(rows) != 0 {
		t.Fatalf("want [], got %#v", rows)
	}
}
