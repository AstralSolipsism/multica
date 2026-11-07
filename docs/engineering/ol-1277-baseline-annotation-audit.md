# OL-1277：基线批注五维审视

审视基线：上游 `v0.8.1` / `b1ea927def6490c43bedff537b6f4ed9a47fa828` → Fork `origin/main` / `873ab8b4e`。结论针对这个快照；后续修改、测试和实测结果记录在文末。本报告不使用生产数据，也不推定功能使用频率。

## ① 必要性与上游重叠

上游 `v0.8.0` / `v0.8.1` 有评论选区引用（`reply-annotation.ts`、`comment-annotation-selection.ts`、`use-comment-annotations.tsx`），没有项目基线修订、审阅批次、章节承载任务和一次提交一次唤醒的闭环。`issue-views/baseline.ts` 是视图状态基线，不能替代文档批注。已有选区定位算法已复用，未另建编辑器。

阅读正本、候选源码 Diff、待提交草稿、人工解决/关闭、任务回应均承载 OL-1230 已确认契约，保留。三种锚点处理不同信息：源码行、渲染文字、小节；不能因都有 quote 就删掉一种。三张表分别保存批次生命周期、幂等提交收据和批注/回复，不属于可以无损合并的冗余表。没有访问量或活跃用户数据，不能将任何交互判作低频残留。

## ② 侵入面与克制性

题面 5 个迁移确为 `9059_labrastro_baseline_annotations` 至 `9063_labrastro_baseline_review_batch_index`；当前 main 还包括必要的 `9064_labrastro_baseline_text_block_lines`，放宽 text 锚点的源码块行号约束，不能遗漏。共 6 个迁移对、3 张表、4 个索引，无外键，无本功能专用 Daemon 循环。

后端职责分在 handler 路由/鉴权/事务、engineering 锚点解析、service 创建承载任务/入队，CLI 独立文件，前端 core 管 API/草稿、views 管布局，方向符合包边界。共享文件侵入包括：`service/issue.go` 的批次恢复与提交后通知、`service/task.go` 的延迟通知开关、`labrastro_engineering.go` 的 adopt/reject 关联关闭、删除工程数据 SQL、协议事件、API 导出、项目 Query/mutation、WebSocket 失效和概览挂载。`comment-annotation-selection.ts` 仅增加可选排除选择器，使行内批注文字不进入正文索引。

按8个实现/修复提交追踪当前路径，共92个文件：迁移12（6对）；后端19（新增15、上游修改4，含测试/生成）；CLI新增5；前端52（新增44、上游修改8，含locale/测试）；文档4；本功能专用Daemon 0。该口径包含共用工程文件，不能把整份文件行数都算作 F06 新增量。逐文件真实 `+/-`、上游12个侵入文件和复现口径见 [文件清单](ol-1277-baseline-annotation-files.md)。

无需新建同步框架或全局缓存。首轮优化限定为：复用已有部分索引剪枝、布局一次测量后统一写入、稳定输入 memo 和行对象索引。跨请求缓存会引入修订失效语义，暂不采用。逐条锁、历史详情扇出等残余成本单列，不以“已优化”覆盖。

## ③ SQL、后端和 Daemon

### 逐迁移

| 完整 stem | 审视结果 |
| --- | --- |
| `9059_labrastro_baseline_annotations` | 创建 3 表；字符串/序号/状态配对约束齐备，不带 FK。id 有 UUID 默认值但无身份索引；历史批次读和 id 更新缺合适索引。down 按 annotation→review→batch 删除。 |
| `9060_labrastro_baseline_review_client_key_index` | 并发唯一索引 `(workspace_id,project_id,client_key)`，幂等键正确隔离。不能支持以 id 精确更新。 |
| `9061_labrastro_baseline_annotation_active_index` | 并发唯一部分索引 `(workspace_id,project_id,chapter) WHERE closed_at IS NULL`，同章至多一条物理活跃批次。原提交查询未写谓词，无法利用该索引。 |
| `9062_labrastro_baseline_annotation_ordinal_index` | 并发唯一索引 `(workspace_id,batch_id,ordinal)`，批次列表和排序合适；缺 batch_id 的 id 查询只利用 workspace 前缀。 |
| `9063_labrastro_baseline_review_batch_index` | 并发索引 `(workspace_id,batch_id,created_at)`，审阅列表和相关关闭子查询可用；同时间的 id 排序需补排序。 |
| `9064_labrastro_baseline_text_block_lines` | 保留 lines ≤50 行，允许 text 引用源码块范围，section 禁行号；回滚清空 text 行号后恢复旧约束，存在既定信息损失，不执行生产回滚。 |

4 个 concurrent index 已在迁移 runner 登记失败索引恢复。首次安装、已有工程表升级、down/up 回归由 `labrastro_baseline_annotations_test.go` 覆盖。

### 逐 SQL（`labrastro_baseline_annotations.sql`）

| 查询 | 原实现执行路径与结论 |
| --- | --- |
| `LabrastroListAnnotationBatches` | 全部项目历史批次 + `(created_at,id)` 排序；物理 closed 行不满足部分索引，通常全表扫描。handler 才筛 chapter/issue/state。提交只需同章活跃项，必须剪枝。 |
| `LabrastroGetAnnotationBatch` | workspace/project/id，无身份索引；closed 批次尤其无法使用 active 索引。 |
| `LabrastroCreateAnnotationBatch` | 单条 insert；active unique + 项目锁保障章级串行，索引维护有界。 |
| `LabrastroSetAnnotationCarrier` | 按 id 更新但无身份索引；pending 恢复期间受项目锁保护。 |
| `LabrastroCloseAnnotationBatch` | closed_at IS NULL 能用 active 索引的 workspace/project 前缀，再过滤 id；幂等关闭由 handler 先判断。 |
| `LabrastroGetBaselineReviewByKey` | 唯一索引精确查，重放不插入、不再次唤醒。 |
| `LabrastroListBaselineReviews` | review_batch 索引按批次读，最多 50 次非空审阅；`created_at,id` 可能增量/小量排序。 |
| `LabrastroCreateBaselineReview` | 单条 insert，幂等 unique 冲突受项目锁提前串行。 |
| `LabrastroSetBaselineReviewComment` | workspace/project/id 更新；现有两个索引最多使用 workspace（或 project）前缀，需身份索引治理。 |
| `LabrastroListBaselineAnnotations` | ordinal 索引按批次读且有序，最多 50 条；project_id 残余过滤保证隔离。 |
| `LabrastroGetBaselineAnnotation` | 无 batch_id，ordinal 索引不能精确定位 id；同工作区历史增长会放大扫描。 |
| `LabrastroCreateBaselineAnnotation` | 每次 ≤20 insert，批次≤50含回复，ordinal unique 做最后防线。 |
| `LabrastroRespondBaselineAnnotation` | 逐条 id update，≤50；身份扫描重复，正文不唤醒。 |
| `LabrastroResolveBaselineAnnotation` | 同上，CASE 原子维护 resolved 三字段，不唤醒。 |
| `LabrastroCloseRelatedAnnotationBatches` | 外层限制 workspace/project/chapter/active，至多一行；EXISTS 内限定 workspace/project/batch/revision，可用 review_batch。不存在 OL-1263 型全域 CTE 聚合。 |

额外两条工程清理 SQL：`LabrastroDeleteProjectEngineering` / `LabrastroDeleteWorkspaceEngineering` 的每个 DELETE CTE 都带正确 project/workspace 边界，没有依赖最终 SELECT 才剪枝；批次表缺全量 workspace/project 索引仍可能顺扫，但属低频删除。

### 逐请求成本与闭环

- 提交：先鉴权、人类/决定人门禁及 UUID 校验；工作区生命周期锁→项目更新锁→文档锁→承载任务锁。每条新批注重复读取最多两个目标修订并重解析整章；共用工程解析器限定章正文64KiB、审阅HTTP正文1MiB、20条/次，成本有界但仍重复。字段错误整体回滚。自动关闭失效承载后提交维护事务并重新获取快照，通常多一轮；不存在后台重试轮询。
- 批次摘要：先读历史批次，再逐批次有效状态检查、承载任务/状态、全部批注计数、docs 和工作修订，典型约 5–8 条 SQL/批次（取决于关闭状态和候选存在）。响应不含正文，但服务端确实加载正文计数。N 个历史批次无总数上限。
- 详情：每次审阅各读一遍 reviewed revision，即使 revision 重复；每条批注的 `LocateAnnotation` 都做 Parse + scanHeadings，text 再渲染 Markdown。50 条上限是单批次，不能消除多历史批次放大。
- respond/resolve：每条重新读 annotation、batch、重复锁承载任务和查有效状态，最多 50 次；事务保证中途权限/关闭失败时不部分提交。可在同一事务内复用已校验批次，后续独立做 A 类优化。
- 同一 client_key：先返回已有 review，来源任务路径评论/queue/review 一起提交；新建修订任务路径先保存 pending 收据，之后 IssueService 在工作区/项目锁下原子绑定 issue+queue，允许失败后恢复。通知在 commit 后。`multica.handed_to_agent` 抑制平台重复派发，工单转义用户 summary/anchor，仅保留目标一个 mention，不包含 note/quote/response。
- 常规上下文：`resolveClaimProjectContext` / `appendEngineeringProjectDescription` 不查批注；已有 direct/steal/claimed/batch 四条 claim 对照测试和写入前后字节比较。Daemon 未增加批注后台任务、定时器或专有超时/退避，沿用既有队列唤醒；不能把整仓其它 Daemon diff 算入本功能。

## ④ 前端性能、状态恢复和使用体验

| 文件/组件 | 结论 |
| --- | --- |
| `engineering-baseline-reading-rail.tsx` | rAF 合并 resize/scroll，ResizeObserver 覆盖文章/卡片。原代码每卡多次全局查询 section，读完高度后又在写 top 循环读 offsetHeight，产生读写交错。近视口精确定位、远处标题回退并未虚拟化卡片；这一语义保留。 |
| `engineering-baseline-reading-highlights.tsx` | CSS Highlight 不改正文 DOM；hover 也重建全部 ranges/索引，长章多批注时重复；无 API 请求。未支持 Highlight 的浏览器退化为卡片，已有能力检测。 |
| `engineering-baseline-reading-inline.tsx` | 1279px 以下将卡片 portal 到文本块后，插入节点明确从正文索引排除。全局 document 查找可能命中另一份同 key 视图，建议以后收窄到 articleRef；当前不改定位范围。 |
| `engineering-baseline-reading-annotations.tsx` / `reading-card.tsx` | 统一已提交、草稿和 composer 模型；行内和侧栏复用同卡片。孤立线程保留只读/过时提示。 |
| `engineering-baseline-source-diff.tsx` | 没有逐行 DOM 测量或 scroll 布局循环。真正热点是全章重复 scanHeadings、diff 计算和渲染每行 `rows.indexOf`：展开 n 行时 O(n²)；可改对象→行号 Map，保持重复文本行身份。 |
| `baseline-source-diff.ts` | Myers trace 复制 Map，最坏 O(D²) 内存/时间项，D≈N+M；折叠发生在计算后，不能保护首次大替换。服务端章正文上限64KiB，但大量短行仍可令D很大；前端无独立计算预算保护。不能用无提示截断伪装性能优化。 |
| `engineering-baseline-markdown.tsx` / `text-annotations.ts` | Markdown block 源码行映射用于 text 锚点；选区/命中复用上游文本索引，跨 section 不提交；sourceBlock 每次扫描所有块并排序，成本随小节长度增加。 |
| `annotation-card.tsx` | note/reply 本地编辑态，点击加入才持久化；失败仍留输入。已关闭线程只读，解决失败可见。字符计数用码点，但 textarea maxLength 用 UTF-16，emoji 实际限制更紧，属 A 类一致性缺口。 |
| `annotation-model.ts` | 目标版本优先，只有工作版本匹配时使用 moved；避免把候选行号用于正本。线程构造最坏 O(A²)，单批次50可控但历史批次数无界。 |
| `review-bar.tsx` / `review-dialog.tsx` | 提交 pending 可见、提交中禁止关闭、采用/驳回前确认丢弃草稿；candidate_open/conflict 有显式处理。成员可读、决定人可写，未靠单个未知后端字段决定权限。 |
| `baseline-annotation-draft-store.ts` / `use-baseline-annotation-drafts.ts` | 复用 workspace-aware StorageAdapter，owner/project/chapter 隔离；≤20/审阅，≤200/工作区；迁移过滤非法值，删除/成功只清本次 ID。版本切换仅过滤展示，旧草稿留存。容量到达200时 add 返回 false，但没有区别于20条限制的说明。 |
| `engineering-overview.tsx` / Query / realtime | 无批注定时轮询。进入章节先请求 state=all 列表，再 useQueries 取所有历史批次详情，1+N HTTP。mutation settle 与 WS 都使整个项目批注 key 前缀失效；resolve 一条也会刷新所有历史详情，50批次可触发51个活跃请求/轮，缓存不等于不会重复 refetch。 |

草稿恢复的边界必须明确：`clientKeyRef` 在弹窗挂载时新建，不随草稿持久化。服务端已提交而响应丢失时，同一弹窗重试幂等；关闭/刷新后重新提交生成新 key，可能重复批注和唤醒。若失败后改变 summary/草稿再用旧 key 重试，服务端返回旧收据，UI 可能清除未包含在旧请求里的修改。首轮性能修复不宣称解决这两条数据恢复缺口；需要按“不可变提交快照 + 持久化幂等键 + 精确确认清理”补齐 A 类回归。

与已有优化池复核：OL-1244 #4 的工作版本变化失效、#6 的按章20条计数已在当前代码修复；#5 历史详情扇出、#8 四种错误码仍落到通用失败没有修复。OL-1245 #8 的两端渲染文本规范化不同也仍存在：Go 用空格合并块，浏览器保留块换行，跨块 prefix/suffix 可能在换版后降为 section_only。OL-1242 #4 的 pending 后智能体不可用错误分类、OL-1240 的 CLI text 块行号未展示也保留在原池，不重复新建任务。

体验静态检查：loading/error 有提示、空批注不显示容器；窄屏用行内卡片，Diff 表横向滚动、文本换行、hover:none 显示加号；主题使用 bg-card/background、brand/warning/destructive 等语义 token，无硬编码亮色正文。真实浏览器验证和截图见验证节，不能用 jsdom 证明暗色对比度或滚动帧率。

CLI：annotations 先校验 state/output/batch，再建立请求；批次 UUID 直达、任务标识符经 scope 列表消歧，多章节不随便取第一条。respond 先限制工作目录文件/1MiB/1–50项/UTF-8/1000字，再读 batch 验证成员和 ordinal、再写一次。错误不回显正文；成功文本会另读工作区成员和智能体用于显示名称，非按批注 N+1。API response 允许空字符串，CLI 要求1字，需统一已确认清空语义后修改，不擅自改变约定。

## ⑤ 分级落地

**A 类首轮落地**：阅读栏批量测量；Diff 去除逐行 indexOf 并 memo 小节解析；提交查询直接筛同章 closed_at IS NULL，复用9061索引。均保留所有产品能力、排序、错误码、状态机和 API 形状。

**A 类后续治理项**：持久化提交快照/幂等键（优先级高，需断网提交/重开/编辑后重试的回归）；三表身份索引及批次全量范围索引；摘要集合化计数和详情请求内去重解析；按 batch/chapter 精确失效；大 Diff 算法内存优化、Highlight/选区索引复用。新增索引须单语句 CONCURRENTLY 独立迁移并登记恢复，不能改已发9059；优化历史加载必须保留所有已有信息。

后续项归入常驻 OL-1097，不另拆并行子任务；已有索引/历史扇出/文本定位问题沿用原记录，本轮补充实测证据和提交恢复风险。这是首轮治理 PR 的范围，不代表所有性能和恢复缺口已经解决。

**B 类未执行、也不建议据当前证据裁剪**：删除阅读侧栏、去掉历史/已解决批注、合并3表、用评论代替审阅、截断大 Diff 都改变已批准语义。收益只能估算：截历史可把1+N请求降至常数，但隐藏档案；删侧栏减少定位开销却取消 Word 交互；复用评论会失去修订/批次幂等约束。无使用频率和生产数据依据，不具备裁剪批准条件。本轮维持原功能，因此不存在需要先拍板才能执行的 B 类改动。

## 验证与实测

环境通过仓库 `make up C=api` 分配隔离数据库；首次因本机 `GOTOOLCHAIN=local` 的 Go 1.27.1 低于 go.mod 1.27.3 中断，改用现有 `GOTOOLCHAIN=auto` 工具链并完成全量迁移，没有修改 go.mod。未启动 Daemon 或真实智能体。

### PostgreSQL 实测

复现：[SQL fixture](ol-1277-baseline-annotation-plans.sql)，执行 `psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f docs/engineering/ol-1277-baseline-annotation-plans.sql`。三个 TEMP 表从已迁移的 public 表 `LIKE INCLUDING ALL`，保留索引约束，填入20,001批次、20,000审阅、20,000批注，ANALYZE 后测量，事务最后 ROLLBACK，不写应用数据。

| 路径 | 实际计划 | 实际返回/过滤 | BUFFERS | Execution Time |
| --- | --- | --- | --- | ---: |
| 原提交历史列表 | Seq Scan → Sort | 返回10,001、过滤10,000；sort占2260KiB | local read445/written13 | 13.093ms |
| 剪枝后提交 | active部分索引 Index Scan | 返回1 | local hit1/read1 | 0.020ms |
| annotation id查找（未修） | Seq Scan | 返回1、过滤19,999 | local hit132/read368/written15 | 3.303ms |
| 相关批次关闭 EXISTS | 外层active Index Scan + 内层review_batch Index Scan | 外层候选1、子计划loops1、无匹配更新 | local hit2/read2/written2 | 0.051ms |

这些是一次本机合成数据执行，缓存热度不同，不宣称650倍生产延迟提升。可靠结论是提交路径由全部历史扫描/排序变为现有索引单项读取；身份查询缺口和相关关闭剪枝也得到了执行计划确认。TEMP表复制后索引名由PG自动生成，结构与生产迁移一致。

### Chromium 实测

复现：[浏览器脚本](ol-1277-baseline-annotation-browser.mjs)。从固定原提交和当前代码提取真实 section-anchor 布局回调，200小节/50卡片、20轮改变正文位置，Chromium 156.0.8078.4，通过 CDP Performance 指标计算差值。脚本断言每张卡片最终 top 和 rail.minHeight 前后相同。

| 指标 | 原实现 | 修复后 |
| --- | ---: | ---: |
| LayoutCount | 1020 | 20 |
| LayoutDuration总计 | 112.206ms | 4.928ms |
| 每次callback中位耗时 | 11.5ms | 0.9ms |
| 最终minHeight | 5963px | 5963px |

运行 `node docs/engineering/ol-1277-baseline-annotation-browser.mjs`；本机 Playwright 期望的旧浏览器包未缓存，使用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向已安装Chromium。本测试不包含 React reconcile、真实Markdown text Range、高亮hover、长Diff计算或整站暗色/窄屏视觉检查，不能据此承诺60fps，也不提供伪造产品截图。

### 回归

- 新增 reading rail 回归在原实现上确定失败（`geometry read after a position write`）；修复后通过，覆盖先读后写、碰撞位置、rAF事件合并、卡片Resize重算、卸载取消。
- 新增SQL范围用例验证已关闭、异章、异项目、异工作区均不进入当前活跃批次路由，随后追加审阅仍使用原承载任务。原有失效承载关闭/重取、pending恢复、并发幂等、一次唤醒用例继续通过。
- `GOTOOLCHAIN=auto ../scripts/go-test-with-agent-cli-guard.sh -- go test -race ./internal/handler ./internal/engineering ./cmd/multica ./cmd/migrate -run 'Baseline|Annotation' -count=1 -json`：4包通过，125个pass事件（含子用例），无skip；包括零传播/四条claim、权限隔离、配额、失败回滚及迁移fresh/upgrade/down/up。
- core定向6文件35测试通过（draft、diff、mutation、API/schema、realtime）；views完整baseline组件7文件82测试通过，包含新布局回归、Diff选择/定位/折叠和草稿提交失败保留，共117个前端测试。
- views `tsc --noEmit`、3个变更TS/TSX文件的ESLint、`git diff --check`通过；`make sqlc`重新生成后仅新增目标查询对应代码。

未运行全仓测试、整站E2E、实际网络断连恢复测试、生产EXPLAIN或真实智能体集成。草稿提交跨弹窗恢复和大Diff最坏情况仍为源码推演，已明确留存。
