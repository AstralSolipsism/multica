# F15 文件清单

基线、范围和结论见 `ol-1281-media-audit.md`。这 62 个文件均在冻结的 upstream/main diff 中；行数是整个文件差异，尤其共享文件不代表 F15 独占代码量。支持链另读 LocalStorage/S3Storage、agent stream scanner、普通 skill/附件组件与缓存事件，但不计入新增功能文件。

| 文件 | + / − | 核查结论 |
| --- | ---: | --- |
| `docs/media-jobs.md` | 266 / 0 | 协议、调用者/宿主分离、原生适配器及验证契约。 |
| `server/cmd/migrate/labrastro_migrations.go` | 94 / 0 | 3 个索引的恢复注册；整个文件还包含其他 fork 迁移。 |
| `server/cmd/multica/cmd_media.go` | 188 / 0 | 参数、上传前校验、35min context、JSON/表格回执。 |
| `server/cmd/multica/cmd_media_test.go` | 120 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/cmd/multica/main.go` | 10 / 5 | 注册 media 命令。 |
| `server/cmd/server/router.go` | 86 / 3 | 挂载 3 个 job CRUD、3 个 attempt 文件/状态、2 个 daemon endpoint；复用中间件。 |
| `server/internal/cli/media.go` | 128 / 0 | multipart/file streaming，1s 调用者 wait，显式 out 原子替换。 |
| `server/internal/daemon/agents_refresh.go` | 10 / 8 | CLI 版本不变时也传播媒体 capability 变化。 |
| `server/internal/daemon/config.go` | 82 / 0 | 默认启用原生发现；测试/嵌入 executor 注入。 |
| `server/internal/daemon/daemon.go` | 385 / 59 | 注册 capability、启动/回收 worker、探测与注册快照。 |
| `server/internal/daemon/media.go` | 390 / 0 | 3s worker/status、父 deadline、单次生成与文件重试分离、临时目录回收。 |
| `server/internal/daemon/media/antigravity.go` | 57 / 0 | 原生探测、参考图/提示词、已有 model/duration 拒绝。 |
| `server/internal/daemon/media/codex.go` | 65 / 0 | 原生探测、参考图/提示词、已有 model/duration 拒绝。 |
| `server/internal/daemon/media/codex_test.go` | 26 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/internal/daemon/media/executor.go` | 32 / 0 | 最小执行边界与限额/请求错误类型。 |
| `server/internal/daemon/media_antigravity_test.go` | 251 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/internal/daemon/media_cli_integration_test.go` | 297 / 0 | DB/HTTP/伪 CLI 集成回归，覆盖调用者与宿主边界。 |
| `server/internal/daemon/media_integration_test.go` | 278 / 0 | DB/HTTP/伪 CLI 集成回归，覆盖调用者与宿主边界。 |
| `server/internal/daemon/media_native_test.go` | 312 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/internal/daemon/media_test.go` | 200 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/internal/handler/daemon.go` | 130 / 31 | 每运行时独立媒体能力注册，拒绝其他 provider/退休 tag。 |
| `server/internal/handler/daemon_rpc.go` | 21 / 3 | media.claim/result 复用 HTTP handler，64 KiB body 和连接 runtime scope。 |
| `server/internal/handler/file.go` | 12 / 8 | 普通上传去除全文件 ReadAll，复用流式存储及 reader 尺寸识别。 |
| `server/internal/handler/file_test.go` | 106 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/internal/handler/file_upload_limits.go` | 20 / 9 | media=1 的 1 GiB 上限、1 MiB multipart 文件内存阈值。 |
| `server/internal/handler/media.go` | 342 / 0 | 权限、创建/读/取消/领取/回执；读取放大、空队列候选开销。 |
| `server/internal/handler/media_capabilities.go` | 24 / 0 | 注册能力按运行时 provider 过滤和去重。 |
| `server/internal/handler/media_file.go` | 231 / 0 | attempt JWT、撤权检查、流式传输、幂等附件落库。 |
| `server/internal/handler/media_review_test.go` | 224 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/internal/handler/media_test.go` | 221 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/internal/handler/preset_skills.go` | 67 / 0 | 仅创建工作区时插入普通 skill，不在读取路径 ensure。 |
| `server/internal/handler/preset_skills/image-studio/SKILL.md` | 90 / 0 | 显式 provider、无 model、现有附件复用及回执交付；无强制绑定。 |
| `server/internal/handler/preset_skills_test.go` | 181 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/internal/handler/workspace.go` | 31 / 1 | 创建事务 seed，删除事务清理 media_job。 |
| `server/internal/handler/workspace_delete_manifest_test.go` | 27 / 1 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/internal/imagemetadata/dimensions.go` | 58 / 32 | reader 方式读取图片元数据，降低普通上传内存峰值。 |
| `server/internal/imagemetadata/dimensions_test.go` | 120 / 1 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/internal/migrations/media_job_test.go` | 58 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/internal/service/media.go` | 105 / 0 | 共享权限先于 quota，冷却和分组配额；应用层 O(R) 选择。 |
| `server/internal/service/media_test.go` | 143 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/internal/testutil/agyimage/fixture.go` | 139 / 0 | 伪原生 CLI 合同；默认测试不访问真实账户。 |
| `server/migrations/9035_labrastro_media_job.down.sql` | 1 / 0 | 4 个迁移之一的正/反向 SQL；索引单语句并发、无 FK，参见主报告。 |
| `server/migrations/9035_labrastro_media_job.up.sql` | 21 / 0 | 4 个迁移之一的正/反向 SQL；索引单语句并发、无 FK，参见主报告。 |
| `server/migrations/9036_labrastro_media_job_identity_index.down.sql` | 1 / 0 | 4 个迁移之一的正/反向 SQL；索引单语句并发、无 FK，参见主报告。 |
| `server/migrations/9036_labrastro_media_job_identity_index.up.sql` | 1 / 0 | 4 个迁移之一的正/反向 SQL；索引单语句并发、无 FK，参见主报告。 |
| `server/migrations/9037_labrastro_media_job_queue_index.down.sql` | 1 / 0 | 4 个迁移之一的正/反向 SQL；索引单语句并发、无 FK，参见主报告。 |
| `server/migrations/9037_labrastro_media_job_queue_index.up.sql` | 1 / 0 | 4 个迁移之一的正/反向 SQL；索引单语句并发、无 FK，参见主报告。 |
| `server/migrations/9038_labrastro_media_job_running_index.down.sql` | 1 / 0 | 4 个迁移之一的正/反向 SQL；索引单语句并发、无 FK，参见主报告。 |
| `server/migrations/9038_labrastro_media_job_running_index.up.sql` | 1 / 0 | 4 个迁移之一的正/反向 SQL；索引单语句并发、无 FK，参见主报告。 |
| `server/pkg/agent/antigravity_image.go` | 401 / 0 | 8 MiB 元数据预算、日志/transcript receipt、私有 home、路径边界。 |
| `server/pkg/agent/antigravity_image_integration_test.go` | 76 / 0 | 集成回归；原生 live tests 受显式环境开关保护，不纳入真实账户运行。 |
| `server/pkg/agent/antigravity_image_test.go` | 399 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/pkg/agent/codex_image.go` | 294 / 0 | 受限 App Server turn、真实 receipt、额度判定、进程树回收。 |
| `server/pkg/agent/codex_image_integration_test.go` | 56 / 0 | 集成回归；原生 live tests 受显式环境开关保护，不纳入真实账户运行。 |
| `server/pkg/agent/codex_image_test.go` | 240 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |
| `server/pkg/agent/testdata/antigravity-image-edit.json` | 112 / 0 | 原生 generate/edit 合同 fixture，仅供测试解析。 |
| `server/pkg/agent/testdata/antigravity-image-generate.json` | 86 / 0 | 原生 generate/edit 合同 fixture，仅供测试解析。 |
| `server/pkg/db/generated/media_job.sql.go` | 437 / 0 | sqlc 生成映射，与查询源一致。 |
| `server/pkg/db/generated/models.go` | 464 / 2 | media_job 数据模型；文件还有其他 fork 模型，不将全部行数归因于 F15。 |
| `server/pkg/db/queries/media_job.sql` | 64 / 0 | 全部查询的逐项审查见主报告。 |
| `server/pkg/protocol/media.go` | 123 / 0 | 请求/回执、1 GiB、输入 16 个、支持矩阵；model 校验缺口。 |
| `server/pkg/protocol/media_test.go` | 37 / 0 | 相邻行为回归；核对断言和默认执行边界，参见验证记录。 |

总计 62 文件，+8444 / −163 行。类别：Go/SQL = 30, docs/skill = 2, fixture JSON = 2, migration SQL = 8, test Go = 20。
