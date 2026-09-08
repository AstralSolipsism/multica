package issuedependency

import "sort"

type AuditNode struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	ParentID    string `json:"parent_issue_id"`
}

type LegacyAudit struct {
	Total               int               `json:"total"`
	ByType              map[string]int    `json:"by_type"`
	DuplicateIDs        []string          `json:"duplicate_ids"`
	UnverifiedIDs       []string          `json:"unverified_ids"`
	WorkspaceViolations map[string]string `json:"workspace_violations"`
	Original            []Edge            `json:"original"`
	Normalized          []Edge            `json:"normalized"`
}

// AuditLegacy only proposes removing exact duplicate canonical edges. It never
// guesses what a historical blocks row meant, nor discards anomalous rows.
func AuditLegacy(nodes []AuditNode, edges []Edge) LegacyAudit {
	r := LegacyAudit{Total: len(edges), ByType: map[string]int{}, DuplicateIDs: []string{}, UnverifiedIDs: []string{}, WorkspaceViolations: map[string]string{}, Original: append([]Edge{}, edges...), Normalized: []Edge{}}
	sort.Slice(r.Original, func(i, j int) bool { return r.Original[i].ID < r.Original[j].ID })
	byID := map[string]AuditNode{}
	models := map[string]Model{}
	for _, n := range nodes {
		byID[n.ID] = n
		m, ok := models[n.WorkspaceID]
		if !ok {
			m = Model{Issues: map[string]Issue{}}
		}
		m.Issues[n.ID] = Issue{ID: n.ID, ParentID: n.ParentID}
		models[n.WorkspaceID] = m
	}
	seen := map[[2]string]bool{}
	for _, e := range r.Original {
		r.ByType[e.Type]++
		a, aOK := byID[e.IssueID]
		b, bOK := byID[e.DependsOnID]
		if !aOK || !bOK || a.WorkspaceID != b.WorkspaceID || e.IssueID == e.DependsOnID || (e.Type != "blocked_by" && e.Type != "related") {
			r.UnverifiedIDs = append(r.UnverifiedIDs, e.ID)
		}
		key := [2]string{e.IssueID, e.DependsOnID}
		if e.Type == "blocked_by" && seen[key] {
			r.DuplicateIDs = append(r.DuplicateIDs, e.ID)
			continue
		}
		if e.Type == "blocked_by" {
			seen[key] = true
		}
		r.Normalized = append(r.Normalized, e)
		if aOK {
			m := models[a.WorkspaceID]
			m.Edges = append(m.Edges, e)
			models[a.WorkspaceID] = m
		}
	}
	for ws, m := range models {
		if err := m.Validate(); err != nil {
			r.WorkspaceViolations[ws] = err.Error()
		}
	}
	return r
}
