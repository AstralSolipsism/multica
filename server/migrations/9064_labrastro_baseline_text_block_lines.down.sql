ALTER TABLE project_baseline_annotation DROP CONSTRAINT IF EXISTS baseline_annotation_line_range;
ALTER TABLE project_baseline_annotation DROP CONSTRAINT IF EXISTS baseline_annotation_anchor_lines;
ALTER TABLE project_baseline_annotation ADD CONSTRAINT project_baseline_annotation_check CHECK ((anchor_kind = 'lines') = (line_start IS NOT NULL AND line_end IS NOT NULL));
ALTER TABLE project_baseline_annotation ADD CONSTRAINT project_baseline_annotation_check1 CHECK (line_start IS NULL OR (line_start >= 1 AND line_end >= line_start AND line_end - line_start < 50));
