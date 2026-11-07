package handler

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type searchPlanStatement struct {
	SQL  string `json:"sql"`
	Args []any  `json:"args"`
}

type searchPlanRecorder struct {
	dbExecutor
	statements []searchPlanStatement
}

func (r *searchPlanRecorder) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	r.statements = append(r.statements, searchPlanStatement{sql, args})
	return r.dbExecutor.Query(ctx, sql, args...)
}

func (r *searchPlanRecorder) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	r.statements = append(r.statements, searchPlanStatement{sql, args})
	return r.dbExecutor.QueryRow(ctx, sql, args...)
}

// Run only against an explicitly disposable DATABASE_URL. ANALYZE is deliberate;
// this is an opt-in plan experiment, not a timing assertion in the default suite.
func TestIssueSearchPlans(t *testing.T) {
	output := os.Getenv("ISSUE_SEARCH_PLANS")
	if output == "" || os.Getenv("DATABASE_URL") == "" {
		t.Skip("set ISSUE_SEARCH_PLANS to an output JSON path and DATABASE_URL to a disposable test database")
	}
	ctx := context.Background()
	ws := dbfx.Workspace(t, "Search plans", "search-plans")
	foreignWS := dbfx.Workspace(t, "Foreign search plans", "foreign-search-plans")
	project := dbfx.Project(t, "Search plan project", testutil.Cols{"workspace_id": ws})
	fx := testutil.New(testPool, ws, testUserID)
	fx.Insert(t, "issue_status", testutil.Cols{"workspace_id": ws, "key": "verified", "name": "Verified", "category": "done", "color": "#123456"})
	// Bulk fixtures keep the experiment practical while retaining all real
	// indexes and triggers. 2,000 target issues, 4,000 foreign issues; five
	// 1 KiB comments per issue. The project selects 10%, independently of status.
	fx.Cleanup(t, "DELETE FROM issue WHERE workspace_id = ANY($1::uuid[])", []string{ws, foreignWS})
	fx.Cleanup(t, "DELETE FROM comment WHERE workspace_id = ANY($1::uuid[])", []string{ws, foreignWS})
	for index, workspace := range []string{ws, foreignWS} {
		count := 2000 * (index + 1)
		fx.Exec(t, `INSERT INTO issue (id, workspace_id, title, description, status, priority, creator_type, creator_id, number, project_id, position, updated_at)
		SELECT md5($1::text || n::text)::uuid, $2::uuid,
		 CASE WHEN n % 4 = 0 THEN 'needle title 检索' ELSE 'unrelated title' END,
		 CASE WHEN n % 4 = 1 THEN 'needle delta 描述 搜索' ELSE 'delta description 搜索' END,
		 CASE WHEN n % 10 = 0 THEN 'todo' WHEN n % 10 = 1 THEN 'verified' WHEN n % 10 = 2 THEN 'cancelled' ELSE 'done' END,
		 'none', 'member', $3::uuid, n,
		 CASE WHEN n % 100 < 10 THEN $4::uuid ELSE NULL END, n, '2026-01-01'::timestamptz + n * interval '1 second'
		FROM generate_series(1, $5::int) n`, fmt.Sprintf("f02-%d-", index), workspace, testUserID, project, count)
		fx.Exec(t, `INSERT INTO comment (id, workspace_id, issue_id, author_type, author_id, content, created_at)
		SELECT md5(i.id::text || n::text)::uuid, i.workspace_id, i.id, 'member', $2::uuid,
		 repeat('background text ', 64) || CASE WHEN n = 1 THEN 'needle 检索' WHEN n = 2 THEN 'delta 搜索' ELSE 'comment' END,
		 '2026-01-01'::timestamptz + n * interval '1 second'
		FROM issue i CROSS JOIN generate_series(1, 5) n WHERE i.workspace_id = $1::uuid`, workspace, testUserID)
	}
	fx.Exec(t, "ANALYZE issue")
	fx.Exec(t, "ANALYZE comment")
	type measurement struct {
		Name string `json:"name"`
		searchPlanStatement
		Plans      []json.RawMessage `json:"plans"`
		ResultHash string            `json:"result_hash,omitempty"`
	}
	measurements := []measurement{}
	measure := func(name string, statement searchPlanStatement, search bool) {
		t.Helper()
		m := measurement{Name: name, searchPlanStatement: statement}
		for run := 0; run < 3; run++ {
			query := "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement.SQL
			var plan json.RawMessage
			if search {
				err := runSearchQuery(ctx, testPool, query, statement.Args, func(rows pgx.Rows) error {
					if !rows.Next() {
						return fmt.Errorf("no plan")
					}
					return rows.Scan(&plan)
				})
				if err != nil {
					t.Fatalf("%s: %v", name, err)
				}
			} else if err := testPool.QueryRow(ctx, query, statement.Args...).Scan(&plan); err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			m.Plans = append(m.Plans, plan)
		}
		if search {
			rows, err := testPool.Query(ctx, statement.SQL, statement.Args...)
			if err != nil {
				t.Fatal(err)
			}
			var result []any
			for rows.Next() {
				values, err := rows.Values()
				if err != nil {
					t.Fatal(err)
				}
				// Keep only stable result semantics; workspace/project IDs vary by run.
				result = append(result, []any{values[0], values[len(values)-2], values[len(values)-1]})
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			rows.Close()
			data, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			m.ResultHash = fmt.Sprintf("%x", sha256.Sum256(data))
		}
		measurements = append(measurements, m)
	}
	for _, scoped := range []bool{false, true} {
		projectID := pgtype.UUID{}
		if scoped {
			projectID = parseUUID(project)
		}
		for _, titleDesc := range []bool{false, true} {
			for _, closed := range []bool{false, true} {
				for _, phrase := range []string{"needle", "needle delta", "检索 搜索"} {
					for _, limit := range []int{1, 20, 50} {
						for _, offset := range []int{0, 20, 5000} {
							query, args := buildSearchQuery(phrase, splitSearchTerms(phrase), 0, false, closed, []string{"done", "cancelled", "verified"}, projectID, titleDesc)
							args[3], args[len(args)-2], args[len(args)-1] = parseUUID(ws), limit+1, offset
							name := fmt.Sprintf("search/project=%t/title_desc=%t/closed=%t/q=%s/limit=%d/offset=%d", scoped, titleDesc, closed, phrase, limit, offset)
							measure(name, searchPlanStatement{query, args}, true)
						}
					}
				}
			}
		}
	}
	// Capture the real handler's list, count, enrichment and open-only SQL.
	for _, params := range []string{"", "&project_id=" + project, "&status=todo", "&project_id=" + project + "&status=todo", "&open_only=true", "&project_id=" + project + "&open_only=true", "&q=needle", "&project_id=" + project + "&q=needle", "&q=needle+delta", "&project_id=" + project + "&q=needle+delta"} {
		for _, offset := range []int{0, 20, 5000} {
			recorder := &searchPlanRecorder{dbExecutor: testPool}
			h := *testHandler
			h.DB, h.Queries = recorder, db.New(recorder)
			req := newRequest(http.MethodGet, fmt.Sprintf("/api/issues?limit=20&offset=%d%s", offset, params), nil)
			req.Header.Set("X-Workspace-ID", ws)
			testutil.Call(t, h.ListIssues, req).Want(http.StatusOK)
			for i, statement := range recorder.statements {
				name := fmt.Sprintf("list/%s/offset=%d/statement=%d", strings.ReplaceAll(params, project, "project"), offset, i)
				measure(name, statement, false)
			}
		}
	}
	data, err := json.Marshal(measurements)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %d statement measurements to %s", len(measurements), output)
}
