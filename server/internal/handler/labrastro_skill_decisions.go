package handler

type labrastroCandidateAction string
type labrastroCandidatePermission string

const (
	labrastroCreate    labrastroCandidateAction = "create"
	labrastroRename    labrastroCandidateAction = "rename"
	labrastroUpdate    labrastroCandidateAction = "update"
	labrastroAdopt     labrastroCandidateAction = "adopt"
	labrastroOverwrite labrastroCandidateAction = "overwrite"
	labrastroSkip      labrastroCandidateAction = "skip"
	labrastroReject    labrastroCandidateAction = "reject"
	labrastroFailed    labrastroCandidateAction = "failed"

	labrastroNoPermission      labrastroCandidatePermission = "none"
	labrastroMemberPermission  labrastroCandidatePermission = "workspace_member"
	labrastroManagePermission  labrastroCandidatePermission = "creator_or_admin"
	labrastroCreatorPermission labrastroCandidatePermission = "creator_only"
)

type labrastroCandidateDecision struct {
	action     labrastroCandidateAction
	permission labrastroCandidatePermission
}

type labrastroCandidateDecisionKey struct{ state, conflict, strategy string }

// Only these state/conflict/strategy combinations can write. In particular,
// name collisions can only create a renamed skill or overwrite as its creator.
// Unknown combinations fail closed instead of falling through to an update.
var labrastroCandidateDecisions = func() map[labrastroCandidateDecisionKey]labrastroCandidateDecision {
	rules := []struct {
		state, conflict string
		strategies      []string
		action          labrastroCandidateAction
		permission      labrastroCandidatePermission
	}{
		{"new", "", []string{"skip", "rename", "overwrite"}, labrastroCreate, labrastroMemberPermission},
		{"changed", "", []string{"skip", "rename", "overwrite"}, labrastroUpdate, labrastroManagePermission},
		{"changed", "forbidden", []string{"skip", "rename", "overwrite"}, labrastroUpdate, labrastroManagePermission},
		{"adoptable", "", []string{"skip", "rename", "overwrite"}, labrastroAdopt, labrastroManagePermission},
		{"adoptable", "forbidden", []string{"skip", "rename", "overwrite"}, labrastroAdopt, labrastroManagePermission},
		{"conflict", "name_conflict", []string{"skip"}, labrastroSkip, labrastroNoPermission},
		{"conflict", "name_conflict", []string{"rename"}, labrastroRename, labrastroMemberPermission},
		{"conflict", "name_conflict", []string{"overwrite"}, labrastroOverwrite, labrastroCreatorPermission},
		{"conflict", "ambiguous_source", []string{"skip"}, labrastroSkip, labrastroNoPermission},
		{"conflict", "ambiguous_source", []string{"rename", "overwrite"}, labrastroReject, labrastroNoPermission},
		{"conflict", "already_packaged", []string{"skip"}, labrastroSkip, labrastroNoPermission},
		{"conflict", "already_packaged", []string{"rename", "overwrite"}, labrastroReject, labrastroNoPermission},
		{"failed", "", []string{"skip", "rename", "overwrite"}, labrastroFailed, labrastroNoPermission},
	}
	table := make(map[labrastroCandidateDecisionKey]labrastroCandidateDecision)
	for _, rule := range rules {
		for _, strategy := range rule.strategies {
			table[labrastroCandidateDecisionKey{rule.state, rule.conflict, strategy}] = labrastroCandidateDecision{rule.action, rule.permission}
		}
	}
	return table
}()

func labrastroDecideCandidate(c LabrastroSkillCandidate, req labrastroPackageRequest) labrastroCandidateDecision {
	decision, ok := labrastroCandidateDecisions[labrastroCandidateDecisionKey{c.State, c.Conflict, req.OnConflict}]
	if !ok {
		return labrastroCandidateDecision{labrastroReject, labrastroNoPermission}
	}
	// Default selection quietly skips unauthorized same-source changes; an
	// explicit selection reaches the locked, current permission check.
	if decision.permission == labrastroManagePermission && c.Conflict == "forbidden" && req.Skills == nil && !req.All {
		return labrastroCandidateDecision{labrastroSkip, labrastroNoPermission}
	}
	return decision
}

func (d labrastroCandidateDecision) writesTarget() bool {
	switch d.action {
	case labrastroUpdate, labrastroAdopt, labrastroOverwrite:
		return true
	default:
		return false
	}
}
