ALTER TABLE project_baseline_annotation DROP CONSTRAINT IF EXISTS project_baseline_annotation_check;
ALTER TABLE project_baseline_annotation DROP CONSTRAINT IF EXISTS project_baseline_annotation_check1;
ALTER TABLE project_baseline_annotation ADD CONSTRAINT baseline_annotation_anchor_lines CHECK (
  (anchor_kind = 'lines' AND line_start IS NOT NULL AND line_end IS NOT NULL)
  OR (anchor_kind = 'text' AND ((line_start IS NULL AND line_end IS NULL) OR (line_start IS NOT NULL AND line_end IS NOT NULL)))
  OR (anchor_kind = 'section' AND line_start IS NULL AND line_end IS NULL)
);
ALTER TABLE project_baseline_annotation ADD CONSTRAINT baseline_annotation_line_range CHECK (
  line_start IS NULL OR (
    line_start >= 1 AND line_end >= line_start
    AND (anchor_kind <> 'lines' OR line_end - line_start < 50)
  )
);
