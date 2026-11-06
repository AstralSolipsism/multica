# v0.8.0 / v0.8.1 分阶段同步记录

最新状态见本文末尾 Stage 5（OL-1252，收口）；下列 Stage 2 记录保留当时交接状态。

## Stage 2 — OL-1250

本记录交付共享分支 `sync/v0.8.0-ol-1234` 的后端、数据库、桌面与构建基座。按 OL-1250 的 Stage 1 交接评论，55 个前端冲突路径在 M 中暂取上游/删除；该分支尚不能作为前端完整升级结果发布。Stage 3 在同一分支继续融合，不创建主线 PR。

## 提交关系

- 第一父（开工时远端 main）：`bd317ee3ebeb0464eb2a184788d2a1ada2dff4eb`。
- 第二父（v0.8.0 tag）：`9b1ab4f9eed9153a94719596eb8a728d2770f065`。
- 合并提交 M：`537956e4cbfed74eded07349234680ac5824ba0f`；精确两父，未 rebase。
- #9914：`ab3dc194865369decdd55c8653bb6a678920c2b1`，来源 `bc1be25041e3f4cd66b2059e0332bc5e0ae22cd8`。
- #9906：`f6eea3cd996b1286161dc7ef183452914709977a`，来源 `72f9a391bf00dae0ce7e35428e9a673b5e97984f`。
- 语义修复提交：`98a178e74d793c49bccdd8e89636ac5a0c114b79`。
- 交接评论给出的两个完整来源 SHA 拼写有误；上面是经上游仓库提交主题及短 SHA 核实的对象，两个提交均使用 `cherry-pick -x`。

## 根因与改动

- 评论 pending 合并与未覆盖评论重挂仅按 issue/agent/thread 匹配，会重写外部会话的根和授权人。两条 SQL 现在同时匹配会话根与冻结授权人；handler 从持久化来源任务解析根，并重新检查当前授权。子查询与 UPDATE 外层都设条件，防止并发更新越过边界。失败重试保留冻结 delivery，撤权后 claim 拒绝；父单上下文限制在同一工作区。
- 持久化 Default 工作流漏掉旧自定义状态。新增 `9054_labrastro_default_workflow_keep_in_use_statuses`，回填未被命名工作流包含、或仍由 Default 范围 issue 使用的 active 自定义状态，按 position/key 放在固定尾部之前。幂等；down 不撤销用户状态。命名工作流专属、归档、仅已删除 issue 使用的状态不扩入；实际 issue 表使用硬删除，无 deleted_at 字段。
- Runtime 同时保留配额、机器统计、thinking adapt 及上游 1..50 并发上限；注册不覆写并发上限。sqlc 全量再生成。Lark 安装配置同时保留 conversation、binding generation 与 first receipt；指纹排除候选聊天及 receipt 时间。
- 守护进程将退出取消映射为 runtime_recovery 后再记录结果；CLI 保持普通错误 64 KiB、Issue 错误 1 MiB；execenv 保留技能安装映射并适配上游工具。
- YSK 请求按目标工作区选窗口、创建缺失窗口并等待 renderer。关闭目标时先丢弃该窗口的 chat 消息再 release，换号清空全部待投递会话。渲染端跨工作区走窗口/导航适配层。目标窗口复用标签时保留完整 comment hash/chat query；源窗口不清目标定位记录。
- 保留 TS7/TS6 双轨、elkjs/xyflow/vite，删除已移除 unicode-animations；保留 YSK 和测试 harness 导出。锁文件重算后冻结离线检查通过。Next.js 16.4.5、sharp 0.35.5，含 CLI 回调安全修复。
- 保留桌面安装图标和 Web 爪印资产；统一桌面运行图标、Docs/Mobile 图标、文档与登录字标为 Labrastro。UI 图标兼容上游 mode/shape/size，繁中覆盖层跟随当前原文，无扩大品牌豁免。

## 外部路由与请求审阅

真实路由仍为 60 allow / 448 deny / 75 separate-auth。5 条新增 unread/read/unread 与 WeCom 安装路由全部 deny；请求清单保持原字节。下表覆盖 23 条非 GET 路由，延续 Stage 1 的审阅边界。

| 方法/路由 | 请求、默认值及副作用 | 权限与验证 |
| --- | --- | --- |
| `DELETE /api/attachments/{id}` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `DELETE /api/comments/{commentId}` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `PUT /api/comments/{commentId}` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `DELETE /api/comments/{commentId}/keep-replies` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `DELETE /api/comments/{commentId}/reactions` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `POST /api/comments/{commentId}/reactions` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `DELETE /api/comments/{commentId}/resolve` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `POST /api/comments/{commentId}/resolve` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `POST /api/issues` | 请求字段不变；持久化 Default 限制新状态，9054 修复历史遗漏；保持依赖/工作流派发 | 现有外部工作流/子单权限回归；新增 Default 状态 HTTP 回归 |
| `POST /api/issues/query` | 只读查询；请求/默认值与权限不变 | 路由、请求 inventory 与既有外部策略回归 |
| `POST /api/issues/with-dependencies` | 请求字段不变；持久化 Default 限制新状态，9054 修复历史遗漏；保持依赖/工作流派发 | 现有外部工作流/子单权限回归；新增 Default 状态 HTTP 回归 |
| `PUT /api/issues/{id}` | 请求字段不变；持久化 Default 限制新状态，9054 修复历史遗漏；保持依赖/工作流派发 | 现有外部工作流/子单权限回归；新增 Default 状态 HTTP 回归 |
| `POST /api/issues/{id}/comments` | 请求不变；coalesced 根参与会话归属，合并广播实时事件；新增根/授权人匹配 | 成员↔外部、不同根/授权人拒绝；同根合并和 planned replay；冻结 grantor |
| `POST /api/issues/{id}/labels` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `DELETE /api/issues/{id}/labels/{labelId}` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `DELETE /api/issues/{id}/metadata/{key}` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `PUT /api/issues/{id}/metadata/{key}` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `DELETE /api/issues/{id}/properties/{propertyId}` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `PUT /api/issues/{id}/properties/{propertyId}` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `DELETE /api/issues/{id}/reactions` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `POST /api/issues/{id}/reactions` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |
| `PATCH /api/issues/{id}/with-dependencies` | 请求字段不变；持久化 Default 限制新状态，9054 修复历史遗漏；保持依赖/工作流派发 | 现有外部工作流/子单权限回归；新增 Default 状态 HTTP 回归 |
| `POST /api/upload-file` | 请求/默认值及写入副作用不变 | 保留冻结 grantor、工作区边界与既有外部策略回归 |

## 迁移与格式身份

新增上游 `595`–`608`、`610` 的 30 个 up/down 文件均与 tag 字节一致。Fork 的 `467_autopilot_trigger_creator_from_autopilot.up.sql` 保留不回填旧触发器主体的行为，未恢复上游 DML。9009/9028 的 capture_issue_wakeup 溯源定义均原样保留，9054 不改唤醒表/函数。

| 保留迁移 | Fork blob（基线与结果相同） | 上游 tag blob |
| --- | --- | --- |
| `467_task_dependency_admission.up.sql` | `07d13fcbc93c1d7208625723642002558223b75f` | `fork-only` |
| `467_autopilot_trigger_creator_from_autopilot.up.sql` | `9d9719921186f406855115c4a5a7e73b9c377896` | `40a3888825985738469996a1596110ae62038ac6` |
| `467_labrastro_message_sources.up.sql` | `d0410605b036868c83e39de7ad5acb7e0c054b3c` | `fork-only` |
| `9009_labrastro_wakeup_conversation_provenance.up.sql` | `d041acc20cda075e42c4d408577fd02b9e16f703` | `fork-only` |
| `9028_labrastro_wakeup_skip_handed_to_agent.up.sql` | `1ab3d16b272fe2073afd083183e4a82aa8697ab2` | `fork-only` |

新装：从空库依序运行全部迁移。升级：先运行第一父的完整迁移集（714 条，至 9053），再运行当前迁移集；补跑 15 条上游迁移和 9054。两条路径得到相同的 730 条 ledger 与 3,053 项规范化结构记录；比较列类型/默认值、约束、索引、函数、触发器、枚举、策略和视图，忽略物理列序。无 INVALID 索引，重复 up 无新增操作。测试使用任务私有 PostgreSQL 15；未安装的可选扩展按现有 runner 记录跳过。

结构记录 SHA-256：`eb33e7e3b0300e2eeaf81ad5df386a047b2a00edc88b4a28e7a49befc7e2faae`；ledger SHA-256：`e5179d2df2d83fa09b2ea2ef735da1a95509a589cab1eb9e0a72d3ea4dafc8b3`。

gofmt 豁免源更新为完整 v0.8.0 tag SHA；11 个历史文件的 blob 均与该 tag 相同，未添加 Fork 内容豁免。

## 验证

验证环境：`GOTOOLCHAIN=go1.27.3`、任务私有 PostgreSQL 15.19、Git 2.47.3、Node 24.21.0、pnpm 10.28.2。宿主 Git 2.39 不支持上游 worktree 测试的 `merge-tree --merge-base`，因此使用任务目录内的 Git；后端整套按包串行运行，仍启用 race detector。Docker 不可用，数据库由独立临时实例提供，未连接共享/生产库。

| 检查 | 结果 |
| --- | --- |
| `GOFLAGS=-p=1 bash scripts/test-go.sh --race` | regular 与 message-delivery 全部通过；完整入口未全绿，最后 agent 组有下述 4 组宿主能力失败 |
| `make build`、`go -C server vet ./...` | 通过 |
| 两次 `make sqlc` | 连续两次生成结果一致 |
| `check-gofmt.sh`、`check-gofmt.test.sh`、基线至结果 `git diff --check` | 通过；移除上游 docs 文件末尾多余空行 |
| 外部真实 router/request inventory | 通过；60 allow / 448 deny；请求清单未变 |
| 新增会话合并、重试、父单、Default 迁移与 HTTP 回归（`-race`） | 通过；包括外部会话完整认证路由 |
| 新装/存量升级及重复迁移 | schema/ledger 一致，无无效索引 |
| Desktop `typecheck:node`、`test` | 通过；85 文件 / 999 Vitest + 12 CLI 打包脚本测试 |
| 安全回调 Web / shared login 测试 | 通过；35 + 40 项 |
| `pnpm test:brand` | 通过；源文件/分发守卫及 15 项覆盖层测试 |
| Mobile `lint`、`test` | 通过；41 文件 / 301 Vitest + iOS 脚本测试 |
| 冻结离线锁文件、CI 范围测试 | 通过；`pnpm install --frozen-lockfile --lockfile-only --offline --ignore-scripts`、63 项 CI 范围测试 |
| Core 全套、Desktop renderer / Mobile 类型检查 | 尚未通过；见 Stage 3 接力范围 |

宿主为 `5.15.0-157-generic`。最后的 agent 组中，`TestCaptureCursorBackgroundLateDescendant`、`TestCaptureCursorBackgroundProcessReapsLeaderExitedGroup`、`TestCaptureCursorBackgroundSurvivesRootExitDuringCapture`、`TestCursorBackgroundLifecycle` 需要 pidfd 进程组信号能力。独立探针在自己的子进程上确认 `pidfd_send_signal(signal=0, flags=0)` 成功，`flags=4` 返回 `EINVAL`。该生产文件在 Fork 基线、上游 tag 和结果树的 blob 均为 `ee65aa58c4ad4cc31ed3d5d5f42fb563240fa374`，属于已存在的宿主限制；保持拒绝不安全回退的设计，没有修改测试或生产保护来绕过它。

仅排除上述 4 个完整测试名后，`go test -race -p 2 -parallel 2 -skip '^(TestCaptureCursorBackgroundLateDescendant|TestCaptureCursorBackgroundProcessReapsLeaderExitedGroup|TestCaptureCursorBackgroundSurvivesRootExitDuringCapture|TestCursorBackgroundLifecycle)$' ./pkg/agent/...` 通过（79.771s），其余测试未被跳过。

完整 agent 组仍需在支持该能力的宿主复核，不能把排除后的结果表述为整套通过。测试产生的进程已按确切 PID 清理，未触碰工作区 daemon。

构建结果仅作为本地后端验证；未创建主线 PR，未部署或发布。

## Stage 3 接力

完整路径表见 [55 个路径及处理状态](upstream-sync-20261106-stage3.tsv)。M 中 47 个文本文件逐个验证与 M^2 blob 一致，8 个 modify/delete 路径保持删除。UI 图标在后续品牌修复中恢复了爪印，接力时保留该 API/品牌组合。

继续融合时保留 M 之后的安全补丁，尤其认证回调拒绝静默回退的行为及 Next.js 锁定版本。

三方对照：M^1 = Fork 基线；共同祖先 `f05a525ac8e82f5e9169ad078e44f166fad6d5c8`；M^2 = tag。核心 API、runtime/lark 类型、DAG keys/view store/视图序列化及 shared views 的 Fork 功能仍由 Stage 3 恢复。不要只以占位文件能解析作为完成标准。

已执行的 core 全套：217 文件通过、44 失败；3,030 测试通过、453 失败、50 个未捕获错误。示例为 `issueKeys.graphAll`、依赖接口、Fork runtime/lark 类型因占位文件缺失。Desktop renderer/mobile 类型检查亦受这些共享接口缺失阻断；已检查日志，无本次桌面主进程、图标/字标文件新增类型错误。完整前端构建、Web/桌面 E2E、原生桌面打包安装及移动模拟器验证留给后续阶段，不能宣称本分支已通过整体发布门禁。


## Stage 4 — OL-1255：v0.8.1 增量融合

本阶段以 Stage 3 已交付的 `2623fc06e11e08356ad399af8856164f4d2035c6` 为第一父，正式 tag `v0.8.1` / `b1ea927def6490c43bedff537b6f4ed9a47fa828` 为第二父执行 `--no-ff` 合并，合并提交为 `ed6c70ab547823a27a85b77fa17710aa7c288290`，未 rebase，也未重复 cherry-pick #9914 / #9906。交付仍推往 `AstralSolipsism/multica` 的 `sync/v0.8.0-ol-1234`，不创建独立 PR；Stage 5 承接保留 E2E、跨家族双审和发布门禁。

### 迁移身份与命名纠正

OL-1255 描述中的 `000001_000NNN_…` 并非本分支规范。实际从 `001_init` 到 `9054_…` 使用完整文件 stem 作为 ledger 身份；`server/internal/migrations/migrations.go` 按文件名排序，sqlc 同样依赖迁移顺序。给 611–616 添加该前缀会排到 `001_init` 之前，导致新装库先 ALTER 尚不存在的表。因此保留实际 `NNN_name` 命名，只存在下表这六组，不制造第二套身份，也不重命名已发布的 467/9009/9028/9054。此处纠正的是任务说明对仓库现状的描述。

所有新迁移的 up/down 均逐字节等于 v0.8.1，613 的索引清理 hook 保留。连续两次 `make sqlc` 的完整生成结果一致，技能包 placement/folder SQL 与版本表、workspace 删除顺序共存。

| 迁移（各含 up/down） | 用途 | up Git blob |
| --- | --- | --- |
| `611_user_whats_new_seen_version` | What's New 已读版本 | `bb827ae5678655f05bb9b9f2f954d7390174058f` |
| `612_skill_version` | 技能版本历史 | `54f481b105a3465fd2f1a8349aee7d5a9cbc3b01` |
| `613_skill_version_index` | 技能版本索引 | `6706dda2d91e41dad8e7946eda184ce4cca8c1a5` |
| `614_project_creator` | 项目创建者身份 | `3a6eaa030850f477538667d0aac0365d829bf7ee` |
| `615_attachment_image_dimensions` | 附件图片尺寸 | `9966ea42dbc98678986de6cfb7e2e694262d65f4` |
| `616_member_pinned` | 用户工作区置顶 | `8615b71e77fa56baab1016a4406a90641a95548a` |

全量比较双方共有的迁移文件后，唯一沿用的上游覆写仍是 `467_autopilot_trigger_creator_from_autopilot`：up 的 Fork/upstream blob 为 `9d9719921186f406855115c4a5a7e73b9c377896` / `40a3888825985738469996a1596110ae62038ac6`，down 为 `ee35bfe58e35fccdeee0e32d4ae077fac5136c15` / `1c32fd2368ae0ae78e2bf5dc8886b780cbed69eb`。继续不从 autopilot 创建者推断旧 trigger 主体；down 只恢复注释。已执行的安装不重跑，无证据的触发器仍拒绝派发，延续 OL-110 T14。9009 / 9028 原样保留 `capture_issue_wakeup` 溯源；9054 up blob `8d36d6c02f7d18f0b31b141600d26fe23571c85a` 原样保留 Default 历史状态修复。新增迁移未重定义 capture 函数，无需追加补偿迁移。

私有 PostgreSQL 15 UTF-8 库验证：新装从空库执行全部 736 条；升级先执行第一父的 730 条，再补跑 611–616（其余跳过）。两条路径的列类型/默认值、表、约束、索引有效性、函数、触发器、枚举、视图、策略和序列共 3,076 项规范化记录完全相同，忽略物理列序；ledger 736 条相同，无 INVALID 索引，重复 up 全部 skip。可选扩展遵循 runner 原有缺省处理。

- schema SHA-256：`de69c3256637eeb1400579ef70eb42be19c6cbd867d5e8eddff45e6356f6ce5e`
- ledger SHA-256：`7740aa78d64157e1671877a3315a134abeb4ae15537dbf1b07934b0d3f8ef270`
- 比对 SQL：`upstream-sync-20261106-stage4-schema.sql`；对两库分别执行 `psql -XAtq -f`，排序 ledger 后比较字节。

### 外部会话边界

实际路由清单位于 `server/cmd/server/testdata/labrastro-external-routes.tsv`，本阶段为 **60 allow / 457 deny / 76 separate-auth**。外部白名单及请求字段清单未扩大；10 条新增路由如下。

| 方法 / 路由 | 策略 |
| --- | --- |
| `POST /api/inbox/issues/{issueId}/read` | deny |
| `GET /api/issue-views/{id}/issues` | deny |
| `GET /api/issues/subscribed` | deny |
| `POST /api/me/whats-new/seen` | deny |
| `GET /api/plugin-bridge/v1/tasks/{task_id}/messages` | deny |
| `GET /api/skills/{id}/versions` | deny |
| `GET /api/skills/{id}/versions/{version}` | deny |
| `POST /api/skills/{id}/versions/{version}/restore` | deny |
| `PUT /api/workspaces/{id}/pin` | deny |
| `GET /v1/tasks/{task_id}/messages` | separate-auth（plugin） |

以下对照第一父与结果树，逐项覆盖全部 23 条非 GET 白名单路由。“不变”同时指请求字段、默认值、校验、接受的 actor/workspace 及写入副作用。共同权限证据为真实 router/request inventory、middleware、handler 和 service 的外部会话回归；没有以运行时 owner 取代冻结 grantor。

| 方法 / 路由 | Handler / 依赖与请求语义 | 副作用 / 权限审阅 |
| --- | --- | --- |
| `DELETE /api/attachments/{id}` | `DeleteAttachment` 不变 | 附件归属与工作区检查不变 |
| `DELETE /api/comments/{commentId}` | `DeleteComment` 不变 | 删除/墓碑及评论主体不变 |
| `PUT /api/comments/{commentId}` | `UpdateComment` 不变 | 编辑与提及的授权校验不变 |
| `DELETE /api/comments/{commentId}/keep-replies` | `DeleteComment` 不变 | 保留回复语义不变 |
| `DELETE /api/comments/{commentId}/reactions` | `RemoveReaction` 不变 | 当前主体 reaction 删除不变 |
| `POST /api/comments/{commentId}/reactions` | `AddReaction` 不变 | 当前主体 reaction 写入不变 |
| `DELETE /api/comments/{commentId}/resolve` | `UnresolveComment` 不变 | 解除解决状态不变 |
| `POST /api/comments/{commentId}/resolve` | `ResolveComment` 不变 | 解决状态写入不变 |
| `POST /api/issues` | `CreateIssue` 请求不变；workflow step guard 抽为共用函数 | 创建/委派仍按冻结主体、调用权限和会话祖先 |
| `POST /api/issues/query` | `QueryIssues`→`ListIssues` 不变；仍为 1 MiB 字符串映射 | 只读；新增 unread/subscribed 属 table query，不扩此请求 |
| `POST /api/issues/with-dependencies` | `CreateIssueWithDependencies` 请求、依赖事务不变 | 工作流/依赖/子单派发边界保留 |
| `PUT /api/issues/{id}` | `UpdateIssue` 请求不变；`workflowStepMoved` 保持原拒绝条件 | 陈旧 workflow task 不能改变已离开的步骤；claim 文案同步 |
| `POST /api/issues/{id}/comments` | `CreateComment` 不变 | pending 合并仍匹配会话根与冻结 grantor；提及与延迟派发不变 |
| `POST /api/issues/{id}/labels` | `AttachLabel` 不变 | 同工作区标签关联不变 |
| `DELETE /api/issues/{id}/labels/{labelId}` | `DetachLabel` 不变 | 标签解除不变 |
| `DELETE /api/issues/{id}/metadata/{key}` | `DeleteIssueMetadataKey` 不变 | 元数据删除不变 |
| `PUT /api/issues/{id}/metadata/{key}` | `SetIssueMetadataKey` 不变 | 元数据写入不变 |
| `DELETE /api/issues/{id}/properties/{propertyId}` | `DeleteIssueProperty` 不变 | 属性删除不变 |
| `PUT /api/issues/{id}/properties/{propertyId}` | `SetIssueProperty` 不变 | 属性校验和写入不变 |
| `DELETE /api/issues/{id}/reactions` | `RemoveIssueReaction` 不变 | 当前主体 reaction 删除不变 |
| `POST /api/issues/{id}/reactions` | `AddIssueReaction` 不变 | 当前主体 reaction 写入不变 |
| `PATCH /api/issues/{id}/with-dependencies` | `UpdateIssueWithDependencies` 请求、依赖事务不变；共用 step guard | 依赖与工作流权限不变 |
| `POST /api/upload-file` | `UploadFile` 复用 `parseUploadForm`；默认 100 MiB、`?media=1` 的 1 GiB 上限和 1 MiB 落盘阈值保留；响应新增可选 width/height | 流式存储与归属授权保留；尺寸只读取头部并 rewind，新增大文件读取量回归 |

冻结 grantor、持久化会话根、后代、重试、唤醒、撤权及工作区/ownership/invocation 校验相关 Fork 文件和 SQL 保留。Issue/Project 的 DELETE 仍不对外部会话开放；上游新建的删除权限 helper 在取消任务/清理前检查整个集合，成员只可删除自己或自己当前拥有的 agent 创建的对象，owner/admin 可管理，agent 不继承 token 用户权限；未知历史项目创建者不获得推断权限。

### 定制交集与高价值功能

- Skills：保留文件夹树、二级技能包、ZIP 导入导出和详情侧栏，接入上游版本列表/详情/回滚及标签布局。搜索复用持久化 view store，搜索跨文件夹并保留路径提示。版本快照和 package placement 共用同一事务；覆盖导入不能提前 commit。新增回归验证 placement 失败时内容/版本都回滚，以及恢复 v1 内容后 placement 原样保留并新增 restore 版本。预览指纹只纳入成员身份/权限字段，新增的工作区 pinned_at 不再使预览失效；旧 scanner 的两套字节快照不变，权限和 membership 更换仍使指纹变化。
- Help：保留飞书 QR 和 Web 内网 `DOWNLOAD_PAGE_URL`，What's New 统一进入菜单，AppRail 不恢复独立卡片。面板保留版本亮点，移除外网 changelog/release 出口；Help 测试继续禁止 multica.ai/discord.gg。运行时空态下载也接入内部地址，云推广仍受已有关闭开关约束。
- 品牌：桌面、Web、Docs、移动图标及字标按第一父字节保留，移动图标仍为 1024×1024 RGB 无 alpha。上游生成器改为拒绝覆写独立 Fork 资产；`scripts/brand/labrastro-assets.json` 与 sync 校验冻结身份，CI 路径包含 manifest。G2 新图形组件兼容上游 API 并使用爪印。补齐西语品牌覆盖与新增繁中文档内网分发入口，未扩大品牌豁免。新增西语沿用上游翻译，Fork 尚未翻译的 1,175 个键显式回退到已品牌化的英语；与繁中的既有资源合并机制一致，单语言入口也有完整 namespace，未修改 parity 断言。
- 保留持久化 idle/tool watchdog 配置、agent thinking level、子单选择性复制父字段、工作区置顶、100 MiB 上传、聊天/运行记录虚拟滚动。修复无评论运行链接在折叠/已解决线程中的展开落点，保留 Fork 到达高亮、DAG、配额和项目工程开关。Qoder 采用上游新增的聊天附件挂载/续聊及 squad leader 支持；quick-create 附件限制仍保留。
- gofmt 清单仍为 11 个字节等同上游的原文件，来源改为完整 v0.8.1 SHA；Fork 修改全部格式化，不添加内容豁免。

### Stage 4 验证结果

首轮提审 HEAD 为 `aec6bafbfd55fdf928c1d728d613d6701f4cdb57`，代码基线为合并提交及后续 `7687c5cf2628bfbf7b95b2f5d209b2dbade9a5a5`。本节记录首轮验证，首审修复的增量验证见下节。环境为 Node 24.21.0、pnpm 10.28.2、Go 1.27.3、Git 2.47.3 和私有 PostgreSQL 15 UTF-8 测试库。测试库已在结果收齐后关闭。

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | 通过，锁文件无漂移 |
| `pnpm typecheck` | 9 个任务通过 |
| `pnpm lint` | 6 个任务通过，0 error；保留现有 warning |
| `pnpm test:brand`（亦由根 `pnpm test` 调用） | 11 项脚本测试、17 项语言品牌测试通过；资产、源文案和内网分发守卫通过 |
| 根 `VITEST_MAX_WORKERS=4 pnpm test --env-mode=loose --concurrency=1` | 7 个任务通过（4 个命中本轮已通过的本地缓存）；1,118 个 Vitest 文件、14,976 测试通过，2 项既有 skip；另有 ESLint 4 项、桌面 source-root 12 项脚本测试通过 |
| `pnpm --filter @multica/mobile test` | 44 文件、342 测试通过；`ios-run.test.sh` 通过 |
| 语言完整性、品牌覆盖与头像裁剪定向复验 | 3 文件、485 测试通过，包含最终西语 fallback 与 Fork 256px 裁剪尺寸 |
| CI scope 脚本回归 | 70 项通过 |
| `bash scripts/check-gofmt.sh` 及其自测 | 通过；11 个上游原文件仍逐字节验证 |
| 连续 `make sqlc` / `git diff --check` | 通过，生成结果无差异 / 无空白错误 |
| UTF-8 新装与升级迁移 | 两路径 schema 与 ledger 全同，736 条迁移，重复 up 无新增执行，无 INVALID 索引 |
| `GOTOOLCHAIN=go1.27.3 go -C server test -p 1 -timeout 20m ./...` | 88 个测试包通过、17 个包无测试；仅 `pkg/agent` 中下述 4 个宿主相关测试失败，因此整体退出码为 1 |
| agent 宿主兼容复验 | 仅按完整名称排除下述 4 项，`-p 1 -parallel 2` 运行其余 `./pkg/agent/...` 通过（57.417s） |

本次后端最终全量结果中，router、middleware、branding、handler、daemon、service、migration、Qoder 和图片尺寸包均通过。保留 Stage 2 已定位的宿主限制：Linux `5.15.0-157-generic` 不支持 pidfd 进程组信号 `flags=4`，返回 `EINVAL`。失败名称仍为 `TestCaptureCursorBackgroundLateDescendant`、`TestCaptureCursorBackgroundProcessReapsLeaderExitedGroup`、`TestCaptureCursorBackgroundSurvivesRootExitDuringCapture`、`TestCursorBackgroundLifecycle`。未改变生产保护，也未在源码中跳过这些测试；兼容复验只在命令行精确排除这四项，不能表述为后端全绿。Stage 5 应在支持该能力的宿主补齐这四项，再承接保留 E2E、桌面原生打包/安装及跨家族双审；本阶段未执行这些发布验收。

前端套件明细：core 278 文件 / 3,677 通过 / 1 skip，UI 12 / 454 / 1 skip，Docs 6 / 30，views 694 / 9,439，Web 43 / 375，Desktop 85 / 1,001。根脚本按仓库定义不含 mobile，故另行运行并记录移动套件。jsdom 的 canvas/navigation 未实现提示未导致测试失败。

### 首审阻断修复

- JPEG：原方向扫描对落盘文件逐字节 read/seek，且会扫描 SOF 后的填充内容。改用缓冲读取，在首个 SOFn 停止，移除循环内 seek；尺寸解码和 EXIF 扫描各限制在头部 1 MiB。超限保留未知尺寸或默认方向，不阻断原文件上传。落盘 1 / 4 / 16 MiB 填充回归均固定为读取 8 KiB、2 次 read、1 次 seek；本机单次观察为 34 / 34 / 25 微秒，测试断言只依赖 I/O 上界，不以耗时为门禁。SOF 前持续填充也分别验证两条解析路径的 1 MiB 上限，EXIF 八种方向和两种字节序仍通过。回归已在旧实现上失败，再在修复后通过。
- 简报：保留 Labrastro 品牌词，恢复上游 #9915 / `fe5fd221a` 的缺口处理要求：没有 CLI 命令或已记载的平台机制时，在结果中报告缺口；不再默认要求提及工作区负责人。issue、chat、autopilot、quick-create 四类简报均有回归断言。
- 文档：繁中 PAT 示例的 `/api/me`、`/api/issues` 改为 `https://multica.outlune.com`；文档分发守卫新增上游 API endpoint 检查，覆盖多行 Bearer 示例和本地化页面。上传台账更正为默认 100 MiB、media 1 GiB，1 MiB 是 multipart 落盘阈值。

本轮增量验证：`go test -p 2 ./internal/daemon/... ./internal/imagemetadata ./internal/branding` 的 12 个包通过（Git 2.47.3）；图片元数据包 `-race` 通过；私有 UTF-8 PostgreSQL 上 `go test ./internal/handler -run 'TestUploadFile|TestParseUploadForm' -count=1 -v` 通过，新增 2 MiB JPEG 用例同时验证尺寸、流式调用及存储字节与原文件完全相同。`pnpm test:brand` 的 12 项脚本测试和 17 项品牌测试、gofmt 守卫及自测、`git diff --check` 均通过。本轮未重跑前后端全量；上述首轮全量结果和 4 项宿主限制仍单独保留，Stage 5 的 E2E、原生打包与双审安排不变。

## Stage 5 — OL-1252：全量门禁、保留 E2E、记录归档与 PR 收口

本阶段不引入产品改动：`server/migrations` 自 Stage 4 末次验证（`8183cb4e4`）以来零差异，Stage 4 的 736 条迁移台账与 3,076 项 Schema 一致性证明继续有效，并在本阶段环境原样复验。HEAD 起点 `d07ccad86e5fed9df69a581031391103c55a5055`，含 Stage 3 终版修复 `b19c59f10436c3ead3a7f7acd7080f5546770fb3`（前端审阅修复）与 DAG 选择操作响应性修复；两处两父合并（M1 `537956e4c`、M2 `ed6c70ab5`）与 #9914/#9906 cherry-pick 均未被改写。

### Stage 3 终版补充

Stage 3 交接时前端 core 套件为 217 文件通过、44 失败（占位文件缺失所致）。`2623fc06e` 恢复共享接口后，`b19c59f10` 修复审阅发现（视图序列化、DAG keys、runtime/lark 类型），`d07ccad86` 修复 DAG 选择操作响应性，全部保留 E2E 相关 spec 转绿。最终 core 全套 278 文件 / 3,677 测试通过（见 Stage 4 验证表明细），Stage 2 记录的 44 项失败全部消除。

### 全量门禁复核

环境：`GOTOOLCHAIN=go1.27.3`（编译输出与 Stage 4 一致）、Node 24.21.0、pnpm 10.28.2、宿主 Git 2.39.5 + 任务内编译 Git 2.47.3（execenv 复验用）、任务私有 PostgreSQL 15.19（trust 认证、UTF-8）。Docker 不可用，全部数据库由独立临时实例提供。

| 检查 | 结果 |
| --- | --- |
| `bash scripts/check-gofmt.test.sh` | 通过 |
| `GOTOOLCHAIN=go1.27.3 bash scripts/check-gofmt.sh` | 通过；11 项豁免与 v0.8.1 字节比对不变 |
| `GOTOOLCHAIN=go1.27.3 go -C server test ./internal/branding/...` | 通过 |
| `GOTOOLCHAIN=go1.27.3 go -C server test ./internal/migrations -run '^TestLabrastroWakeupCaptureMigrationInventory$' -count=1` | 通过 |
| 连续两次 `make sqlc` | 零差异 |
| `node scripts/check-docs-distribution.mjs` | 通过 |
| `pnpm typecheck` | 9 任务通过 |
| `pnpm lint` | 6 任务通过，0 error |
| 根 `VITEST_MAX_WORKERS=4 pnpm test --env-mode=loose --concurrency=1` | 7 任务通过：core 278/3,677、UI 12/454、Docs 6/30、views 694/9,451、Desktop 85/1,001、Web 43/375，另 ESLint 4 项与桌面脚本测试 |
| `pnpm test:brand` | 12 项脚本测试 + 17 项语言品牌测试通过 |
| `GOTOOLCHAIN=go1.27.3 go -C server test -p 1 -timeout 25m ./...`（私有 PG，`DATABASE_URL` 直连） | 87 包通过；仅下述宿主限制组失败 |
| `pkg/agent` 仅排除 4 项 pidfd 测试后 `-p 1 -parallel 2 -count=3` | 三轮全部通过（~56s/轮） |
| `internal/daemon/execenv`（PATH 前置任务内 Git 2.47.3） | 通过（12.9s） |

宿主限制与 Stage 2/4 记录一致，未修改任何测试或生产保护来绕过：

- Linux `5.15.0-157-generic` 无 pidfd 进程组信号能力（`flags=4` 返回 `EINVAL`），`TestCaptureCursorBackgroundLateDescendant`、`TestCaptureCursorBackgroundProcessReapsLeaderExitedGroup`、`TestCaptureCursorBackgroundSurvivesRootExitDuringCapture`、`TestCursorBackgroundLifecycle` 4 项在本宿主必然失败，需具备该能力的宿主复核。
- 宿主 Git 2.39.5 缺少 `merge-tree --merge-base`，`TestPrepareLocalWorktree*` 7 项失败；PATH 前置任务内编译的 Git 2.47.3 后该包全绿。
- 首轮全量中 `TestCodexExecuteLegacyFirstTurnMessageSatisfiesProgress`、`TestCodexExecuteSemanticInactivityAllowsContinuousMessages` 因同机并行负载超时（80ms 语义不活跃预算）；单独复跑 3/3 通过，全量复跑中未再出现。

### 迁移台账与 Schema 一致性复验

复用 Stage 4 比对 SQL（`upstream-sync-20261106-stage4-schema.sql`）：

- 新装（空库 → 全部 736 条）与升级（第一父 `2623fc06e` 的 730 条 → 补跑 611–616 共 6 条）两条路径各产出 3,076 项规范化记录，逐字节一致。
- 结构 SHA-256 `de69c3256637eeb1400579ef70eb42be19c6cbd867d5e8eddff45e6356f6ce5e`，与 Stage 4 记录一致（迁移零变更的直接验证）。
- ledger 内容指纹（`md5(string_agg(version, ',' ORDER BY version))`）两库同为 `631c68867cc1b8d86f89b521c1c5902b`；两库 `pg_index` 中 INVALID 索引均为 0。
- Fork 保留迁移 `467_task_dependency_admission`、`467_labrastro_message_sources`、`9009_labrastro_wakeup_conversation_provenance`、`9028_labrastro_wakeup_skip_handed_to_agent`、`9054_labrastro_default_workflow_keep_in_use_statuses` 在两库 ledger 中均存在且只执行一次；上游 611–616 六组保持 `NNN_name` 命名。
- 外部路由清单 `server/cmd/server/testdata/labrastro-external-routes.tsv` 为 593 行 60 allow / 457 deny / 76 separate-auth，与 Stage 4 审计表一致。

### 隔离保留 E2E 实测

按 `docs/engineering/ci-gates.md` 以任务私有 PostgreSQL 15.19（端口 15432、`labrastro_e2e` 库）替代 CI 的 PostgreSQL 17 service，一次性脚本 `GOTOOLCHAIN=go1.27.3 bash scripts/test-retained-e2e.sh` 完整执行：真实 Go server 构建 + 全量迁移 + 生产 Web 构建 + Playwright 单 worker 无重试。**24/24 通过**（onboarding-smoke 11、issue-dependencies 5、dag-task-lines 2、comments 4、含退役路由 404 与内网下载页断言），HTML 报告留存于 `test-results/retained-e2e/report/`。首轮因 Playwright 缺少本仓库锁定的 chromium_headless_shell-1208 报 executable 缺失，`pnpm exec playwright install chromium` 后复跑全绿，属本机缓存问题非产品问题。

关键界面证据（一次性截图脚本 `e2e/shots/stage5-shots.spec.ts` + `playwright.stage5-shots.config.ts`，同一后端/Web 实例，6/6 通过）：`1.0` 双层侧栏 Issues 页、DAG 任务线总览（真实 blocked-by 边）、智能体文件夹树 + thinking level 属性栏（Atlas · high）、技能文件夹树（Engineering 嵌套）、技能 v0.8.1 版本历史（v1 · Current · Created · Stage5 Shots）、Runtime 配额与并发上限页。截图随 PR 提交附件。

### PR 收口

正式非草稿 PR 向 `AstralSolipsism/multica` 的 `main` 发起（显式 `--repo AstralSolipsism/multica --base main --head sync/v0.8.0-ol-1234`），标题 `OL-1234: sync upstream v0.8.0 and v0.8.1 (OL-1252)`，最终 Head SHA 与 CI 聚合结果见 PR 正文与 OL-1252 评论；跨家族双审由审阅专家按顺序执行（首审 Claude、二审 GLM，涉及数据库迁移与安全边界须两轮通过后才合并，合并操作留给审阅方）。
