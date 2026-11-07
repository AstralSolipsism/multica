# OL-1275 / F17 消息投递与飞书发现审视

基线：官方 `v0.8.1` / `b1ea927def6490c43bedff537b6f4ed9a47fa828`；Fork：检出时的 `origin/main` / `2c7a522896729b3eea771f38ab6b69f0cdf56159`。结论来自两棵 Git 树的直接比较、当前实现及隔离 PostgreSQL 实验，不用旧设计文档代替代码。审视日期：2026-11-07。

## ① 必要性及上游重叠

| 子能力 | 上游基线实际覆盖 | 处置判断 |
| --- | --- | --- |
| 自动化结果、个人收件箱、团队 activity/comment 主动投递 | 有 Autopilot、Inbox、通知偏好和飞书传输，没有 `messagedelivery`、规则/决策/回执中心及对应 UI | 保留；是站内事件到外部渠道的适配，不能以原生通知存在为由删除 |
| 群/话题选择 | 有 `ListChatMessages` 的近期入站上下文读取、发送及身份 API，没有管理者分页选群/锚点接口 | 保留；复用 HTTP client/token，分页发现与入站上下文各有权限和分页语义 |
| 私聊候选发现 | 有 `BatchGetUsers`、绑定及会话设施，没有拒绝入站后等待人工确认的候选流程 | 保留；观察记录不是授权，确认复用原有 consent writer |
| 执行终态 | 上游已拥有终态与 quota 结算 | Fork 增加 first-terminal 幂等、双向任务链接修复、状态快照；保留共享结算，不另建状态机 |
| 老 feedback 报告恢复 | 现行 Fork 已由 `478_labrastro_feedback_retirement` 退役 | 不复活；历史表用于防重放和审计，不能当死表直接删 |

没有线上使用频次/规模遥测，不能宣称哪个已确认功能“低频所以无价值”。本次没有产品删减建议，也没有 B 类改动需要实施。

## ② 侵入面与克制性

工单列的 7 个迁移只是来源扩展/水位线部分；真实依赖闭包包含 29 个历史迁移 stem（58 个 up/down 文件），含 feedback 历史。当前活跃投递模型为 route、delivery、receipt、approved_target、scan_cursor 五表；另有退役 feedback 历史表。每张表分别承载配置版本、冻结决策、分片幂等、同意范围、补偿进度，合表会混淆生命周期。

以实际 Git diff 为口径，`internal/messagedelivery/` 有 42 个差异文件，其中生产 Go 16 个/4,565 行，其余为测试和契约；`core/message-delivery/` 为 7 个差异文件，其中生产 5 个/621 行；`views/message-delivery/` 为 33 个差异文件，其中生产 15 个/4,720 行；`views/lark/` 为 15 个差异文件，其中生产 8 个/1,785 行。这是目录内差异计数，不含共享 API/types/i18n 接入，也不把上游已有且未改的文件算新增。本功能没有独立 CLI/Daemon 扫描器。

| 文件/接点 | 核查结论 |
| --- | --- |
| `cmd/server/labrastro_messaging.go` | 单一装配点；Sender/Verifier/RunSyncer 为边界。实际计时器在 `messagedelivery/worker.go`，不在装配文件 |
| `cmd/server/main.go`、`router.go`、`shutdown.go`、`handler/handler.go` | 持有同一 Service、挂路由、启动并 join worker；不需要新增插件框架 |
| `handler/labrastro_message_delivery.go` | Autopilot write gate、revision 与错误码映射；读取也要求可写是既有契约 |
| `handler/labrastro_message_sources.go` | 自己的 Inbox 与 admin 团队配置分开；列表不携带正文快照；个人目标强制为当前 acting member |
| `handler/labrastro_message_routes.go` | 纯路由注册，无独立授权实现 |
| `handler/lark_target_discovery.go` | human management gate、HMAC 游标绑定 ws/bot/user/chat/query/page-size；先鉴权和参数检查再调用 provider |
| `handler/lark_private_chat_discovery.go` | 最多 50 条、7 天 TTL；短事务剪枝，提交后最多 5 秒批量补姓名，失败降级为 ID |
| `service/autopilot.go`（+41/-11） | 首次终态幂等、reverse-link 和 latest dispatch attempt 修复；通知的 priority/精确时间变化不全属于投递模块 |
| `service/autopilot_quota.go`（+35/-6） | 原子结算入口包裹 `errRunAlreadyTerminal`；状态快照留在既有 SQL 结算，不把飞书传输放进 quota 事务 |
| `service/autopilot_quota_notifications.go`（+1/-1） | 通知时间精度变化，无独立投递逻辑 |
| `internal/autopilotauth/auth.go`（42 行新增）与 `handler/autopilot.go` | 共享 CanWrite 谓词，避免 handler/worker 权限漂移；归档在现有事务中调用 lifecycle.StopAutopilot |
| `handler/{workspace,workspace_revoke,project,lark}.go`、`service/runtime_teardown.go` | 事务内停止和清理已集中到 `messagedelivery/lifecycle/cleanup.go`；继续保留父锁顺序 |
| `views/autopilots/components/autopilot-detail-page.tsx`（+109/-5） | 两个独立 section、run badge 回调和外提 dialog；消除 AppLink portal 冒泡。以后可将 RunHistoryList 提为独立文件，但不需要为此引入注册系统 |

叶模块逐文件：`types.go` 管规范化/校验；`message.go`/`content.go` 管内容与分片；`ports.go` 管外部能力与错误分类；`authorization.go`/`gates.go` 管配置及每片发送时的持续授权；`routes.go`/`sources.go` 管同一存储的各 scope；`service.go` 管 run 决策入口；`source_decide.go` 管三个来源；`decisions.go` 管公共冻结写；`deliveries.go` 管列表/人工重试/回执；`events.go` 管非阻塞唤醒；`worker.go` 管发送与补偿；`scan_warnings.go` 管水位线滞后的有界告警。没有发现应直接删除的活跃重复状态机。

## ③ SQL、后台与外部调用

### 迁移逐项

| 工单指定 stem | 作用及审视 |
| --- | --- |
| `467_labrastro_message_sources` | 扩展原表 scope/字段/check，未新造虚拟 autopilot；down 会删除非 run 审计数据，不作为本次瘦身操作 |
| `9010_labrastro_message_delivery_run_index` | `(run_id, installation_id, target_key)` 部分索引支持缺失集反连接 |
| `9011_labrastro_message_delivery_sending_index` | 只索引 sending lease 到期；避免扫描终态账本 |
| `9012_labrastro_message_inbox_scan_index` | member 来源 `(created_at,id)`，与 SQL 谓词一致 |
| `9013_labrastro_message_activity_scan_index` | status/assignee 来源 `(created_at,id)`，与白名单一致 |
| `9014_labrastro_message_comment_scan_index` | 未删除 plain comment `(created_at,id)`，排除系统/进度评论 |
| `9015_labrastro_message_source_watermark` | 增加 stable horizon；只重置三个来源并递增 generation，run repair 保留。回滚需匹配旧代码并停 worker |

五个索引均为独立 concurrent up/down，并注册 invalid-index recovery。旧 stem 保持不动。完整迁移和 SQL 名称清单见附录。

### 查询逐组与成本

`pkg/db/queries/labrastro_message.sql` 共 69 条命名查询，无大范围 MATERIALIZED CTE 聚合。附录给出每条的归类。

| 查询族 | 索引/锁与成本判断 |
| --- | --- |
| route CRUD/enable | 主键+workspace+revision CAS；唯一身份索引防重建；effective_from 防止重新启用回填停用期 |
| delivery claim/finish/retry | queued 部分索引、`FOR UPDATE SKIP LOCKED LIMIT 1`；每次状态写按主键和 lease token+期限；2 workers 每秒空闲领一次，约 2 次/s/实例 |
| receipt claim/list/external-id | 唯一 `(delivery_id,shard_index)`；首次外部 ID 胜出；分片已成功不重发 |
| approvals | active 唯一索引、project null 范围约束、`FOR SHARE`；外部网络验证在短配置事务之前 |
| workspace/project/installation/route locks | 复用父资源锁，顺序固定；每候选有短事务，20,000 行预算不等同于扫描行数/墙钟预算 |
| Inbox/activity/comment candidates | time range 先界定候选，`DISTINCT ON` 优先同目标下匹配且授权规则，再 NOT EXISTS；包含末行 ID 以排空同来源的多个目标，不能改成简单 `>` |
| source horizon/upper bound/cursor | PK backward LIMIT 1 获取上界，generation CAS 防旧副本覆盖。观察最老事务+1分钟 overlap；不可观察 writer/启用两阶段提交会退回 epoch，长事务也会扩大窗口 |
| run candidate missing set | 9010 支持反连接，但“结果集缩小”不代表历史读取消失。所有运行已投递时仍须遍历历史终态；LIMIT 200 仅限制返回数 |
| 三类 run repair | active-run + task/issue ID 范围，现有 issue/task/run 索引；OR 双向链接及 dispatch chain 是正确性所需，晚终态必须下轮重访 |
| source route history | **A 类缺陷：没有 `(workspace_id,route_id,created_at,id)` 列表索引；时间相同缺少 id 排序** |
| autopilot history | 现有 workspace/autopilot/time 索引，已含 `id DESC` SQL tie-break；可选 run/status 与大 offset 仍会追加过滤 |
| lifecycle cancel/delete | 归档/撤销为低频批量写，事务保证停用+取消原子；workspace 索引前缀可用，installation/project/target 会追加过滤 |

每来源每次最多 100 页×200 决策，但 SQL 的 join/anti-join/sort 可以读取更多行。单个 inbox 决策有偏好+binding 读取，assignee change 最多有两侧身份读取，另有每决策锁/插入；是剩余 O(N) DB 往返，不应把发送时授权改成长期缓存。补偿无独立 query timeout，受 worker 取消上下文控制；单条慢 SQL 会延后该串行轮次。这里没有 Daemon 计时器。

发送最多 5 次，退避 1/2/4/8…秒、封顶 30 秒；每片发送和结果写都有独立超时；不确定发送进入 uncertain，不能为省行数去掉回执/人工确认。

### 扫描频率与空转成本

发送领单与补偿扫描使用不同循环。`worker.go:24` 的 `defaultScanEvery` 为 **30 秒**，`scanLoop`/`runScanSchedule`（`:298-332`）共用一个串行调度循环；当前装配没有覆盖 `ScanEvery`。定时 `ScanOnce`（`:339-363`）先处理过期 claim 和三类 run repair，再调用 `decideMissing` 与三个来源扫描器。没有事件时，每实例约每分钟两轮 run 缺失集查询；扫描超过周期时 ticker 不积攒无限队列，因此这不是完成后固定再等 30 秒。

事件路径由 `events.go:12-19` 订阅 `autopilot:run_done`、`inbox:new`、`activity:created`、`comment:created`。回调没有 workspace/source 过滤，任意工作区的这些事件都通过同一缓冲信号唤醒；`decideSourcesOnce`（`worker.go:389-397`）每次仍先扫全局 run 缺失集，再扫 inbox/activity/comment。事件合并只减少重复唤醒，不收窄 SQL 范围。`decideMinInterval` 为 **1 秒**，计时从上一轮执行结束后开始；持续事件流不会反复重置截止时间，仍保留末次补扫。定时与事件路径共用上述循环，不会在同一实例内并发执行两轮。

用 10 万已决策 run 的单次实测 0.63 秒和审阅复现的 0.71 秒估算，仅这条无结果查询的单连接等价忙碌占比如下：

| 事件条件 | 近似频率 | 单连接等价占比 |
| --- | --- | --- |
| 无事件，30 秒定时补偿 | 每分钟约 2 次 | `C / 30` ≈ **2.1%–2.4% / 实例** |
| 持续每秒至少一个上述事件 | 每 `1 + C` 秒一轮，约 35–37 次/分钟 | `C / (1 + C)` ≈ **39%–42% / 实例** |

这是只计 run 查询、假设其他步骤耗时较小的持续事件模型，不是生产 CPU 利用率、连接池占用率或严格上限；其他扫描、数据库竞争、30 秒 tick 与事件合并都会改变实际频率。多实例各自调度，历史 run 与可匹配目标增长还会增加单次工作量；现有 200 条返回限制不能限制缺失集反连接读取的历史行数。因此三类来源在空窗口没有全扫，不等于整个补偿系统无空转。OL-1097 将“按事件来源收窄唤醒、保留 30 秒全量补偿”列为优先非阻断优化；本轮不改调度器，其跨源事务、丢事件补偿和多副本游标行为需独立回归。

### EXPLAIN 实测方法与结果

`evidence/ol1275-message-plans.mjs` 从当前 sqlc 生成文件读取原始参数化 SQL，在隔离 PostgreSQL 15.19 上创建 `LIKE … INCLUDING ALL` 临时表（保留列/check/index，不复制触发器），每来源 100,000 历史+20 最近记录、100,000 已投递运行、400,000 终态投递。全部投递均按生产写入路径携带 route_id，其中 100,000 行有 autopilot_id，300,000 行为空。ANALYZE 后采用默认 planner；执行 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`，事务最终回滚。不是生产负载/真实飞书延迟，不将单次耗时当 P95 或 SLA；临时表报告 local buffers，不能冒称生产 shared-cache 命中率。

结果：三个稳态来源读取 20 行，命中时间部分索引和 source-ref 反连接索引；空窗口各约 3 local buffer hit，未读历史行。首次/epoch 扫描需要读取全部 100,020 行，某些计划使用 hash anti join 并溢写临时文件。run 全已决策场景仍读取 100,000 run 和 100,000 ledger，约 0.63 秒；因此不能声称所有补偿均无空转。没有专用索引时，来源历史列表扫描 400,000 ledger，过滤掉 300,000、排序其余 100,000 后返回 100 行，测得 164.767ms。

### 飞书调用

群每请求一页，锚点每页先验证群再读消息；HTTP 默认每次 10 秒（多个调用不是一个总 10 秒上限）。token 按 app_id 缓存并在凭据/拒绝时失效；没有群历史/联系人共享内容缓存，响应 `no-store`。这避免缓存被误当权限，但反复打开会再次调用。前端 transient 错误最多重试两次；429 有独立错误码，未透传 Retry-After；没有服务器端全局发现限流器。不能承诺高并发无 429。

私聊最多一次 50 ID 批量查询，5 秒整体 enrichment deadline；权限、超时、限流失败仍返回可确认的 ID 候选。候选写锁仅围绕最多 51 条 metadata 排序/剪枝，网络调用不持锁；无需未经测量迁移成新表。

## ④ 前端与 API 体验

| 文件/组件 | 核查结果 |
| --- | --- |
| `core/message-delivery/{queries,source-queries}.ts` | workspace key；记录 5s/30s，自身详情终态停轮询；source routes/approvals 为跨客户端撤销可见性保持 30s。infinite query 实际重取已加载各页，并非注释所称只取第一页 |
| `core/message-delivery/{mutations,source-mutations}.ts` | 操作后局部 key 失效，配置冲突需重新读取；没有另建 websocket responder。Autopilot 事件失效整个 autopilot prefix，会放大所有可见 badge 的重取 |
| `message-delivery-section`、`personal-push-section`、`team-subscriptions-section` | 各司配置；加载/403/旧服务/空列表有区分；admin 与 acting member 门禁；刷新失败保留数据且阻止基于旧权限写入 |
| `route-editor-dialog`、`source-route-editor-dialog`、`source-route-row` | 表单草稿、revision 冲突重读、目标能力失败保留手填路径；dialog 限高可滚动；控件语义标签和 semantic 色彩 |
| `message-deliveries-section`、`route-deliveries-dialog`、`run-deliveries-dialog` | 每页 100、load-more、去重、错误和 uncertain 重试确认；列表不带快照、详情单独取。无虚拟化，大量加载后 DOM 与轮询会一起增长 |
| `run-delivery-badges` | 每 run 一个无限查询、最多展示三 badge；可见 R 行带来 R 次首读和各自定时请求，是可测 N+1 请求结构；只读 403 后仍有定时空请求空间 |
| `copy.ts`、`status-visual.ts`、`target-selection.ts` | 状态/错误文案与能力选择集中，未知值兼容；index 文件仅导出 |
| `lark/{use-lark-discovery,discovery}.ts` | 300ms 搜索防抖、去重、失效游标重启、分页失败区分 retry；**自动跳过空页没有检查 enabled，折叠仍可能继续请求** |
| `lark-chat-picker`、`lark-chat-multi-select`、`lark-anchor-picker` | 当前选择可清除/显示 ID，空页 has_more 不伪报无结果；窄栏 truncate、max-height overflow、语义色和键盘控件 |
| `lark-private-chat-select`、`picker-common` | 50 条上限，ID-only/过期/权限/确认失败有状态，显式确认后更新 grant 缓存；长名截断、移除标签 |
| `bind-page` | 上游绑定入口，保留原生身份绑定链路，不与发现候选混用 |

本次没有浏览器视觉截图或真实设备暗色/窄屏测量；上述视觉结论是组件结构检查，自动化组件测试不能替代视觉验收。没有新 CLI 命令；API 使用共享 UUID 校验、revision 409、稳定业务码。另发现 paging 将 64-bit Atoi 直接转 int32，`offset=2147483648` 会变负并导致 DB 错误；应按现有非法输入 fallback 契约限制 int32 范围。

## ⑤ 分级处置与核心回归

A 类本次落地：来源记录专用 concurrent 列表索引及稳定 tie-break；分页 offset 越界按既有规则回退；关闭/折叠发现列表停止自动补页。核心断言：同时间记录跨页无重漏且隔离 route/workspace/status；超大 offset 不转负；关闭时迟到空页不继续请求，展开后正常继续。

保留的规模限制：run 缺失集历史读取、每行 badge 轮询、多页 refetch、每决策 DB 往返及无全局发现限流。后续优先按事件来源收窄扫描、批量加载 run badge、批量准备同页非授权元数据；这些内部优化必须保留定时补偿、当前可见结果和实时授权。永久水位线跳过可变 run 或停掉跨端撤销轮询会改变契约，不能混入本次 A 类修复。

B 类：本次不裁剪功能、不删历史表、不合并授权范围、不改交互或定时补偿承诺。若未来主张移除 badge/发现入口、降低刷新承诺或退役账本，须另带实际使用数据与行为影响交负责人批准。

### 修复后的执行计划

新增 `9065_labrastro_message_delivery_route_listing_index`，谓词为 **`autopilot_id IS NULL`**，键顺序为 workspace、route、created_at DESC、id DESC；`ListLabrastroMessageDeliveriesByRoute` 显式使用同一谓词。`471_labrastro_message_source_scope` 的约束使 run 账本必须有 autopilot_id，而普通来源、来源测试发送及遗留 source_scope 为空的诊断记录均无 autopilot_id，因此它们仍在列表和索引范围内。每条非 run 投递增加一次索引维护和磁盘占用，run 投递不增加索引条目。迁移 up/down 均为单条 concurrent DDL，纳入既有 invalid-index 清理机制；9065 尚未发布，本轮直接修正其定义，没有改写已发布迁移或回填账本。

首审前的 `route_id IS NOT NULL` 谓词不能实现这个范围：当前 run 和来源写入都带 route_id，旧谓词会把 run 条目也收进去；原脚本漏填 run 的 route_id，掩盖了额外成本。该 fixture 及原先“避免 run 索引维护”的结论已更正。以下为修正 fixture 后的复测数据，替代原先未反映生产 run 形态的索引成本结论。

| 同一 400,000 行 fixture 上的索引定义 | 收录总行数 | 其中 run 行 | 索引体积 |
| --- | --- | --- | --- |
| 原 `route_id IS NOT NULL` | 400,000 | 100,000 | 31,014,912 B（29.58 MiB） |
| 新 `autopilot_id IS NULL` | 300,000 | 0 | 23,265,280 B（22.19 MiB） |

收录行数由实际谓词计数，JSON 中另保留 ANALYZE 的 `estimated_entries`，不能混用估计值。这里 run 占 25%，因此减少 100,000 个无读者条目和约 25% 体积；审阅使用的 300,000 run + 100,000 来源比例不同，得到约 75% 节省，两组百分比不能直接比较。

| 查询 / 索引条件 | 执行时间 | 实际计划证据 |
| --- | --- | --- |
| 来源首页 / 无专用索引 | 164.767ms | Seq Scan 400,000 行、过滤 300,000、排序 100,000；12,430 local blocks |
| 来源首页 / 原谓词索引 | 0.331ms | Index Scan 100 行，无 Sort；104 local blocks |
| 来源首页 / 新谓词索引 | 0.470ms | Index Scan 100 行，无 Sort；104 local blocks |
| inbox 稳态 / 空窗口 | 0.398 / 0.091ms | 稳态读取 20 个来源候选；空窗口 0 行、3 local hit |
| activity 稳态 / 空窗口 | 0.451 / 0.143ms | 同上，时间部分索引过滤历史 |
| comment 稳态 / 空窗口 | 0.506 / 0.141ms | 同上 |
| 全部已决策的 run 补偿 | 633.001ms | 仍读取 100,000 run 与对应投递；本次没有优化此路径 |
| 空闲发送领单 | 0.051ms | queued 索引，无符合行，1 local hit |

三类来源首次/epoch 扫描仍为 462–545ms；activity/comment 的 hash anti join 产生 2,310 / 2,437 个临时写块。索引对照使用同一份当前 SQL（含 `autopilot_id IS NULL`），只切换临时索引，隔离索引范围的成本；不是两个版本 SQL 的端到端对比。各次缓存状态不一致，单次亚毫秒差异不证明延迟回退或加速，稳定证据是读取 100 行、104 blocks 且无 Sort。新列表索引对可选 status 仍需追加过滤，大 offset 也仍需先读取前面的索引条目。

复现：仓库依赖安装完成并通过 `make up` 获得已迁移的隔离数据库后，从仓库根目录执行 `node docs/engineering/evidence/ol1275-message-plans.mjs`，环境传入该库的 `DATABASE_URL`，stdout 为完整 JSON。脚本只在临时克隆表移除列表索引，依次测无索引、原谓词、新谓词；新定义直接读取 9065，因临时索引不支持 concurrent 而移除该关键字，其余 DDL 不变。复测原始 JSON 以 `ol1275-r1-message-plans.json` 随 OL-1275 回复附件保存。已应用本 PR 旧版 9065 的本地预览库须对该索引 down/up 后再检查新定义；本工作区已完成，生产未发布的迁移无需另造补丁版本。

### 验证与剩余工作

- 修复前已复现：同时间来源记录跨页顺序错误、offset 溢出、折叠后迟到空页继续发请求。修复后均通过对应回归。
- Go `messagedelivery` 与 `integrations/lark` 整包 race 测试、handler 的 Message/LarkDiscovery 定向 race 测试均通过。
- 迁移验证覆盖新索引 fresh/populated 的 up/down/up、历史来源扫描迁移及 catalog/recovery 一致性；行数保持不变。隔离开发库实际升级成功，sqlc 已重新生成。
- 首审修正复测：迁移用 1,000 条均带 route_id、其中 500 条有 autopilot_id 的记录断言索引仅收录 500 条；旧谓词明确变红，新谓词 up/down/up 通过。来源跨页回归加入普通记录、测试发送、遗留空 scope 诊断记录，均保持可见；MessageSourceRoutes/MessageDeliveries handler 定向 race 通过。前端未改，未重复首轮 476 项测试。
- Views 的 lark/message-delivery 共 31 文件、291 测试通过；Core 同范围共 11 文件、185 测试通过；Views typecheck、变更 hook/test 的 ESLint 与 diff whitespace 检查通过。
- 未运行全仓测试、浏览器 E2E 或真实飞书账号调用；UI 视觉与真实 provider 限流表现仍未验收。

有明确收益的后续项收录到项目常驻非阻断优化池 OL-1097：按事件来源减少无关全历史 run 扫描、批量徽标读取与精确缓存失效、批量准备同页非授权元数据。这些是后续优化，不将合成规模的单次读取消耗写成线上事故；优化时必须保留定时补偿和发送时实时授权。全局发现限流目前仅记录风险，尚无并发流量证据，不在本次增加限流产品策略。

## 附录：审视范围逐文件 Diff 清单

此表固定在审视起点，包含测试/契约，`+/-` 是相对上游行数。共享全局类型、i18n 及路由宿主的其他功能差异不冒算成 F17 独占。

| 文件 | +/- | 类型 |
| --- | --- | --- |
| `packages/core/api/labrastro-message-delivery-schemas.ts` | +519/-0 | 生产 |
| `packages/core/lark/queries.ts` | +180/-2 | 生产 |
| `packages/core/message-delivery/index.ts` | +37/-0 | 生产 |
| `packages/core/message-delivery/mutations.ts` | +133/-0 | 生产 |
| `packages/core/message-delivery/queries.ts` | +151/-0 | 生产 |
| `packages/core/message-delivery/source-mutations.ts` | +125/-0 | 生产 |
| `packages/core/message-delivery/source-queries.test.ts` | +26/-0 | 测试 |
| `packages/core/message-delivery/source-queries.ts` | +175/-0 | 生产 |
| `packages/core/message-delivery/source-routes-refresh.test.ts` | +71/-0 | 测试 |
| `packages/views/autopilots/components/autopilot-detail-page.tsx` | +109/-5 | 生产 |
| `packages/views/lark/discovery.test.ts` | +220/-0 | 测试 |
| `packages/views/lark/discovery.ts` | +257/-0 | 生产 |
| `packages/views/lark/index.ts` | +5/-0 | 生产 |
| `packages/views/lark/lark-anchor-picker.test.tsx` | +196/-0 | 测试 |
| `packages/views/lark/lark-anchor-picker.tsx` | +277/-0 | 生产 |
| `packages/views/lark/lark-chat-multi-select.test.tsx` | +144/-0 | 测试 |
| `packages/views/lark/lark-chat-multi-select.tsx` | +158/-0 | 生产 |
| `packages/views/lark/lark-chat-picker.test.tsx` | +289/-0 | 测试 |
| `packages/views/lark/lark-chat-picker.tsx` | +351/-0 | 生产 |
| `packages/views/lark/lark-private-chat-select.test.tsx` | +291/-0 | 测试 |
| `packages/views/lark/lark-private-chat-select.tsx` | +386/-0 | 生产 |
| `packages/views/lark/picker-common.tsx` | +140/-0 | 生产 |
| `packages/views/lark/review-ol74-partial-retry.test.tsx` | +45/-0 | 测试 |
| `packages/views/lark/review-ol74-retry.test.tsx` | +33/-0 | 测试 |
| `packages/views/lark/use-lark-discovery.ts` | +210/-0 | 生产 |
| `packages/views/message-delivery/components/catalog-refresh-and-draft.test.tsx` | +278/-0 | 测试 |
| `packages/views/message-delivery/components/detail-retry-gating.test.tsx` | +119/-0 | 测试 |
| `packages/views/message-delivery/components/detail-retry-submit-gate.test.tsx` | +199/-0 | 测试 |
| `packages/views/message-delivery/components/index.ts` | +8/-0 | 生产 |
| `packages/views/message-delivery/components/message-deliveries-pagination.test.tsx` | +113/-0 | 测试 |
| `packages/views/message-delivery/components/message-deliveries-section.test.tsx` | +438/-0 | 测试 |
| `packages/views/message-delivery/components/message-deliveries-section.tsx` | +709/-0 | 生产 |
| `packages/views/message-delivery/components/message-delivery-section.test.tsx` | +620/-0 | 测试 |
| `packages/views/message-delivery/components/message-delivery-section.tsx` | +569/-0 | 生产 |
| `packages/views/message-delivery/components/personal-push-section.test.tsx` | +306/-0 | 测试 |
| `packages/views/message-delivery/components/personal-push-section.tsx` | +173/-0 | 生产 |
| `packages/views/message-delivery/components/review-ol74-fallback.test.tsx` | +64/-0 | 测试 |
| `packages/views/message-delivery/components/route-deliveries-dialog.test.tsx` | +464/-0 | 测试 |
| `packages/views/message-delivery/components/route-deliveries-dialog.tsx` | +618/-0 | 生产 |
| `packages/views/message-delivery/components/route-editor-dialog.tsx` | +549/-0 | 生产 |
| `packages/views/message-delivery/components/routes-refresh-write-block.test.tsx` | +207/-0 | 测试 |
| `packages/views/message-delivery/components/run-deliveries-dialog.test.tsx` | +128/-0 | 测试 |
| `packages/views/message-delivery/components/run-deliveries-dialog.tsx` | +137/-0 | 生产 |
| `packages/views/message-delivery/components/run-delivery-badges.test.tsx` | +168/-0 | 测试 |
| `packages/views/message-delivery/components/run-delivery-badges.tsx` | +108/-0 | 生产 |
| `packages/views/message-delivery/components/source-route-editor-dialog.test.tsx` | +643/-0 | 测试 |
| `packages/views/message-delivery/components/source-route-editor-dialog.tsx` | +734/-0 | 生产 |
| `packages/views/message-delivery/components/source-route-row.test.tsx` | +215/-0 | 测试 |
| `packages/views/message-delivery/components/source-route-row.tsx` | +281/-0 | 生产 |
| `packages/views/message-delivery/components/team-section-request-errors.test.tsx` | +256/-0 | 测试 |
| `packages/views/message-delivery/components/team-subscriptions-section.test.tsx` | +402/-0 | 测试 |
| `packages/views/message-delivery/components/team-subscriptions-section.tsx` | +397/-0 | 生产 |
| `packages/views/message-delivery/copy.test.ts` | +278/-0 | 测试 |
| `packages/views/message-delivery/copy.ts` | +335/-0 | 生产 |
| `packages/views/message-delivery/index.ts` | +24/-0 | 生产 |
| `packages/views/message-delivery/status-visual.ts` | +38/-0 | 生产 |
| `packages/views/message-delivery/target-selection.test.ts` | +33/-0 | 测试 |
| `packages/views/message-delivery/target-selection.ts` | +40/-0 | 生产 |
| `server/cmd/server/labrastro_messaging.go` | +56/-0 | 生产 |
| `server/internal/autopilotauth/auth.go` | +42/-0 | 生产 |
| `server/internal/handler/autopilot.go` | +8/-8 | 生产 |
| `server/internal/handler/labrastro_message_delivery.go` | +538/-0 | 生产 |
| `server/internal/handler/labrastro_message_routes.go` | +51/-0 | 生产 |
| `server/internal/handler/labrastro_message_sources.go` | +627/-0 | 生产 |
| `server/internal/handler/lark_private_chat_discovery.go` | +246/-0 | 生产 |
| `server/internal/handler/lark_target_discovery.go` | +264/-0 | 生产 |
| `server/internal/integrations/lark/labrastro_delivery.go` | +426/-0 | 生产 |
| `server/internal/integrations/lark/target_discovery.go` | +258/-0 | 生产 |
| `server/internal/messagedelivery/FEEDBACK-CONTRACT.md` | +206/-0 | 契约 |
| `server/internal/messagedelivery/PRIVATE-CHAT-DISCOVERY-CONTRACT.md` | +236/-0 | 契约 |
| `server/internal/messagedelivery/README.md` | +925/-0 | 契约 |
| `server/internal/messagedelivery/REPAIR-CONTRACT-v1.md` | +92/-0 | 契约 |
| `server/internal/messagedelivery/REPAIR-CONTRACT.md` | +128/-0 | 契约 |
| `server/internal/messagedelivery/SCANNING.md` | +102/-0 | 契约 |
| `server/internal/messagedelivery/TARGET-DISCOVERY-CONTRACT.md` | +197/-0 | 契约 |
| `server/internal/messagedelivery/UPSTREAM-ADAPTATION.md` | +27/-0 | 契约 |
| `server/internal/messagedelivery/authorization.go` | +89/-0 | 生产 |
| `server/internal/messagedelivery/content.go` | +194/-0 | 生产 |
| `server/internal/messagedelivery/content_test.go` | +245/-0 | 测试 |
| `server/internal/messagedelivery/decisions.go` | +152/-0 | 生产 |
| `server/internal/messagedelivery/deliveries.go` | +533/-0 | 生产 |
| `server/internal/messagedelivery/delivery_boundary_matrix_test.go` | +337/-0 | 测试 |
| `server/internal/messagedelivery/delivery_contract_regressions_test.go` | +369/-0 | 测试 |
| `server/internal/messagedelivery/delivery_db_test.go` | +417/-0 | 测试 |
| `server/internal/messagedelivery/delivery_decide_db_test.go` | +757/-0 | 测试 |
| `server/internal/messagedelivery/delivery_rereview_regressions_test.go` | +414/-0 | 测试 |
| `server/internal/messagedelivery/delivery_review_regressions_test.go` | +460/-0 | 测试 |
| `server/internal/messagedelivery/events.go` | +21/-0 | 生产 |
| `server/internal/messagedelivery/events_test.go` | +56/-0 | 测试 |
| `server/internal/messagedelivery/gates.go` | +394/-0 | 生产 |
| `server/internal/messagedelivery/lifecycle/cleanup.go` | +83/-0 | 生产 |
| `server/internal/messagedelivery/lifecycle_cleanup_db_test.go` | +286/-0 | 测试 |
| `server/internal/messagedelivery/message.go` | +23/-0 | 生产 |
| `server/internal/messagedelivery/message_delivery_test.go` | +102/-0 | 测试 |
| `server/internal/messagedelivery/ports.go` | +135/-0 | 生产 |
| `server/internal/messagedelivery/reliability_test.go` | +547/-0 | 测试 |
| `server/internal/messagedelivery/review_ol27_test.go` | +277/-0 | 测试 |
| `server/internal/messagedelivery/routes.go` | +143/-0 | 生产 |
| `server/internal/messagedelivery/run_route_contract_test.go` | +403/-0 | 测试 |
| `server/internal/messagedelivery/scan_performance_test.go` | +329/-0 | 测试 |
| `server/internal/messagedelivery/scan_visibility_db_test.go` | +92/-0 | 测试 |
| `server/internal/messagedelivery/scan_warnings.go` | +26/-0 | 生产 |
| `server/internal/messagedelivery/scan_warnings_test.go` | +36/-0 | 测试 |
| `server/internal/messagedelivery/service.go` | +701/-0 | 生产 |
| `server/internal/messagedelivery/source_contract_test.go` | +552/-0 | 测试 |
| `server/internal/messagedelivery/source_decide.go` | +448/-0 | 生产 |
| `server/internal/messagedelivery/source_delivery_db_test.go` | +726/-0 | 测试 |
| `server/internal/messagedelivery/sources.go` | +492/-0 | 生产 |
| `server/internal/messagedelivery/types.go` | +468/-0 | 生产 |
| `server/internal/messagedelivery/worker.go` | +663/-0 | 生产 |
| `server/internal/service/autopilot.go` | +41/-11 | 生产 |
| `server/internal/service/autopilot_quota.go` | +35/-6 | 生产 |
| `server/internal/service/autopilot_quota_notifications.go` | +1/-1 | 生产 |
| `server/pkg/db/generated/labrastro_message.sql.go` | +3948/-0 | 生成 |
| `server/pkg/db/queries/labrastro_message.sql` | +1057/-0 | 生产 |

### 历史迁移闭包

工单列出的 7 个 stem 已在正文逐一审视；下列其余 stem 为不可省略的建表/约束/索引/退役依赖。每个 stem 均包含 up/down，不能用数字前缀替代完整标识。

| stem | up 的操作 |
| --- | --- |
| `452_labrastro_message_tables` | `CREATE TABLE labrastro_message_route`；`CREATE TABLE labrastro_message_delivery`；`CREATE TABLE labrastro_message_receipt` |
| `453_labrastro_message_route_identity_index` | `CREATE UNIQUE INDEX CONCURRENTLY uq_labrastro_message_route_identity` |
| `454_labrastro_message_delivery_dedup_index` | `CREATE UNIQUE INDEX CONCURRENTLY uq_labrastro_message_delivery_dedup` |
| `455_labrastro_message_delivery_queue_index` | `CREATE INDEX CONCURRENTLY idx_labrastro_message_delivery_queue` |
| `456_labrastro_message_delivery_listing_index` | `CREATE INDEX CONCURRENTLY idx_labrastro_message_delivery_listing` |
| `457_labrastro_message_receipt_shard_index` | `CREATE UNIQUE INDEX CONCURRENTLY uq_labrastro_message_receipt_shard` |
| `458_labrastro_message_receipt_external_index` | `CREATE UNIQUE INDEX CONCURRENTLY uq_labrastro_message_receipt_external` |
| `459_labrastro_message_approved_target` | `CREATE TABLE labrastro_message_approved_target` |
| `460_labrastro_message_approved_target_active_index` | `CREATE UNIQUE INDEX CONCURRENTLY uq_labrastro_message_approved_target_active` |
| `461_labrastro_message_scan_cursor` | `CREATE TABLE labrastro_message_scan_cursor` |
| `463_labrastro_message_repair_state` | `ALTER TABLE labrastro_message_scan_cursor`；`ALTER TABLE labrastro_message_delivery` |
| `467_labrastro_message_sources` | `ALTER TABLE labrastro_message_route`；`ALTER TABLE labrastro_message_delivery`；`ALTER TABLE labrastro_message_approved_target` |
| `468_labrastro_message_route_source_identity_index` | `CREATE UNIQUE INDEX CONCURRENTLY uq_labrastro_message_route_source_identity` |
| `469_labrastro_message_delivery_source_index` | `CREATE INDEX CONCURRENTLY idx_labrastro_message_delivery_source` |
| `470_labrastro_message_approved_target_source_active_index` | `CREATE UNIQUE INDEX CONCURRENTLY uq_labrastro_message_approved_target_source_active` |
| `471_labrastro_message_source_scope` | `ALTER TABLE labrastro_message_delivery`；`ALTER TABLE labrastro_message_approved_target`；`ALTER TABLE labrastro_message_route`；`UPDATE labrastro_message_delivery`；`UPDATE labrastro_message_approved_target`；`UPDATE labrastro_message_route` |
| `472_labrastro_message_drop_preview_approval_index` | `DROP INDEX uq_labrastro_message_approved_target_source_active` |
| `473_labrastro_message_project_approval_index` | `CREATE UNIQUE INDEX CONCURRENTLY uq_labrastro_message_approved_target_project_active` |
| `474_labrastro_message_feedback` | `CREATE TABLE labrastro_message_feedback` |
| `475_labrastro_message_feedback_identity_index` | `CREATE UNIQUE INDEX CONCURRENTLY uq_labrastro_message_feedback_identity` |
| `476_labrastro_message_feedback_pending_index` | `CREATE INDEX CONCURRENTLY idx_labrastro_message_feedback_pending` |
| `477_labrastro_message_feedback_comment_index` | `CREATE INDEX CONCURRENTLY idx_labrastro_message_feedback_comment` |
| `478_labrastro_feedback_retirement` | `ALTER TABLE labrastro_message_feedback`；`UPDATE labrastro_message_feedback` |
| `9010_labrastro_message_delivery_run_index` | `CREATE INDEX CONCURRENTLY idx_labrastro_message_delivery_run` |
| `9011_labrastro_message_delivery_sending_index` | `CREATE INDEX CONCURRENTLY idx_labrastro_message_delivery_sending` |
| `9012_labrastro_message_inbox_scan_index` | `CREATE INDEX CONCURRENTLY idx_labrastro_message_inbox_scan` |
| `9013_labrastro_message_activity_scan_index` | `CREATE INDEX CONCURRENTLY idx_labrastro_message_activity_scan` |
| `9014_labrastro_message_comment_scan_index` | `CREATE INDEX CONCURRENTLY idx_labrastro_message_comment_scan` |
| `9015_labrastro_message_source_watermark` | `ALTER TABLE labrastro_message_scan_cursor`；`UPDATE labrastro_message_scan_cursor` |

### 69 条 SQL 的逐条审视归类

以下均位于 `server/pkg/db/queries/labrastro_message.sql`；具体锁和性能判断见正文，标记“实测”的查询保留完整 EXPLAIN 证据。其他查询是索引/谓词/事务静态推演，未伪称逐条压测。

| 查询 | 审视归类 |
| --- | --- |
| `CreateLabrastroMessageRoute` | 规则读写；PK/workspace/revision 与身份唯一索引 |
| `GetLabrastroMessageRoute` | 规则读写；PK/workspace/revision 与身份唯一索引 |
| `ListLabrastroMessageRoutesByAutopilot` | 规则读写；PK/workspace/revision 与身份唯一索引 |
| `UpdateLabrastroMessageRoute` | 规则读写；PK/workspace/revision 与身份唯一索引 |
| `SetLabrastroMessageRouteEnabled` | 规则读写；PK/workspace/revision 与身份唯一索引 |
| `DeleteLabrastroMessageRoute` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `CreateLabrastroMessageDelivery` | dedup_key 唯一索引 ON CONFLICT；冻结决策 |
| `GetLabrastroMessageDelivery` | 单 delivery PK/lease/status 守卫；终态写或人工重试 |
| `ClaimDueLabrastroMessageDelivery` | 实测；见 EXPLAIN 场景 |
| `RetryClaimedLabrastroMessageDelivery` | 单 delivery PK/lease/status 守卫；终态写或人工重试 |
| `CompleteClaimedLabrastroMessageDelivery` | 单 delivery PK/lease/status 守卫；终态写或人工重试 |
| `FailClaimedLabrastroMessageDelivery` | 单 delivery PK/lease/status 守卫；终态写或人工重试 |
| `CancelClaimedLabrastroMessageDelivery` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `UncertainClaimedLabrastroMessageDelivery` | 单 delivery PK/lease/status 守卫；终态写或人工重试 |
| `RequeueExpiredLabrastroMessageDeliveryClaims` | sending 部分索引；过期状态变 uncertain |
| `SetLabrastroMessageDeliveryOutcome` | 单 delivery PK/lease/status 守卫；终态写或人工重试 |
| `ClaimLabrastroMessageDeliveryByID` | 单 delivery PK/lease/status 守卫；终态写或人工重试 |
| `RetryLabrastroMessageDeliveryManually` | 单 delivery PK/lease/status 守卫；终态写或人工重试 |
| `CancelLabrastroMessageDeliveriesByRoute` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `CancelLabrastroMessageDeliveriesByInstallation` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `ListLabrastroMessageDeliveriesByAutopilot` | 投影分页；workspace/autopilot/time 列表索引；run/status 追加过滤 |
| `ClaimLabrastroMessageReceipt` | 分片唯一身份/主键/投递 ID 范围 |
| `RecordLabrastroMessageReceiptExternalID` | 分片唯一身份/主键/投递 ID 范围 |
| `ListLabrastroMessageReceiptsByDelivery` | 分片唯一身份/主键/投递 ID 范围 |
| `LockWorkspaceForMessageDecision` | 短父资源锁；主键或 runtime 所属安装集合 |
| `GetLabrastroMessageDeliveryLease` | 单 delivery PK/lease/status 守卫；终态写或人工重试 |
| `ListLabrastroMessageDeliveryCandidateRoutes` | 实测；见 EXPLAIN 场景 |
| `ListStaleRunOnlyAutopilotTasks` | run 修复；active run + ID 范围，回源既有 sync |
| `ListStaleCreateIssueAutopilotIssues` | run 修复；active run + ID 范围，回源既有 sync |
| `GetChannelUserBindingForDelivery` | workspace/installation/member 范围解析绑定，JOIN 活跃 installation 与现存成员；每候选往返见正文 |
| `DeleteLabrastroMessageReceiptsByWorkspace` | 低频 workspace 范围清理；现有 shard/external 唯一索引不覆盖 workspace，可全扫 receipt；保持撤销事务原子性 |
| `DeleteLabrastroMessageDeliveriesByWorkspace` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `DeleteLabrastroMessageRoutesByWorkspace` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `ApproveLabrastroMessageTarget` | 授权范围；active 部分索引/主键，project null 等价需过滤 |
| `RevokeLabrastroMessageTarget` | 授权范围；active 部分索引/主键，project null 等价需过滤 |
| `GetActiveLabrastroMessageApprovedTarget` | 授权范围；active 部分索引/主键，project null 等价需过滤 |
| `ListLabrastroMessageApprovedTargets` | 授权范围；active 部分索引/主键，project null 等价需过滤 |
| `DeleteLabrastroMessageApprovedTargetsByAutopilot` | 授权范围；active 部分索引/主键，project null 等价需过滤 |
| `DeleteLabrastroMessageApprovedTargetsByInstallation` | 授权范围；active 部分索引/主键，project null 等价需过滤 |
| `DeleteLabrastroMessageApprovedTargetsByWorkspace` | 授权范围；active 部分索引/主键，project null 等价需过滤 |
| `GetLabrastroMessageScanCursor` | 水位线/ID 上界/PK CAS；无来源正文读取 |
| `SaveLabrastroMessageScanCursor` | 水位线/ID 上界/PK CAS；无来源正文读取 |
| `InitLabrastroMessageScanCursor` | 水位线/ID 上界/PK CAS；无来源正文读取 |
| `GetLabrastroMessageSourceScanHorizon` | 水位线/ID 上界/PK CAS；无来源正文读取 |
| `ListStaleLinkedIssueTaskFailures` | run 修复；active run + ID 范围，回源既有 sync |
| `CancelLabrastroMessageDeliveriesByTarget` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `GetLabrastroMessageScanUpperBound` | 水位线/ID 上界/PK CAS；无来源正文读取 |
| `LockLabrastroMessageInstallation` | 短父资源锁；主键或 runtime 所属安装集合 |
| `CancelLabrastroMessageDeliveriesByAutopilot` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `DisableLabrastroMessageRoutesByInstallation` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `LockLabrastroMessageRuntimeInstallations` | 短父资源锁；主键或 runtime 所属安装集合 |
| `ListLabrastroMessageSourceRoutes` | 规则读写；PK/workspace/revision 与身份唯一索引 |
| `ListLabrastroMessageInboxSourceCandidates` | 实测；见 EXPLAIN 场景 |
| `ListLabrastroMessageActivitySourceCandidates` | 实测；见 EXPLAIN 场景 |
| `ListLabrastroMessageCommentSourceCandidates` | 实测；见 EXPLAIN 场景 |
| `GetLabrastroMessageSourceScanUpperBound` | 水位线/ID 上界/PK CAS；无来源正文读取 |
| `ListLabrastroMessageDeliveriesByRoute` | 实测；见 EXPLAIN 场景 |
| `ApproveLabrastroMessageSourceTarget` | 授权范围；active 部分索引/主键，project null 等价需过滤 |
| `GetActiveLabrastroMessageSourceApprovedTarget` | 授权范围；active 部分索引/主键，project null 等价需过滤 |
| `ListLabrastroMessageSourceApprovedTargets` | 授权范围；active 部分索引/主键，project null 等价需过滤 |
| `RevokeLabrastroMessageSourceTarget` | 授权范围；active 部分索引/主键，project null 等价需过滤 |
| `CancelLabrastroMessageDeliveriesBySourceTarget` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `RevokeLabrastroMessageSourceTargetsByProject` | 授权范围；active 部分索引/主键，project null 等价需过滤 |
| `DisableLabrastroMessageSourceRoutesByProject` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `CancelLabrastroMessageDeliveriesByProject` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `DisableLabrastroMessagePersonalRoutesByUser` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `CancelLabrastroMessageDeliveriesByPersonalRecipient` | 低频生命周期批量写；保留事务原子性；workspace/资源范围过滤 |
| `LockLabrastroMessageRoute` | 短父资源锁；主键或 runtime 所属安装集合 |
| `LockLabrastroMessageSourceProject` | 短父资源锁；主键或 runtime 所属安装集合 |
