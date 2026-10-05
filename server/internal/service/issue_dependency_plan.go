package service

import (
	"context"
	"errors"
	"sort"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuedependency"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type relationChange struct {
	Next                    issuedependency.Model
	Added, Removed          []issuedependency.Edge
	BeforeState, AfterState string
}

func (c relationChange) changed() bool { return c.BeforeState != c.AfterState }

// planRelationChange is pure: the caller supplies IDs for candidate new edges.
// Existing canonical IDs and unrelated historical rows are always retained.
func planRelationChange(before issuedependency.Model, issue issuedependency.Issue, replacement *[]issuedependency.Edge) (relationChange, error) {
	change := relationChange{Next: before.Clone(), BeforeState: relationState(before, issue.ID)}
	change.Next.Issues[issue.ID] = issue
	if issue.ParentID != "" {
		if _, ok := change.Next.Issues[issue.ParentID]; !ok {
			return relationChange{}, dependencyError("not_found", "parent issue not found")
		}
	}
	if replacement != nil {
		requested := make(map[string]issuedependency.Edge, len(*replacement))
		for _, edge := range *replacement {
			if _, ok := change.Next.Issues[edge.DependsOnID]; !ok {
				return relationChange{}, dependencyError("not_found", "prerequisite not found")
			}
			requested[edge.DependsOnID] = edge
		}
		kept := make([]issuedependency.Edge, 0, len(before.Edges)+len(requested))
		for _, edge := range before.Edges {
			if edge.Type != "blocked_by" || edge.IssueID != issue.ID {
				kept = append(kept, edge)
				continue
			}
			if _, ok := requested[edge.DependsOnID]; ok {
				kept = append(kept, edge)
				delete(requested, edge.DependsOnID)
			} else {
				change.Removed = append(change.Removed, edge)
			}
		}
		keys := make([]string, 0, len(requested))
		for id := range requested {
			keys = append(keys, id)
		}
		sort.Strings(keys)
		for _, id := range keys {
			change.Added = append(change.Added, requested[id])
			kept = append(kept, requested[id])
		}
		change.Next.Edges = kept
	}
	change.AfterState = relationState(change.Next, issue.ID)
	return change, nil
}

// Candidate identities are allocated outside the pure planner. The planner
// reuses existing edge IDs, so a no-op replacement keeps its signed version.
func replacementDependencyEdges(id string, blockedBy *[]pgtype.UUID) *[]issuedependency.Edge {
	if blockedBy == nil {
		return nil
	}
	edges := make([]issuedependency.Edge, 0, len(*blockedBy))
	for _, endpoint := range *blockedBy {
		edges = append(edges, issuedependency.Edge{ID: util.UUIDToString(dbid.NewV7()), IssueID: id, DependsOnID: util.UUIDToString(endpoint), Type: "blocked_by"})
	}
	return &edges
}

type relationValidationScope uint8

const (
	validateNoRelations relationValidationScope = iota
	validateAffectedRelations
	validateWorkspaceRelations
)

func validationScopeFor(before, proposed issuedependency.Issue, write DependencyWrite) relationValidationScope {
	structureChanged := write.Creating || write.BlockedBy != nil || before.ParentID != proposed.ParentID
	if !structureChanged && !write.IncludeView {
		return validateNoRelations
	}
	if write.IncludeView || write.BlockedBy != nil || write.ExpectedVersion != "" {
		return validateWorkspaceRelations
	}
	return validateAffectedRelations
}

func (scope relationValidationScope) validate(before, next issuedependency.Model, id string) error {
	if scope == validateNoRelations {
		return nil
	}
	if scope == validateAffectedRelations {
		before, next = affectedDependencyModels(before, next, id, next.Issues[id].ParentID)
	}
	if err := before.Validate(); err != nil {
		return dependencyError("dependency_data_unverified", "dependency data must be audited before use")
	}
	if err := next.Validate(); err != nil {
		var violation *issuedependency.Violation
		if errors.As(err, &violation) {
			return &DependencyError{Code: violation.Code, Message: "the proposed dependency structure is invalid", Violation: violation}
		}
		return err
	}
	return nil
}

func affectedDependencyModels(before, next issuedependency.Model, seeds ...string) (issuedependency.Model, issuedependency.Model) {
	// Reparenting can join separate components or detach a subtree. Validate
	// both the old closure and every component it touches in the proposed model.
	previous := before.RelationComponent(seeds...)
	return previous, next.RelationComponent(append(previous.IDs(), seeds...)...)
}

func (s *DependencyService) persistRelationChange(ctx context.Context, q *db.Queries, issue db.Issue, change relationChange) error {
	if !change.changed() {
		return nil
	}
	if len(change.Removed) > 0 {
		id := util.UUIDToString(issue.ID)
		retained := []pgtype.UUID{}
		for _, edge := range change.Next.Edges {
			if edge.Type != "blocked_by" || edge.IssueID != id {
				continue
			}
			endpoint, err := util.ParseUUID(edge.DependsOnID)
			if err != nil {
				return err
			}
			retained = append(retained, endpoint)
		}
		if err := q.DeleteDirectIssueDependencies(ctx, db.DeleteDirectIssueDependenciesParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, RetainedIds: retained}); err != nil {
			return err
		}
	}
	for _, edge := range change.Added {
		edgeID, err := util.ParseUUID(edge.ID)
		if err != nil {
			return err
		}
		endpoint, err := util.ParseUUID(edge.DependsOnID)
		if err != nil {
			return err
		}
		if err := q.InsertIssueDependency(ctx, db.InsertIssueDependencyParams{ID: edgeID, WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, DependsOnIssueID: endpoint}); err != nil {
			return err
		}
	}
	return s.audit(ctx, q, issue.WorkspaceID, issue.ID, "write", change.BeforeState, change.AfterState)
}
