package main

// Keep fork migration registration separate from the upstream index catalog.
// SQL files (including 9009_labrastro_wakeup_conversation_provenance, which has
// no concurrent index) are discovered automatically by full stem.
// Both maps are needed: the runner uses hooks, and the migration audit checks
// the catalog against every concurrent CREATE INDEX statement.
func init() {
	for version, index := range map[string]string{
		"453_labrastro_message_route_identity_index":                "uq_labrastro_message_route_identity",
		"453_project_file_id_index":                                 "idx_project_file_id",
		"454_labrastro_message_delivery_dedup_index":                "uq_labrastro_message_delivery_dedup",
		"454_project_file_path_index":                               "idx_project_file_path",
		"455_labrastro_message_delivery_queue_index":                "idx_labrastro_message_delivery_queue",
		"455_project_file_version_id_index":                         "idx_project_file_version_id",
		"456_labrastro_message_delivery_listing_index":              "idx_labrastro_message_delivery_listing",
		"456_project_file_version_revision_index":                   "idx_project_file_version_revision",
		"457_labrastro_message_receipt_shard_index":                 "uq_labrastro_message_receipt_shard",
		"457_project_file_operation_id_index":                       "idx_project_file_operation_id",
		"458_labrastro_message_receipt_external_index":              "uq_labrastro_message_receipt_external",
		"458_project_file_operation_scope_index":                    "idx_project_file_operation_scope",
		"459_project_file_candidate_id_index":                       "idx_project_file_candidate_id",
		"460_labrastro_message_approved_target_active_index":        "uq_labrastro_message_approved_target_active",
		"460_project_file_candidate_list_index":                     "idx_project_file_candidate_list",
		"461_project_file_upload_id_index":                          "idx_project_file_upload_id",
		"462_project_file_upload_operation_index":                   "idx_project_file_upload_operation",
		"464_issue_dependency_audit_id_index":                       "idx_issue_dependency_audit_id",
		"465_issue_dependency_audit_workspace_index":                "idx_issue_dependency_audit_workspace",
		"466_issue_dependency_blocked_by_index":                     "idx_issue_dependency_blocked_by",
		"468_labrastro_message_route_source_identity_index":         "uq_labrastro_message_route_source_identity",
		"468_task_dependency_request_index":                         "idx_task_dependency_request",
		"469_labrastro_message_delivery_source_index":               "idx_labrastro_message_delivery_source",
		"470_labrastro_message_approved_target_source_active_index": "uq_labrastro_message_approved_target_source_active",
		"473_labrastro_message_project_approval_index":              "uq_labrastro_message_approved_target_project_active",
		"475_labrastro_message_feedback_identity_index":             "uq_labrastro_message_feedback_identity",
		"476_labrastro_message_feedback_pending_index":              "idx_labrastro_message_feedback_pending",
		"477_labrastro_message_feedback_comment_index":              "idx_labrastro_message_feedback_comment",
		"9002_labrastro_skill_folder_id_index":                      "idx_labrastro_skill_folder_id",
		"9003_labrastro_skill_package_id_index":                     "idx_labrastro_skill_package_id",
		"9004_labrastro_skill_package_source_index":                 "idx_labrastro_skill_package_source",
		"9005_labrastro_skill_placement_skill_index":                "idx_labrastro_skill_placement_skill",
		"9006_labrastro_skill_placement_source_index":               "idx_labrastro_skill_placement_source",
		"9007_labrastro_skill_folder_source_index":                  "idx_labrastro_skill_folder_source",
		"9008_labrastro_skill_folder_sibling_index":                 "idx_labrastro_skill_folder_sibling",
		"9010_labrastro_message_delivery_run_index":                 "idx_labrastro_message_delivery_run",
		"9011_labrastro_message_delivery_sending_index":             "idx_labrastro_message_delivery_sending",
		"9012_labrastro_message_inbox_scan_index":                   "idx_labrastro_message_inbox_scan",
		"9013_labrastro_message_activity_scan_index":                "idx_labrastro_message_activity_scan",
		"9014_labrastro_message_comment_scan_index":                 "idx_labrastro_message_comment_scan",
	} {
		concurrentIndexCleanups[version] = index
		preMigrationHooks[version] = cleanupInvalidConcurrentIndexHook(index)
	}
	for version, index := range map[string]string{
		"472_labrastro_message_drop_preview_approval_index": "uq_labrastro_message_approved_target_source_active",
	} {
		concurrentDownIndexCleanups[version] = index
		preRollbackHooks[version] = cleanupInvalidConcurrentIndexHook(index)
	}
}
