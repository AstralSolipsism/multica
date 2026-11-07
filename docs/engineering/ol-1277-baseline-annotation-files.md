# OL-1277 文件清单

口径：追踪八个 F06 实现/修复提交（`4a4e42a91`, `33fde2ced`, `b890bee2e`, `eee4bbbd9`, `2424c84b2`, `e06237ed4`, `f7c9f0700`, `3f021b57f`），过滤当前快照不存在的旧迁移名，补齐9059–9064真实迁移。对每个路径计算 `b1ea927..873ab8b4e` 的真实 Diff。包含共用工程文件，不把这些文件的全部行数归因于 F06；不包括本审视新增文件。不存在本功能独有 Daemon 文件。

共 92 个路径。

| 层 | 新增 | 修改 |
| --- | ---: | ---: |
| 迁移 SQL | 12 | 0 |
| 后端（含测试/生成） | 15 | 4 |
| CLI | 5 | 0 |
| 前端（含测试/locale） | 44 | 8 |
| 文档 | 4 | 0 |

核心上游侵入点为以下“修改”路径。API/event/query/mutation 接入遵循原有机制，service 的事务挂钩使提交后只通知一次；共享正文索引的新增参数可选。其它新增路径通过工程模块挂载，保留 Fork 文件边界。

| 路径 | 相对上游 | +行 | −行 |
| --- | --- | ---: | ---: |
| `GLOSSARY.md` | 新增 | 163 | 0 |
| `docs/engineering/labrastro-baseline-annotations.md` | 新增 | 210 | 0 |
| `docs/engineering/labrastro-engineering-api.md` | 新增 | 228 | 0 |
| `docs/engineering/labrastro-project-baseline-cli.md` | 新增 | 224 | 0 |
| `packages/core/api/index.ts` | 修改 | 73 | 0 |
| `packages/core/api/labrastro-api.ts` | 新增 | 50 | 0 |
| `packages/core/api/labrastro-baseline-annotation-api.test.ts` | 新增 | 152 | 0 |
| `packages/core/api/labrastro-baseline-annotation-api.ts` | 新增 | 159 | 0 |
| `packages/core/api/labrastro-baseline-annotation-schemas.test.ts` | 新增 | 26 | 0 |
| `packages/core/api/labrastro-baseline-annotation-schemas.ts` | 新增 | 79 | 0 |
| `packages/core/api/labrastro-engineering-api.test.ts` | 新增 | 70 | 0 |
| `packages/core/api/labrastro-engineering-api.ts` | 新增 | 76 | 0 |
| `packages/core/package.json` | 修改 | 16 | 0 |
| `packages/core/projects/baseline-annotation-draft-store.test.ts` | 新增 | 144 | 0 |
| `packages/core/projects/baseline-annotation-draft-store.ts` | 新增 | 232 | 0 |
| `packages/core/projects/baseline-annotation-mutations.test.tsx` | 新增 | 148 | 0 |
| `packages/core/projects/baseline-source-diff.test.ts` | 新增 | 155 | 0 |
| `packages/core/projects/baseline-source-diff.ts` | 新增 | 277 | 0 |
| `packages/core/projects/mutations.ts` | 修改 | 118 | 0 |
| `packages/core/projects/queries.test.ts` | 新增 | 120 | 0 |
| `packages/core/projects/queries.ts` | 修改 | 120 | 1 |
| `packages/core/realtime/use-realtime-sync-engineering.test.tsx` | 新增 | 112 | 0 |
| `packages/core/realtime/use-realtime-sync.ts` | 修改 | 180 | 21 |
| `packages/core/types/events.ts` | 修改 | 81 | 1 |
| `packages/views/issues/components/comment-annotation-selection.ts` | 修改 | 2 | 2 |
| `packages/views/locales/en/engineering.json` | 新增 | 326 | 0 |
| `packages/views/locales/es/engineering.json` | 新增 | 326 | 0 |
| `packages/views/locales/fr/engineering.json` | 新增 | 326 | 0 |
| `packages/views/locales/index.ts` | 修改 | 146 | 2 |
| `packages/views/locales/ja/engineering.json` | 新增 | 323 | 0 |
| `packages/views/locales/ko/engineering.json` | 新增 | 323 | 0 |
| `packages/views/locales/zh-Hans/engineering.json` | 新增 | 323 | 0 |
| `packages/views/locales/zh-Hant/engineering.json` | 新增 | 323 | 0 |
| `packages/views/projects/components/engineering-baseline-annotation-card.tsx` | 新增 | 227 | 0 |
| `packages/views/projects/components/engineering-baseline-annotation-model.test.ts` | 新增 | 137 | 0 |
| `packages/views/projects/components/engineering-baseline-annotation-model.ts` | 新增 | 252 | 0 |
| `packages/views/projects/components/engineering-baseline-annotations.test.tsx` | 新增 | 787 | 0 |
| `packages/views/projects/components/engineering-baseline-markdown.tsx` | 新增 | 258 | 0 |
| `packages/views/projects/components/engineering-baseline-reading-annotations.tsx` | 新增 | 134 | 0 |
| `packages/views/projects/components/engineering-baseline-reading-card.tsx` | 新增 | 99 | 0 |
| `packages/views/projects/components/engineering-baseline-reading-highlights.tsx` | 新增 | 61 | 0 |
| `packages/views/projects/components/engineering-baseline-reading-inline.tsx` | 新增 | 58 | 0 |
| `packages/views/projects/components/engineering-baseline-reading-rail.test.ts` | 新增 | 24 | 0 |
| `packages/views/projects/components/engineering-baseline-reading-rail.tsx` | 新增 | 131 | 0 |
| `packages/views/projects/components/engineering-baseline-review-bar.tsx` | 新增 | 201 | 0 |
| `packages/views/projects/components/engineering-baseline-review-dialog.tsx` | 新增 | 305 | 0 |
| `packages/views/projects/components/engineering-baseline-source-diff.tsx` | 新增 | 516 | 0 |
| `packages/views/projects/components/engineering-baseline-text-annotations.test.ts` | 新增 | 72 | 0 |
| `packages/views/projects/components/engineering-baseline-text-annotations.ts` | 新增 | 138 | 0 |
| `packages/views/projects/components/engineering-baseline-utils.test.ts` | 新增 | 262 | 0 |
| `packages/views/projects/components/engineering-baseline-utils.ts` | 新增 | 376 | 0 |
| `packages/views/projects/components/engineering-baseline.test.tsx` | 新增 | 493 | 0 |
| `packages/views/projects/components/engineering-baseline.tsx` | 新增 | 1116 | 0 |
| `packages/views/projects/components/engineering-overview.test.tsx` | 新增 | 820 | 0 |
| `packages/views/projects/components/engineering-overview.tsx` | 新增 | 489 | 0 |
| `packages/views/projects/components/use-baseline-annotation-drafts.ts` | 新增 | 82 | 0 |
| `server/cmd/migrate/labrastro_baseline_annotations_test.go` | 新增 | 106 | 0 |
| `server/cmd/migrate/labrastro_migrations.go` | 新增 | 94 | 0 |
| `server/cmd/multica/cmd_labrastro_annotation_ticket_test.go` | 新增 | 71 | 0 |
| `server/cmd/multica/cmd_labrastro_baseline_annotations.go` | 新增 | 410 | 0 |
| `server/cmd/multica/cmd_labrastro_baseline_annotations_test.go` | 新增 | 394 | 0 |
| `server/cmd/multica/cmd_labrastro_project_baseline.go` | 新增 | 897 | 0 |
| `server/cmd/multica/cmd_labrastro_project_baseline_test.go` | 新增 | 873 | 0 |
| `server/internal/engineering/annotations.go` | 新增 | 165 | 0 |
| `server/internal/engineering/annotations_test.go` | 新增 | 57 | 0 |
| `server/internal/handler/labrastro_baseline_annotations.go` | 新增 | 407 | 0 |
| `server/internal/handler/labrastro_baseline_annotations_test.go` | 新增 | 607 | 0 |
| `server/internal/handler/labrastro_baseline_reviews.go` | 新增 | 549 | 0 |
| `server/internal/handler/labrastro_baseline_ticket_test.go` | 新增 | 46 | 0 |
| `server/internal/handler/labrastro_engineering.go` | 新增 | 955 | 0 |
| `server/internal/handler/workspace_delete_manifest_test.go` | 修改 | 27 | 1 |
| `server/internal/service/issue.go` | 修改 | 50 | 2 |
| `server/internal/service/labrastro_baseline_annotations.go` | 新增 | 51 | 0 |
| `server/internal/service/task.go` | 修改 | 37 | 31 |
| `server/migrations/9059_labrastro_baseline_annotations.down.sql` | 新增 | 3 | 0 |
| `server/migrations/9059_labrastro_baseline_annotations.up.sql` | 新增 | 47 | 0 |
| `server/migrations/9060_labrastro_baseline_review_client_key_index.down.sql` | 新增 | 1 | 0 |
| `server/migrations/9060_labrastro_baseline_review_client_key_index.up.sql` | 新增 | 1 | 0 |
| `server/migrations/9061_labrastro_baseline_annotation_active_index.down.sql` | 新增 | 1 | 0 |
| `server/migrations/9061_labrastro_baseline_annotation_active_index.up.sql` | 新增 | 1 | 0 |
| `server/migrations/9062_labrastro_baseline_annotation_ordinal_index.down.sql` | 新增 | 1 | 0 |
| `server/migrations/9062_labrastro_baseline_annotation_ordinal_index.up.sql` | 新增 | 1 | 0 |
| `server/migrations/9063_labrastro_baseline_review_batch_index.down.sql` | 新增 | 1 | 0 |
| `server/migrations/9063_labrastro_baseline_review_batch_index.up.sql` | 新增 | 1 | 0 |
| `server/migrations/9064_labrastro_baseline_text_block_lines.down.sql` | 新增 | 5 | 0 |
| `server/migrations/9064_labrastro_baseline_text_block_lines.up.sql` | 新增 | 13 | 0 |
| `server/pkg/db/generated/labrastro_baseline_annotations.sql.go` | 新增 | 671 | 0 |
| `server/pkg/db/generated/labrastro_engineering.sql.go` | 新增 | 696 | 0 |
| `server/pkg/db/generated/models.go` | 修改 | 464 | 2 |
| `server/pkg/db/queries/labrastro_baseline_annotations.sql` | 新增 | 58 | 0 |
| `server/pkg/db/queries/labrastro_engineering.sql` | 新增 | 91 | 0 |
| `server/pkg/protocol/labrastro_engineering.go` | 新增 | 7 | 0 |
