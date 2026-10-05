package migrations

import (
	"fmt"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// These full stems shipped with duplicate numbers. Renaming them would replay
// applied DDL. Do not extend this inventory to excuse a new collision; new fork
// migrations use 9001+. Even the pre-129 upstream history is frozen explicitly.
var releasedDuplicateMigrationStems = map[int][]string{
	20:  {"020_issue_number", "020_task_session"},
	26:  {"026_comment_reactions", "026_task_messages"},
	29:  {"029_attachment", "029_daemon_token", "029_drop_daemon_pairing"},
	32:  {"032_drop_agent_triggers", "032_issue_search_index", "032_runtime_owner", "032_task_usage"},
	33:  {"033_chat", "033_comment_search_index"},
	35:  {"035_project_priority", "035_task_queue_issue_id_index"},
	40:  {"040_agent_custom_env", "040_chat_unread_since"},
	41:  {"041_agent_custom_args", "041_workspace_invitation"},
	43:  {"043_audit_reserved_slugs", "043_fix_orphaned_autopilot_runs"},
	46:  {"046_agent_mcp_config", "046_agent_unique_name", "046_drop_runtime_usage"},
	50:  {"050_add_onboarded_at_to_users", "050_agent_model", "050_issue_first_executed_at"},
	60:  {"060_add_user_language", "060_agent_description_length", "060_chat_session_runtime_id", "060_issue_origin_quick_create"},
	65:  {"065_backfill_onboarded_at", "065_project_resources"},
	69:  {"069_comment_resolved_at", "069_drop_task_last_heartbeat"},
	79:  {"079_autopilot_run_skipped_status", "079_backfill_api_invalid_request", "079_github_integration"},
	83:  {"083_attachment_chat_columns", "083_runtime_visibility"},
	84:  {"084_squad", "084_task_usage_dashboard_rollup"},
	91:  {"091_autopilot_webhook_triggers", "091_issue_start_date", "091_pr_ci_conflict"},
	95:  {"095_agent_thinking_level", "095_backfill_starter_content_state"},
	96:  {"096_autopilot_squad_assignee", "096_pending_check_suite", "096_user_profile_description"},
	98:  {"098_contact_sales_inquiries", "098_user_onboarding_runtime_choice"},
	109: {"109_agent_task_waiting_local_directory", "109_drop_agent_skills_local", "109_issue_pull_request_close_intent", "109_lark_integration"},
	111: {"111_issue_origin_lark_chat", "111_workspace_avatar"},
	112: {"112_issue_dates_to_date", "112_lark_installation_bot_union_id"},
	113: {"113_lark_inbound_dedup_per_installation", "113_sys_cron_executions"},
	120: {"120_autopilot_subscriber", "120_comment_source_task_id", "120_github_pending_installation", "120_runtime_profile"},
	122: {"122_lark_chat_session_binding_thread_reply", "122_task_handoff_note"},
	124: {"124_autopilot_run_planned_at", "124_channel_generalization", "124_task_prepare_lease"},
	127: {"127_issue_pull_request_reference_only", "127_task_squad_id", "127_user_composio_connection"},
	128: {"128_agent_task_queue_runtime_mcp_overlay", "128_autopilot_collaborator", "128_comment_routing_escalation"},
	451: {"451_agent_runtime_plan_quota", "451_agent_task_comment_thread"},
	452: {"452_agent_task_pending_thread_unique", "452_labrastro_message_tables", "452_project_file"},
	453: {"453_drop_pending_issue_agent_unique", "453_labrastro_message_route_identity_index", "453_project_file_id_index"},
	454: {"454_drop_comment_content_bigm_index", "454_labrastro_message_delivery_dedup_index", "454_project_file_path_index"},
	455: {"455_drop_comment_content_trgm_index", "455_labrastro_message_delivery_queue_index", "455_project_file_version_id_index"},
	456: {"456_cancel_comment_assignee_fallbacks", "456_labrastro_message_delivery_listing_index", "456_project_file_version_revision_index"},
	457: {"457_labrastro_message_receipt_shard_index", "457_project_file_operation_id_index", "457_task_message_output_truncated"},
	458: {"458_agent_task_cancellation_actor", "458_labrastro_message_receipt_external_index", "458_project_file_operation_scope_index"},
	459: {"459_chat_message_assistant_task_index", "459_labrastro_message_approved_target", "459_project_file_candidate_id_index"},
	460: {"460_agent_task_queue_autopilot_run_created_at_index", "460_labrastro_message_approved_target_active_index", "460_project_file_candidate_list_index"},
	461: {"461_channel_trigger_snapshot", "461_labrastro_message_scan_cursor", "461_project_file_upload_id_index"},
	462: {"462_delete_reference_only_pr_links", "462_project_file_upload_operation_index"},
	463: {"463_drop_issue_description_bigm_index", "463_issue_dependency_audit", "463_labrastro_message_repair_state"},
	464: {"464_drop_issue_description_trgm_index", "464_issue_dependency_audit_id_index"},
	465: {"465_agent_task_queue_chat_with_session_index", "465_issue_dependency_audit_workspace_index"},
	466: {"466_activity_log_member_assignee_frequency_index", "466_issue_dependency_blocked_by_index"},
	467: {"467_autopilot_trigger_creator_from_autopilot", "467_labrastro_message_sources", "467_task_dependency_admission"},
	468: {"468_drop_reference_only_column", "468_labrastro_message_route_source_identity_index", "468_task_dependency_request_index"},
	469: {"469_issue_status_lifecycle_categories", "469_labrastro_message_delivery_source_index"},
	470: {"470_issue_status_icon", "470_labrastro_message_approved_target_source_active_index"},
	471: {"471_comment_deleted_at", "471_labrastro_message_source_scope"},
	472: {"472_agent_task_queue_chat_session_index", "472_labrastro_message_drop_preview_approval_index"},
	473: {"473_drop_agent_task_queue_chat_with_session_index", "473_labrastro_message_project_approval_index"},
	474: {"474_dingtalk_bot_identity_workspace_index", "474_labrastro_message_feedback"},
	475: {"475_issue_status_key_not_reserved", "475_labrastro_message_feedback_identity_index"},
	476: {"476_labrastro_message_feedback_pending_index", "476_reserve_triage_status_key"},
	477: {"477_issue_effective_status_triage", "477_labrastro_message_feedback_comment_index"},
	478: {"478_issue_status_category_expand", "478_labrastro_feedback_retirement"},
	551: {"551_channel_conversation_root", "551_pr_merge_status"},
}

func TestMigrationNumericPrefixesAreUnique(t *testing.T) {
	for _, conflict := range migrationNumericPrefixConflicts(migrationFilesForLint(t, "*.up.sql")) {
		t.Error(conflict)
	}
}

func TestMigrationNumericPrefixWhitelistRejectsNewCollisions(t *testing.T) {
	released := migrationFilesForLint(t, "*.up.sql")
	// Keep the synthetic number free as later real fork migrations are added.
	nextNumber := 9001
	for _, file := range released {
		stem, _, _ := splitMigrationFilename(filepath.Base(file))
		prefix, _, _ := strings.Cut(stem, "_")
		if number, err := strconv.Atoi(prefix); err == nil && number >= nextNumber {
			nextNumber = number + 1
		}
	}
	newStem := fmt.Sprintf("%d_new_fork_migration", nextNumber)
	for _, stem := range []string{
		"020_new_collision", // Early upstream history is not an open range either.
		"470_x",
		"551_third_migration",
		fmt.Sprintf("%d_second_migration", nextNumber),
	} {
		for _, reverse := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/reverse=%t", stem, reverse), func(t *testing.T) {
				files := append(slices.Clone(released), newStem+".up.sql", stem+".up.sql")
				if reverse {
					slices.Reverse(files)
				}
				conflicts := migrationNumericPrefixConflicts(files)
				if len(conflicts) == 0 || !strings.Contains(conflicts[0], stem) {
					t.Fatalf("new duplicate %s must fail lint, got %v", stem, conflicts)
				}
			})
		}
	}
	files := append(slices.Clone(released), newStem+".up.sql")
	slices.Reverse(files)
	if conflicts := migrationNumericPrefixConflicts(files); len(conflicts) != 0 {
		t.Fatalf("released stems and a new unique number must pass in any order: %v", conflicts)
	}
}

func migrationNumericPrefixConflicts(files []string) []string {
	var conflicts []string
	stemByNumber := make(map[int]string)
	for _, file := range files {
		stem, _, ok := splitMigrationFilename(filepath.Base(file))
		if !ok {
			continue
		}
		prefix, _, ok := strings.Cut(stem, "_")
		if !ok {
			continue
		}
		number, err := strconv.Atoi(prefix)
		if err != nil {
			continue
		}
		if previous, exists := stemByNumber[number]; exists {
			allowed := releasedDuplicateMigrationStems[number]
			if !slices.Contains(allowed, previous) || !slices.Contains(allowed, stem) || previous == stem {
				conflicts = append(conflicts, fmt.Sprintf("migrations %s and %s share numeric prefix %s", previous, stem, prefix))
			}
		} else {
			stemByNumber[number] = stem
		}
	}
	return conflicts
}

func TestMigrationFilesHaveMatchingDirections(t *testing.T) {
	files := migrationFilesForLint(t, "*.sql")

	directionsByStem := make(map[string]map[string]bool)
	for _, file := range files {
		stem, direction, ok := splitMigrationFilename(filepath.Base(file))
		if !ok {
			continue
		}
		if directionsByStem[stem] == nil {
			directionsByStem[stem] = make(map[string]bool)
		}
		directionsByStem[stem][direction] = true
	}

	for stem, directions := range directionsByStem {
		if !directions["up"] || !directions["down"] {
			t.Errorf("migration %s must have both .up.sql and .down.sql files", stem)
		}
	}
}

func migrationFilesForLint(t *testing.T, pattern string) []string {
	t.Helper()

	dir := realMigrationsDir(t)
	files, err := filepath.Glob(filepath.Join(dir, pattern))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatalf("no migration files matched %s in %s", pattern, dir)
	}
	sort.Strings(files)
	return files
}

func realMigrationsDir(t *testing.T) string {
	t.Helper()

	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration lint test path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(self), "..", "..", "migrations"))
}

func splitMigrationFilename(name string) (stem, direction string, ok bool) {
	for _, candidateDirection := range []string{"up", "down"} {
		suffix := fmt.Sprintf(".%s.sql", candidateDirection)
		if strings.HasSuffix(name, suffix) {
			return strings.TrimSuffix(name, suffix), candidateDirection, true
		}
	}
	return "", "", false
}
