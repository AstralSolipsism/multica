// audit_issue_dependencies inspects an explicitly authorized database snapshot.
// Mutation modes require an on-disk backup and never reinterpret blocks rows.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/issuedependency"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type backup struct {
	SchemaVersion int                         `json:"schema_version"`
	Database      string                      `json:"database"`
	Audit         issuedependency.LegacyAudit `json:"audit"`
}

func main() {
	deduplicate := flag.Bool("deduplicate", false, "remove only exact duplicate blocked_by rows after writing a durable backup")
	backupPath := flag.String("backup", "", "new backup file (required with -deduplicate; existing files are never overwritten)")
	restore := flag.String("restore", "", "restore duplicate rows from this backup, only if current relations match its normalized state")
	flag.Parse()
	if err := run(context.Background(), os.Getenv("DATABASE_URL"), *deduplicate, *backupPath, *restore); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, url string, deduplicate bool, backupPath, restore string) error {
	if url == "" {
		return errors.New("DATABASE_URL must explicitly select an authorized database snapshot")
	}
	if deduplicate && (backupPath == "" || restore != "") {
		return errors.New("-deduplicate requires -backup and cannot be combined with -restore")
	}
	if backupPath != "" && !deduplicate {
		return errors.New("-backup is only valid with -deduplicate")
	}
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return errors.New("could not connect to the selected database")
	}
	defer conn.Close(ctx)
	var database string
	if err := conn.QueryRow(ctx, "SELECT current_database()").Scan(&database); err != nil {
		return err
	}
	options := pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}
	if deduplicate || restore != "" {
		options = pgx.TxOptions{IsoLevel: pgx.ReadCommitted}
	}
	tx, err := conn.BeginTx(ctx, options)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if deduplicate || restore != "" {
		// Follow the same ordered workspace/catalog/structure locks as
		// application writes, then exclude raw legacy table writers. Operators
		// still run this on a restored snapshot or in a maintenance window.
		rows, err := tx.Query(ctx, "SELECT id::text FROM workspace ORDER BY id")
		if err != nil {
			return err
		}
		var workspaces []string
		for rows.Next() {
			var ws string
			if err := rows.Scan(&ws); err != nil {
				rows.Close()
				return err
			}
			workspaces = append(workspaces, ws)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		q := db.New(tx)
		s := service.NewDependencyService(q, nil)
		for _, ws := range workspaces {
			id, err := util.ParseUUID(ws)
			if err != nil {
				return err
			}
			if err := s.LockWrite(ctx, q, id); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, "LOCK TABLE issue_dependency IN EXCLUSIVE MODE"); err != nil {
			return err
		}
	}
	nodes, edges, err := readSnapshot(ctx, tx)
	if err != nil {
		return err
	}
	audit := issuedependency.AuditLegacy(nodes, edges)
	if restore != "" {
		data, err := os.ReadFile(restore)
		if err != nil {
			return err
		}
		var saved backup
		if err := json.Unmarshal(data, &saved); err != nil {
			return err
		}
		if saved.SchemaVersion != 1 || saved.Database != database {
			return errors.New("backup schema or database does not match")
		}
		if !reflect.DeepEqual(audit.Original, saved.Audit.Normalized) {
			return errors.New("relations changed since normalization; refusing to overwrite newer data")
		}
		present := map[string]bool{}
		for _, e := range audit.Original {
			present[e.ID] = true
		}
		for _, e := range saved.Audit.Original {
			if !present[e.ID] {
				if _, err := tx.Exec(ctx, "INSERT INTO issue_dependency (id,issue_id,depends_on_issue_id,type) VALUES ($1,$2,$3,$4)", e.ID, e.IssueID, e.DependsOnID, e.Type); err != nil {
					return fmt.Errorf("restore failed (the unique index must be rolled back first): %w", err)
				}
			}
		}
	} else if deduplicate {
		if len(audit.UnverifiedIDs) > 0 || len(audit.WorkspaceViolations) > 0 {
			return errors.New("unverified semantics or invalid structure; audit and resolve explicitly before deduplicating")
		}
		if err := writeBackup(backupPath, backup{SchemaVersion: 1, Database: database, Audit: audit}); err != nil {
			return err
		}
		for _, id := range audit.DuplicateIDs {
			if _, err := tx.Exec(ctx, "DELETE FROM issue_dependency WHERE id=$1 AND type='blocked_by'", id); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(audit)
}

func readSnapshot(ctx context.Context, tx pgx.Tx) ([]issuedependency.AuditNode, []issuedependency.Edge, error) {
	rows, err := tx.Query(ctx, "SELECT id::text,workspace_id::text,COALESCE(parent_issue_id::text,'') FROM issue ORDER BY id")
	if err != nil {
		return nil, nil, err
	}
	var nodes []issuedependency.AuditNode
	for rows.Next() {
		var n issuedependency.AuditNode
		if err := rows.Scan(&n.ID, &n.WorkspaceID, &n.ParentID); err != nil {
			rows.Close()
			return nil, nil, err
		}
		nodes = append(nodes, n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	rows, err = tx.Query(ctx, "SELECT id::text,issue_id::text,depends_on_issue_id::text,type FROM issue_dependency ORDER BY id")
	if err != nil {
		return nil, nil, err
	}
	edges := []issuedependency.Edge{}
	for rows.Next() {
		var e issuedependency.Edge
		if err := rows.Scan(&e.ID, &e.IssueID, &e.DependsOnID, &e.Type); err != nil {
			rows.Close()
			return nil, nil, err
		}
		edges = append(edges, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	sort.Slice(edges, func(i, j int) bool { return edges[i].ID < edges[j].ID })
	return nodes, edges, nil
}

func writeBackup(path string, value backup) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	if err := dir.Sync(); err != nil {
		dir.Close()
		return err
	}
	return dir.Close()
}
