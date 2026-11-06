# v0.8.0 Stage 2 — OL-1250

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
