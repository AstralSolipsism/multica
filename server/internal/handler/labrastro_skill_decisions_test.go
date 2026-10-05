package handler

import "testing"

func TestLabrastroCandidateDecisionTable(t *testing.T) {
	anyStrategy := []string{"skip", "rename", "overwrite"}
	for _, tc := range []struct {
		state, conflict string
		strategies      []string
		action          labrastroCandidateAction
		permission      labrastroCandidatePermission
	}{
		{"new", "", anyStrategy, labrastroCreate, labrastroMemberPermission},
		{"changed", "", anyStrategy, labrastroUpdate, labrastroManagePermission},
		{"changed", "forbidden", anyStrategy, labrastroUpdate, labrastroManagePermission},
		{"adoptable", "", anyStrategy, labrastroAdopt, labrastroManagePermission},
		{"adoptable", "forbidden", anyStrategy, labrastroAdopt, labrastroManagePermission},
		{"conflict", "name_conflict", []string{"skip"}, labrastroSkip, labrastroNoPermission},
		{"conflict", "name_conflict", []string{"rename"}, labrastroRename, labrastroMemberPermission},
		{"conflict", "name_conflict", []string{"overwrite"}, labrastroOverwrite, labrastroCreatorPermission},
		{"conflict", "ambiguous_source", []string{"skip"}, labrastroSkip, labrastroNoPermission},
		{"conflict", "ambiguous_source", []string{"rename", "overwrite"}, labrastroReject, labrastroNoPermission},
		{"conflict", "already_packaged", []string{"skip"}, labrastroSkip, labrastroNoPermission},
		{"conflict", "already_packaged", []string{"rename", "overwrite"}, labrastroReject, labrastroNoPermission},
		{"failed", "", anyStrategy, labrastroFailed, labrastroNoPermission},
	} {
		for _, strategy := range tc.strategies {
			t.Run(tc.state+"/"+tc.conflict+"/"+strategy, func(t *testing.T) {
				candidate := LabrastroSkillCandidate{State: tc.state, Conflict: tc.conflict}
				decision := labrastroDecideCandidate(candidate, labrastroPackageRequest{OnConflict: strategy, All: true})
				if decision.action != tc.action || decision.permission != tc.permission {
					t.Fatalf("documented decision: want %s/%s, got %s/%s", tc.action, tc.permission, decision.action, decision.permission)
				}
			})
		}
	}
}

func TestLabrastroForbiddenCandidateSelection(t *testing.T) {
	for _, state := range []struct {
		name   string
		action labrastroCandidateAction
	}{
		{"changed", labrastroUpdate},
		{"adoptable", labrastroAdopt},
	} {
		for _, strategy := range []string{"skip", "rename", "overwrite"} {
			for _, selection := range []struct {
				name       string
				request    labrastroPackageRequest
				action     labrastroCandidateAction
				permission labrastroCandidatePermission
			}{
				{"default", labrastroPackageRequest{}, labrastroSkip, labrastroNoPermission},
				{"all", labrastroPackageRequest{All: true}, state.action, labrastroManagePermission},
				{"path", labrastroPackageRequest{Skills: []string{"alpha"}}, state.action, labrastroManagePermission},
			} {
				t.Run(state.name+"/"+strategy+"/"+selection.name, func(t *testing.T) {
					candidate := LabrastroSkillCandidate{Path: "alpha", State: state.name, Conflict: "forbidden"}
					req := selection.request
					req.OnConflict = strategy
					decision := labrastroDecideCandidate(candidate, req)
					if decision.action != selection.action || decision.permission != selection.permission {
						t.Fatalf("selection decision: want %s/%s, got %s/%s", selection.action, selection.permission, decision.action, decision.permission)
					}
				})
			}
		}
	}
}
