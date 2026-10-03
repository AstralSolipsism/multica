package main

// Keep fork migration registration separate from the upstream index catalog.
// Both maps are needed: the runner uses hooks, and the migration audit checks
// the catalog against every concurrent CREATE INDEX statement.
func init() {
	for version, index := range map[string]string{
		"9002_labrastro_skill_folder_id_index":        "idx_labrastro_skill_folder_id",
		"9003_labrastro_skill_package_id_index":       "idx_labrastro_skill_package_id",
		"9004_labrastro_skill_package_source_index":   "idx_labrastro_skill_package_source",
		"9005_labrastro_skill_placement_skill_index":  "idx_labrastro_skill_placement_skill",
		"9006_labrastro_skill_placement_source_index": "idx_labrastro_skill_placement_source",
		"9007_labrastro_skill_folder_source_index":    "idx_labrastro_skill_folder_source",
		"9008_labrastro_skill_folder_sibling_index":   "idx_labrastro_skill_folder_sibling",
	} {
		concurrentIndexCleanups[version] = index
		preMigrationHooks[version] = cleanupInvalidConcurrentIndexHook(index)
	}
}
