# OL-1273 · F03 评论、表格列选择器与成本徽章审视

审视日期：2026-11-07。基线为官方 `v0.8.1`，提交 `b1ea927def6490c43bedff537b6f4ed9a47fa828`；Fork 快照为检出时的 `origin/main`，提交 `78ccc9994297b2751e239f8ceea6d125915d9290`。另以 `v0.8.0`（`9b1ab4f9eed9153a94719596eb8a728d2770f065`）核对功能来源。后续主线变化不属于本次快照。

结论：保留现有功能。评论读取 SQL 与表格列选择器主体已由上游覆盖；Fork 的实质增量是深链保留虚拟化、轻量模块边界，以及工作区批量成本展示。确认两项 A 类问题：评论 CLI 参数校验晚于联网；纯聊天任务结束误触发 Issue 成本聚合刷新。修复不改变正常参数、计费口径、显示开关、列选择或深链交互。

## ① 功能必要性与上游重叠度

| 子能力 | v0.8.0 / v0.8.1 源码事实 | Fork 增量与处置 |
| --- | --- | --- |
| 评论根扫描、回复数、最后活动、拍板摘要 | 两个标签都已有 `ListRootComments*`、`ListThreadCommentsForIssuePaged`、`ListRecentThreadCommentsForIssue`；`comment.sql` 相对 v0.8.1 **零差异** | 保留，按上游能力维护。不能把这些查询计为新增 Fork SQL，不能因“重复”删除 agent 正在使用的读取协议 |
| 线程折叠、`--summary/--full/--thread/--tail` | v0.8.1 的 `comment.go` 与 CLI 已包含完整协议；`thread_resolved` 在 Go 响应装配中根据根/回复的 resolution 设置，并非每行新增一次数据库调用 | 保留高频上下文压缩和逐线程读取；只修 CLI 本地校验顺序 |
| 表格列选择器 | 两个标签都在 `table-view.tsx` 内定义 `TableColumnPicker`，已有系统列、自定义字段、搜索、标题不可隐藏 | Fork 将同一实现移入独立文件，表格/头部共同引用，减少加载表格实现的依赖；不存在第二套列状态 |
| 评论深链 | 两个标签都有高亮、memento、通知跳转；原 `isFlatTimeline = !!highlightCommentId || find.open` 会在深链时挂载整条时间线 | Fork 仅在页内查找时展开平铺；深链先挂载目标虚拟行，再定位具体回复，值得保留 |
| Issue 卡片成本 | 上游已有详情 `GetIssueUsageSummary` 与 dashboard 用量，缺少按 Issue/provider/model 的工作区卡片投影 | Fork 补足看板、泳道和 DAG 成本；批量查询与 cache-only 徽章避免每卡一次请求。用途与详情统计不重叠 |

没有用户频次遥测，不能把“看起来不常用”当作低价值依据。未发现本单位可直接删除的实验表、独立缓存层或废弃后台任务。

## ② 架构侵入面与实现克制性

以下是任务点名的 **10 个文件**相对基线的精确统计：7 个新增、3 个修改，合计 **+738 / -177 行**；其中前端 6 个、后端 handler 2 个、CLI 1 个、SQL 1 个，Daemon 0 个，新增迁移 0 个。这是点名文件口径，并非整个功能依赖闭包；混合文件的全部行差异也不能全部归因于 F03。

| 文件 | 行差异 | 逐文件结论 |
| --- | ---: | --- |
| `server/internal/handler/comment.go` | +94/-31 | 线程读取相对基线没有新增查询；变化主要为外部会话权限、YSK 来源失效与请求结构提取，属于其他功能交叉点，不在本任务回退 |
| `server/internal/handler/issue_usage.go` | +74 | 一次成员门禁、一次聚合；响应省略全未定价行的 5 个可选字段，保持历史客户端估价回退；空工作区返回 `[]` |
| `server/pkg/db/queries/labrastro_task_usage.sql` | +29 | 仅一个工作区聚合，Fork 独立文件减少 `task_usage.sql` 冲突；无新表/写放大 |
| `server/cmd/multica/cmd_issue.go` | +122/-45 | 差异主要是依赖写入、搜索、文本帮助；评论读取仍复用上游逻辑，但原有组合校验发生在凭据与资源解析之后 |
| `packages/core/realtime/use-workspace-usage-realtime-sync.ts` | +52 | 终态事件首沿加尾沿 30 秒节流，卸载清理；缺少纯聊天事件过滤 |
| `packages/views/issues/comment-deep-link.ts` | +31 | 无依赖叶子模块，web/desktop 导航直接导入，避免导航入口加载编辑器/详情 barrel |
| `packages/views/issues/components/comment-landing.ts` | +73 | 纯状态判定；等待、展开、跳转与已消费语义可独立测试，无新增持久状态 |
| `packages/views/issues/components/table-column-picker.tsx` | +118 | 从表格组件抽取；复用既有 view store、翻译、DropdownMenu，没有新增列协议 |
| `packages/views/issues/components/table-view.tsx` | +2/-101 | 移走选择器后导入独立组件，另有 YSK `tipAnchor`；表格分页、排序、拖动实现保持上游 |
| `packages/views/issues/components/issue-cost-badge.tsx` | +43 | `enabled:false` 观察者，只选择相关 Issue 的数值；自定义价格变动重新估价，去重 DAG 成员 ID |

额外核对的成本调用与数据契约清单共 **16 个文件**（12 个 TS/TSX、2 个手写 Go、1 个 SQL、1 个生成 Go）：上述 usage handler/SQL/hook/badge，加 `server/cmd/server/router.go`、`server/pkg/db/generated/labrastro_task_usage.sql.go`、`packages/core/{types/agent.ts,types/index.ts,api/client.ts,api/schemas.ts,issues/queries.ts,realtime/provider.tsx}`、`packages/views/issues/{surface/issue-surface.tsx,components/board-card.tsx,dag/dag-task-card.tsx,dag/dag-overview-card.tsx}`。路由 `/usage-summary` 注册于动态 Issue 路径之前，客户端走 zod 与 `parseWithFallback`，schema 测试已有零价格、缺字段和畸形响应覆盖。

另核对成本开关的 view store、`issues/surface/view-mode.ts`、`issues-header.tsx` 与 en/fr/ja/ko/zh-Hans 五份翻译；旧偏好默认补 `cost:true`，显式关闭持久化保留。16 文件仅是调用链清单，不包含这些偏好/文案/测试文件。历史引入提交 `e7633e969` 共改 36 文件（含测试与文案），而之后查询拆分、实时 hook 和展示瘦身已改变文件布局，不能把历史提交的文件数当成当前完整侵入面。

深链扩展核查包含 `issue-detail.tsx`、`issue-detail-route.tsx`、组件导出、views package export、web/desktop navigation adapter；选择器扩展核查包含 `issues-header.tsx`、view store 的 toggle/normalize 与对应测试。它们与其他功能共享，未把整文件差异重复累加为 F03 成本。

最小收敛方案：继续沿用上游 comment SQL、表格 view store 和核心 query keys；本次只移动既有 CLI 校验段、增加一个事件范围判断。无需新迁移、抽象层或服务端缓存。

## ③ 数据库、后端与 Daemon 性能

### 执行计划证据的边界

本环境 `make status` 显示无已注册开发环境；按仓库流程生成 `.env.worktree` 后，`make migrate-up` 在 `scripts/ensure-postgres.sh` 报 `docker: command not found`。因此以下为**源码与索引定义上的执行计划推演**，不是 `EXPLAIN ANALYZE` 实测；没有生产数据、真实耗时、buffer 命中率或 p95 结论。未访问生产数据库，也未连接假定的共享实例替代开发环境。

记 `C` 为某 Issue 评论量，`S` 为所选根的总后代数，`D` 为线程深度，`T` 为工作区任务量，`U` 为工作区用量行数，`G` 为 Issue/provider/model 分组数。

| 查询 / 路径 | 剪枝、预期计划与代价 | 判定 |
| --- | --- | --- |
| `ListCommentsForIssue` | `(issue_id,created_at,id)` keyset 索引倒序拿 cap+1，外层仅排序窗口；workspace 再过滤 | 有界，非全站扫描 |
| `ListCommentsSinceForIssue` | 同索引按 issue 和 `created_at > since` 前进，cap+1 | 增量只包含新创建行；编辑/resolve 不会因 updated_at 自动进入结果，这是原协议 |
| `ListCommentsByIDsForIssue` | PK/bitmap 对 `id=ANY`，每层同时校验 workspace/issue | 批量补祖先，不是每条评论一次查询 |
| `ListChildCommentsForParents` | parent lookup 索引 + issue/workspace 过滤，固定 through 游标和 row_limit | 分层批取；Go 补全总预算 2000、深度 64，超过预算按线程丢弃并标记截断 |
| `ListRootCommentsForIssue` | `selected_roots` 先 LIMIT，再递归 membership；`thread_stats` HashAggregate，resolution PK join 后按 root/resolved_at 排序并 DISTINCT | 查询的展开量是 S，根数量限制不等于后代数量限制；没有全工作区 CTE 漏剪枝 |
| `ListRootCommentsSinceForIssue` | since 在 selected_roots 内，递归仅该批新根；resolution/stats 共用 membership | 正确剪枝，但旧根新回复不会让根进入 roots+since；增量阅读需普通 since |
| `ListThreadCommentsForIssuePaged` | root_of 逐层 PK 查祖先；descendants 对 parent 索引递归；之后才 top-N/cursor | `--tail 30` 限响应，不把数据库扫描降为 30 行；必须先找全线程才能保持任意深度的语义。大线程约 O(S + D) 展开，UNION 去重和宽正文可能增加内存/临时盘成本 |
| `ListRecentThreadCommentsForIssue` | 先遍历该 Issue 的全部 membership，按 root 汇总 MAX，再挑 N 个线程并回表 | `--recent N` 限线程，不限评论或扫描量。O(C) 是当前“最近活跃线程”的计算代价，不应误删旧根来剪枝 |
| `GetThreadRoot` | 按 anchor PK 沿 parent 向上 | O(D)，读路径无写锁；异常环的防护不是本次引入新 schema 的理由 |
| `GetIssueUsageSummary` | issue_id → task_id 两阶段聚合；terminal_runs 的 EXISTS 可用 task_usage task_id 索引 | 原详情口径保留。工作区卡片不逐 Issue 调此查询 |
| `ListWorkspaceIssueUsage` | 预期小租户由 issue(workspace_id,id) → atq(issue_id,id) → usage(task_id) 索引连接，再按 G 分组/排序；大租户可选择 hash join/seq scan | 单条无 CTE SQL，workspace 谓词可下推；没有 N+1。全历史投影最低仍需处理 U，用量规模大时不是 O(G) 的免费读取 |

相关索引定义核对：`068_timeline_keyset_index.up.sql` 的 `idx_comment_issue_keyset`；`241_comment_parent_lookup_index.up.sql` 的 `(workspace_id,issue_id,parent_id)` 部分索引；`247_comment_parent_index.up.sql` 的 parent 部分索引；`282_issue_workspace_id_keyset_index.up.sql`；`279_agent_task_queue_issue_id_keyset_index.up.sql`；`032_task_usage.up.sql` 的 task_id 索引和 `(task_id,provider,model)` 唯一索引。它们已在基线中存在，不新增重复索引。存在索引不代表任何分布下必然命中；全站占比高时顺序扫描可能更合理。

根摘要只有一条主查询。`thread_resolved` / `resolution_content` 来自主查询的字段，Go 再投影；reactions、attachments 在折叠完成后按剩余 IDs 批量查询，不是根数乘三。`summary=true` 截断为 200 runes 发生在 Go，因此减少 JSON/agent 上下文，但不会消除数据库回传原始正文的代价。`foldResolvedThreads` 每行向上找根，极深链最坏 O(C×D)，当前正常浅层线程近似线性；不把输出 cap 当成所有 SQL/CPU 的硬上限。

成本计量核查：provider 大小写归一；包含 completed/failed/cancelled/running 的已上报用量；NULL cost 才进入 uncosted；权威零价格不重新估价；无用量不产生行，计量为零仍产生行；父子 Issue 独立聚合，前端集合只累计一次。不额外按 atq.workspace_id 剪枝，当前授权/归属以 `issue.workspace_id` 为准；盲加条件可能丢弃历史归属不一致的有效账单。

usage handler 没有显式事务/行锁/重试循环，使用请求 Context；没有新增 Daemon tick。已有 `TaskUsageHourlyJob` 为 5 分钟调度、25 分钟超时、30 分钟 stale、30 秒 heartbeat、最多 3 次尝试、1/5/15 分钟退避，并由 SQL advisory lock 串行化。但此 hourly 表并不提供本查询的 Issue 粒度，不能直接替换为小时汇总而不改变语义。

后续实测应在按仓库方式启动并迁移的隔离数据库中，对 sqlc 生成的上述查询绑定具体 workspace/issue/cursor 后执行 `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)`：至少覆盖 100/10,000/100,000 评论、浅宽与深链、1%/90% 租户占比、百万条 usage；记录 recursive loops、actual/estimated rows、shared hit/read、sort spill、扫描行数和响应字节。测试小租户应核实 issue→atq→usage 索引链，测试大租户应核实 hash/seq scan 的总扫描量。这里不填写未经运行的毫秒或“命中率提升”。

## ④ 前端渲染、体验与 CLI

### 成本同步

- 只有 completed/failed/cancelled 进入成本 hook，progress/message 不进入；第一个事件立即 invalidation，连续事件每 30 秒最多再触发一次尾沿。在 [0,60] 秒持续有事件的窗口最多 3 次该 hook 的 invalidation，不是每条消息一次。
- `IssueSurface` 仅在成本显示开启且为 board/swimlane/dag 时启用共享查询；隐藏或列表/表格视图没有主动成本 fetch。徽章 `enabled:false`，100 张卡共享一个 query；`select` 返回数值，数据变化不等于每张卡提交一次 React 渲染。
- 此 30 秒上界**只适用于该 hook**。reconnect、workspace 切换、label/squad 等广义 issue invalidation、重新挂载与焦点重新拉取可另行触发。详情用量还走原 `useRealtimeSync` 的 100ms task debounce；持续高频终态会延后尾沿，不能宣称详情也受 30 秒成本节流保护。
- `WSProvider` 随 workspace slug 更换 WSClient，hook 清掉尾沿定时器并重新订阅；reconnect 由核心同步失效当前 workspace key。无需额外状态 store。
- 已复现：纯聊天终态没有可连接的 issue_id，却触发工作区聚合；3 个聊天终态加 30 秒会导致 2 次 invalidation。A 类修复在调度前过滤带 chat_session_id 且无 issue_id 的事件；同时具有 Issue 与聊天上下文的任务仍刷新。
- 估价依赖自定义定价 store；每卡按自身行求和，而非扫描整个工作区数组。未计量显示为空、计量零显示 `$0.00`；`bg-muted/60` / `text-muted-foreground` 遵循主题。badge 不换行且 shrink-0，窄卡仍需其他内容的截断配合，本次未改变布局。

### 深链与列选择器

- 详情仍是 `issueTimelineOptions` 单次完整窗口请求，**没有前端评论翻页**；CLI cursor 与 Virtuoso 虚拟滚动不是同一机制。标题中的“分页态”不能据此推断当前 UI 有 fetchNextPage。
- `decideCommentLanding` 等到 target、scroll container、Virtuoso 均就绪才消费 memento；先展开手动折叠和 resolved 线程。晚到 hash、Issue 切换、同页通知重播和高亮淡出都有对应集成断言。web/desktop 用共同 fragment grammar 与 memento key，叶子模块保留轻量导入边界。
- 边界未解决：服务器超过 2000 窗口及补全预算后可截断/移除线程；不在 items 的旧目标会停在 wait，客户端 `listTimeline` 未将截断头转为定向补取。不能承诺任意久远链接必达。无效/已彻底删除的目标同样缺少明确着陆反馈；本次没有通过展开全部历史或提高 cap 掩盖问题。
- 列选择器只迁移代码，不替换 v0.8.1 表格机制。title 在菜单和 store 双重禁止隐藏；`property:<id>` 与现有列键一致；搜索在本地过滤，按键阻止菜单 typeahead 抢输入、Escape 保留退出；长字段名 truncate，列表 max-h-80 可滚动，空结果有既有翻译，主题来自语义 token。
- DOM 单测的菜单 primitives 有 mock，不能证明真实焦点管理、窄屏弹层避让、暗色视觉对比或浏览器排版全部合格。本次不提供未经浏览器实测的截图或 FPS 声明。

### CLI / API

API 先加载 Issue 并执行权限校验，再解析 since/组合/cursor；权限门禁优先合理。since/before 以 RFC3339Nano 解析、cursor UUID 校验、tail=0 保根、recent/tail 上限 2000；cursor 为 timestamp+ID，避免相同时间戳漏项。fold 禁止 partial-thread 模式，CLI 默认只在完整线程路径带 fold。

CLI 的组合 guard 已存在，但原先先 `newAPIClient` + `resolveIssueRef`。离线或凭据无效时 `--recent 0` 得到网络/登录错误，且所有无效组合多一次 Issue GET。A 类修复将原校验/参数组装原样放到客户端初始化之前；既有错误文案和有效请求不变。since/thread/cursor 的值格式仍由服务端校验，未引入第二套日期/UUID 解析规则。

## ⑤ 分级处置与验证

### 本次 A 类交付

1. 评论 CLI 先检查既有互斥/范围/游标组合规则，再读凭据、解析 Issue 和发请求。核心回归：无效组合零 HTTP 请求；无效凭据不能掩盖参数错误；有效参数仍正确转发。
2. 成本 hook 排除明确的纯聊天任务；保留 Issue 终态 30 秒首/尾沿节流。核心回归：聊天事件零 invalidation、不占用节流窗口、不增加尾沿；Issue+chat 事件仍刷新；卸载清理继续有效。

无需 SQL/schema 改动或 sqlc 重新生成。两项缺陷均先运行回归测试确认失败，再实施修复并验证通过。

### 保留的限制与候选后续

大历史聚合、线程 tail 全子树扫描、根摘要正文搬运以及截断后的深链定向补取是有依据的后续优化候选。前两者需隔离数据库计划实测决定是否重写；不能为降低账单查询成本删掉失败/取消任务用量、只统计可见卡片或设近期截止。本次没有据此创建多个后续 Issue，也没有把候选描述为已修复。

B 类取舍对比：删除列选择器会丢失至少 13 个系统列和自定义字段选择；直接恢复上游深链逻辑会让持 hash 的时间线从虚拟窗口退回全量 DOM；删除成本投影会让看板/泳道/DAG 失去展示入口，或退回每卡拉详情。以上均不采纳，不执行功能裁剪；当前保留方向符合原任务，无待拍板的产品变更。本报告中的限制不作为暗中降级接口或 UI 的许可。

### 验证记录

| 验证 | 结果 |
| --- | --- |
| 修复前 CLI guard 回归 | 11 个组合都先发 Issue GET，返回网络错误；凭据场景返回 token 错误。两个顶层测试失败，确认原问题 |
| 修复前纯聊天事件回归 | 预期零 invalidation，实际 2 次；1 failed / 4 passed |
| `GOTOOLCHAIN=auto go test ./cmd/multica -run 'TestRunIssueCommentList\|TestCompactComments' -count=1 -v`（server 目录） | 通过；覆盖组合、凭据顺序、summary/roots/since、fold/full、tail/cursor 输出、compact |
| core：`vitest run realtime/use-workspace-usage-realtime-sync.test.tsx realtime/use-realtime-sync-ws-instance.test.tsx` | 2 文件、50 个测试通过，包含本次两个新事件用例与既有 reconnect/progress 回归 |
| views：comment-landing、issue-detail-route.highlight、table-column-picker、issues-header.display-columns、issue-cost-badge 五个测试文件 | 31 个测试通过；包括 100 卡共用一次请求、自定义价格和零值 |
| views：`vitest run issues/components/issue-detail.test.tsx -t 'highlight\|deep.link\|arrival\|notification\|folded resolved\|same-page\|manually collapsed'` | 33 通过，106 因名称筛选未运行；覆盖折叠、虚拟化、迟到 hash、同页重播、Issue 切换和淡出 |
| `pnpm --filter @multica/core typecheck`；对两个变更 TS 文件运行 ESLint | 通过 |
| `GOTOOLCHAIN=auto go vet ./cmd/multica`；`git diff --check` | 通过 |
| 完整 Go/数据库集成、`EXPLAIN (ANALYZE, BUFFERS)` | 未运行：标准数据库启动缺少 Docker。未把 handler 的 TestMain 退出/skip 计为成功；SQL 使用上文计划推演 |
| 完整 monorepo tests、Playwright/暗色与窄屏视觉、生产性能采样 | 未运行；变更限定 CLI 校验和事件过滤，未调整 UI 布局。DOM 单测不替代浏览器视觉测量 |

前端定向测试合计 114 个通过。环境默认 Go 1.27.1 且 `GOTOOLCHAIN=local`，低于仓库要求 1.27.3；上述 Go 检查通过 `GOTOOLCHAIN=auto` 使用匹配工具链，未改项目版本配置。依赖以 `pnpm install --frozen-lockfile` 安装，lockfile 未变。
