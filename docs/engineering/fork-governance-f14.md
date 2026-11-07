# F14：动态推理强度治理评估（OL-1269）

审计日期：2026-11-07。基线为上游 v0.8.1 提交 `b1ea927def6490c43bedff537b6f4ed9a47fa828`，被审计的 origin/main 固定为 `5ce6fa84433928b44ceebcd150b666270ed61e2d`。结论来自两个提交之间的源码 diff、生产调用点、现有契约及本地测试；不把旧文档中的线上延迟或模型质量数据当作本次实测。

结论：保留现有自适应功能。命名很多，但不是七套互相竞争的决策器；它们组成同一条调用链。发现一项可直接落地的 A 类启动开销缺陷：Claude 运行级选档后，逐步插件安装重复发现模型目录，并使用独立于任务取消的 Background context。修复方向是复用本次运行已经验证的候选集合。未发现支持删除整套模块的证据。

## ① 必要性及与上游重叠

上游基线已有 `095_agent_thinking_level.up.sql`、Agent API 字段、模型目录、选择器和 CLI/ACP 注入。它解决静态选择；本 Fork 在同一字段增加 `_adapt`，复用原有注入机制。没有第二个持久化配置字段。`auto` 仍是部分 CLI 的原生值，不等于 `_adapt`。

| 模块 | 实际入口与作用 | 重叠/处置 |
|---|---|---|
| `thinking_adapt.go` | `resolveTaskModelSelection` → 候选筛选、构造运行摘要、调用 Jev、记录元数据 | 动态选择为 Fork 增量；复用上游配置与注入，保留 |
| `thinking_step*.go` | Claude 插件的 task-scoped HTTP endpoint、启停标记、逐步错误窗口和结果关联 | 同一客户端的步级调用，不是第二种策略；保留 |
| `effortmod/*` | daemon 安装嵌入插件；`session.start` / `turn.step` 上传上步材料、显式应用挡位 | Claude 适配层，运行级选择不能替代；保留 |
| `jev/*` | daemon 创建一个 Client；Decide 和 Evaluate 共用 source selection/transport/breaker | 决策与业务评分共用基础设施；保留 |
| `jevprobe.go` | daemon 的分钟 tick 读取计数，使用过后空闲 10 分钟才 Probe | 维护 UI 健康状态，不参与启动选档；保留 |
| `jevsample/*` | `MULTICA_JEV_COLLECT_DIR` 非空才创建 collector，决策和终态入队 | 默认关闭的训练数据设施，有明确消费契约；不是死代码 |
| `labrastro_effort.go` | Claude stream reader 的 `consumeEffortLog` → OnEffortEffect | 反映真正生效的挡位，避免 UI 只显示建议值；保留 |
| `cmd_jev.go` / `jev_evaluate.go` | 用户在运行中显式执行 `multica jev evaluate` | 通用业务评分；**不是每个任务启动前必跑的评测** |
| `thinking_fixtures.go` / evaluation tests | fixture 导出、离线一致性测试、显式门控的 live 评测 | 评测支撑，非线上选档链；未据此删除公开评测入口 |

配置优先级与呈现：

1. 空值跟随 CLI 配置；固定值按原有模型能力校验并注入，不访问 Jev。固定值遇到无法验证的目录按上游规则透传，明确不支持则清除并报告。
2. `_adapt` 只从当前模型的已验证目录选档，去掉 auto/off/none/disabled、非法值和重复值。至少两档才调用 Jev，保留 max/ultra。运行级失败不注入挡位；不会把 `_adapt` 传给 CLI。
3. Claude ≥ 2.1.304、候选足够且 `_adapt` 时安装逐步插件；收到 `per_turn_effort_active` 后启用。首步沿用启动结果，后续步成功才改档；失败沿用上一步，撤销后停止请求并锁定最后挡位。运行级 Jev 回退但有候选时仍允许步级恢复。
4. 旧 daemon 不声明 `thinking-adapt-v1` 时，服务端 claim 清空保留值；UI 根据能力位禁用选项并提示升级。Claude 自定义参数中的重复 `--effort` 被过滤，避免抢占属性配置。
5. UI 区分"跟随 CLI 配置 / 固定挡位 / 自适应"；运行状态处显示实际挡位，结束后 transcript 汇总保留。三处挂载是 chat 状态、issue run card、transcript header，而不是逐条消息新增组件。

使用频率、节省 token 比例、模型选择准确率没有本次运行遥测支撑，不能宣称"低频所以应下线"或"必然节约成本"。既有契约 D1–D4、E1–E3 已确认自适应、外发说明、徽标和本机采样方向；本次不重新替负责人作产品取舍。

## ② 架构侵入与最小收敛

任务列出的直接范围（含 `thinking*.go` 测试）共 37 个 diff 文件，增加 9,283 行、删除 1 行。逐文件数字与职责见文末清单；该数字不是全功能总量，跨层集成另列。尤其不能把整个 `daemon.go` 的 Fork 差异都算作 F14。

扩展调用链清单见同目录 `fork-governance-f14-inventory.tsv`：共 **124 个变更文件**，其中后端/daemon/CLI 及测试语料资源 75 个、前端及测试/配置/语言资源 47 个、迁移 up/down 2 个（1 个 migration stem）。前端 47 个中 9 个是测试，后端组含 29 个 Go 测试文件。清单由直接范围、F14 独有符号在 diff 中的出现，以及补充的 metadata 存储/协议/fixture 支撑文件组成；TSV 的增删行数是共享文件的完整 diff，不能相加冒充 F14 独占代码量。未变更但被依赖的 runtime SQL、host metrics tracker/query 等只作边界检查，不计入变更文件数。训练工具/部署资料不属于本次运行时源码清单。

"数据库迁移：无"需要修正：配置复用上游 `agent.thinking_level`，但持久化实际挡位依赖 Fork 的 **`9029_labrastro_task_message_metadata.up.sql` / `.down.sql`**，新增 nullable JSONB 列，没有新表、新索引或 FK。此迁移也承载通用消息元数据，不能因裁剪自适应而直接回滚。

关键侵入点：

| 文件/边界 | F14 增量及判断 |
|---|---|
| `server/internal/daemon/daemon.go` | 创建共享 Jev/collector/prober；heartbeat 附快照；模型选择、插件安装、消息标记与终态采样。保持已有执行入口；此次只改候选传递 |
| `server/internal/daemon/config.go`, `client.go`, `health.go` | 环境配置、claim/heartbeat 数据、两个本机 task endpoint；无新后台数据库轮询 |
| `server/internal/daemon/wakeup.go`, `server/cmd/server/router.go`, `server/cmd/multica/main.go` | WS heartbeat 携带快照、Redis store 注入、jev 命令注册；都有真实入口 |
| `server/internal/daemon/jev_evaluate.go` | 鉴权、限制输入、10 秒评分预算；复用 Jev Client |
| `server/pkg/agent/thinking.go`, `agent.go`, `claude.go` | 保留值、候选和回调；CLI 协议解析处消费效果记录，不另起执行引擎 |
| `server/internal/handler/agent.go`, `daemon.go`, `runtime.go`, `handler.go` | 创建/更新校验、旧 daemon 门控、消息元数据、Redis 快照装配；未增加逐机器 SQL |
| `server/internal/handler/task_message_metadata.go` | 元数据最多 4 KiB，坏数据丢字段，不拒绝消息批次；清理 NUL/数值指数，避免 JSONB 拒绝整批 |
| `server/pkg/protocol/messages.go`, `quota.go` | 能力位、heartbeat/snapshot 字段；只含名称与计数，不包含业务 state |
| `server/pkg/db/queries/task_message.sql` 及生成代码 | 现有消息写/读携带 metadata；没有 metadata 查询谓词 |
| `packages/core/agents/{draft,builder-protocol,index}.ts` | 创建默认值、切换运行时/模型时处理保留值，复用原字段 |
| `packages/core/types/{agent,events}.ts`, API schemas | 快照和消息 metadata 的兼容解析；未知状态/字段回退，不让老响应阻断界面 |
| `packages/views/agents/create/agent-configuration-panel.tsx`, `agents/components/{agent-detail-inspector,agent-profile-card}.tsx`, `inspector/thinking-picker.tsx` | 现有属性控件扩展，不新建配置页 |
| `packages/core/chat/thinking-level.ts`, `packages/views/common/thinking-level-badge.tsx` 及三个挂载面 | 从原始消息提取/去重/汇总实际挡位；无额外 API |
| `packages/views/runtimes/components/runtime-quota-cell.tsx`, `common/thinking-adapt.ts` | 同一份机器快照在 runtime rows 展示；使用语义色和文案回退 |
| `packages/core/runtimes/queries.ts`, `realtime/use-realtime-sync.ts` | 复用 runtime 查询与 telemetry 通道；现有 host metrics 的轮询不是 F14 单独新增的轮询 |

确定的 A 类修复：将本次运行候选保存在 `thinkingRun`，逐步安装直接使用。每次启动的目录读取由两次变一次，消除第二次可能长达 30 秒且不随任务取消的发现调用，候选来源也保持一致。不新增缓存、锁、服务、接口或迁移。与之关联的安装测试不再在 `t.Parallel()` 内篡改全局 `listModels`。

没有依据把 effortmod 的 TS、Go HTTP handler 和 stream parser 合成一个模块：它们处于不同进程边界。Jev transport 已共用，无须再加"统一调档管理器"。

## ③ SQL、后端与 daemon 性能

### SQL 逐项审视（执行计划推演，非生产 EXPLAIN 实测）

本次不连接生产数据库。没有生产基数/统计信息，下面只给出 SQL 结构和已有索引支持的计划形态；不能据此报告生产毫秒数或 buffer 命中率。

| SQL/存储操作 | 范围、计划形态与风险 |
|---|---|
| `CreateTaskMessage` | 单行 INSERT，metadata 是额外 JSONB 值；没有 join/CTE/全表搜索 |
| `CreateTaskMessages` | `incoming` 对本批参数做 ProjectSet/unnest；`inserted` 批量 INSERT，PK conflict 去重，最后只排序 RETURNING 的本批行。复杂度随批次 n 增长，排序 O(n log n)；CTE 不扫描历史表，不存在 OL-1263 那种先聚合全库再筛选的漏剪枝。metadata 增加 JSONB 解析/WAL/存储，但不增加事务数 |
| `ListTaskMessages` | `WHERE task_id=$1 ORDER BY seq` 可走 `idx_task_message_task_id_seq`；无分页的全运行读取仍随消息量增长，metadata 增大传输体积，这是既有 transcript 路径 |
| `ListTaskMessagesSince` | 同一复合索引，task_id 等值 + seq 范围，可顺序返回增量 |
| `ListTaskProgressSince` | 同一索引范围后按 type 过滤；未选择 metadata，F14 没增加该投影成本 |
| `DeleteTaskMessages` | task_id 索引定位；无 F14 额外删除链 |
| `ListAgentRuntimes`, `ListAgentRuntimesByOwner`, `ListVisibleAgentRuntimes` | 均先限定 workspace；`idx_agent_runtime_workspace` 可定位，再对本工作区做 owner/visibility 过滤及 created_at 排序。小表可能合理使用顺序扫描。快照不在 SQL 内 join，无 N+1 SQL |
| claim / Agent CRUD | 复用 agent 原 thinking_level、已经读取的 issue 描述；ACP eligibility 用 cachedModelCatalog。F14 不在每次选档时访问数据库 |
| `9029_labrastro_task_message_metadata` | nullable ADD COLUMN 无默认值，不需回填；DDL 仍需表锁。现有 released migration 保留，本 PR 不执行也不修改它 |

Redis 每次携带快照的 heartbeat 执行一次 Lua GET/比较/SET EX 90。相等时间戳续期、旧时间戳拒绝；不再落 DB。runtime 列表按 daemon 去重，一次 pipeline 发 D 个 GET（**不是单条 MGET**），D 为列表机器数。无 Redis 时返回空状态。写入是 heartbeat 的同步前置步骤，失败被吞掉但等待仍受 Redis 客户端/请求预算影响，不能称为完全零延迟。Lua 数字比较 Unix 纳秒在浮点下可能合并极近时间戳，但实际快照以毫秒/秒变化；未为这一理论边界增加协议复杂度。

### 启动、超时和失败边界

| 路径 | 调用和预算 |
|---|---|
| 非自适应 | 无 Jev；固定级别仍可能走上游已有目录校验 |
| 运行级自适应 | 目录发现 + 顺序 N 个来源，每源默认 1,500ms；故网络等待默认上界约 N×1.5s（受父 context 更早取消约束），不是全链路固定 1.5s。成功缓存命中时目录调用通常便宜；失败/空目录不缓存，所以重复发现是实际退化路径 |
| Claude 插件安装 | 修复前再次 listModels，Background + 30s；修复后不做目录发现 |
| Claude 后续步骤 | mod 的 Promise.race 最多等 2s；daemon 决策 context 5s。多源慢响应可在 mod 已沿用旧挡位后继续到 daemon deadline；Promise.race 不取消底层请求。默认一个来源通常落在 2s 内，多源时两层预算不一致仍是局限 |
| `jev evaluate` | 手工调用；CLI 11s、daemon 10s、每源独立超时；输入读/解析先于网络预算。与选档共用客户端和熔断计数，评分故障会影响后续调档健康状态 |
| 熔断 | 连续三次全来源失败 → 60s 直接回退 → 单个 half-open trial。caller 取消不计源失败，取消的 half-open 归还试探资格；不会重试无数次 |
| 探针 | 1min 内存 tick；真实计数增长后闲置 10min 才发一次，最多每 10min 一次；不更新决策计数、不占 half-open slot。不在 task startup 串行执行 |

`MULTICA_JEV_TIMEOUT_MS` 可配置；当前只做整数解析，非正值由 Client 回默认值，极大值未做显式范围校验。因此"所有配置都有统一小延迟上界"不成立。多源预算、timeout 配置约束、Evaluate 是否拆熔断属于后续需按兼容契约分别验证的事项；本次不擅自改变已部署的 timeout 语义或评分能力。

采样关闭时 collector 为 nil，无文件/写协程。开启后 256 队列、单写协程、满队列丢弃、目录 0700/文件 0600、按 daemon/profile/UTC 日轮转、默认累计 1GiB 上限、按原因每分钟节流告警。每条写入先 `sizeOnDisk()` 扫目录并 stat 匹配文件，成本 O(历史文件数)；长会话的 step outcome map O(步骤数)，终态排序 O(S log S)。mod 每步读取整个 session.messages 再 slice，本地材料解析可能随会话增长；`fitRequest` 会反复 stringify。它们是有真实入口的可选采样/插件成本，不能误报为死代码或默认后台重负载。本次没有宿主机采样授权，不启用采样、不训练、不调用真实模型。

## ④ 前端与 CLI/API 体验

以下为源码、组件测试层面的审视，不冒充浏览器截图或真实长列表性能测量。

| 组件/查询 | 结论与边界 |
|---|---|
| core/view 的两个 `thinking-adapt.ts` | 纯候选/能力和标签函数；不创建 Query、定时器、store 或副作用 |
| `ThinkingPicker` | 至少两候选才显示选项；能力不足禁用并给升级说明；null snapshot 显示未知状态。窄栏 trigger `min-w-0 truncate`、popover 有最小宽度/最大宽度，描述换行；使用语义主题色。字段选择复用现有异步保存，并非新增独立保存流程 |
| Agent create / inspector / profile | 展示持久化模式，runtime/model 切换走原有 draft/update 规则；不把健康状态误写回持久配置。API 非 ACP provider 接受模式后，最终候选检查在 daemon；UI 与 API 校验位置不同，但执行会安全回退 |
| `ThinkingAdaptQuotaRow` | available 显示来源/延迟，否则状态；数量在 tooltip。没有快照时不伪造可用；状态颜色有文本伴随，暗色依赖共享 token |
| `ThinkingLevelBadge` / summary | useMemo 依赖原始 messages；取样先 O(M) 扫描，标签排序 O(K log K) 再按 step 去重。新消息数组会重算，长运行非 O(1)；summary tooltip 一次渲染全部步骤，尚无虚拟化。静态代码不能证明大规模无卡顿 |
| runtime Query / WS | key 带 wsId；host stats 存在时 30s 轮询，无样本 60s，聚焦时运行。telemetry 只 invalidate runtime 前缀（含其 quota-sources），不失效 agent/squad。server 每 machine/stream 最多 15s 发布一次，client 前缀 debounce 100ms；多机器错峰事件仍可放大列表重取，不等于工作区全局每15s一次 |
| 多语言/可访问性 | 五套 thinking/fork-ui/quota 语言资源可达，trend 有 sr-only 文案。非交互 span tooltip 的键盘可达性及窄屏真实溢出仍需浏览器验证；本次不调整 UI 交互 |

CLI 顺序为 output 格式 → daemon port/token/task UUID → 文件/标准输入 → 64KiB payload/schema → 本机请求。未知 transport 字段、尾随 JSON、非 score、问题数不在 1–16、criteria 不在 2–32 均在外发前拒绝；不能通过 payload 指定 endpoint/key/model。401/403/404 给运行上下文提示；评分回退 JSON 输出一次并静默失败退出，table 给 reason。本机请求禁代理/重定向。daemon 先认证 task credential、再核对 path task、再解析；错误输入不触发 Jev。

逐步接口同样先认证，body 上限 1MiB，非法/重复 step 不再次调用源；停止/撤销运行返回 enabled=false。其 decoder 不像 Evaluate 那样严格拒绝所有未知字段/尾随值，属于协议宽容性差异，未因此扩大改动。

## ⑤ 分级与落地

**A 类本次落地**：复用已经验证的运行级候选，消除重复发现与 detached discovery；补核心回归断言：成功、Jev 失败、目录失败/未验证三类均最多一次发现；有候选的 Jev 失败仍允许插件安装；无候选不安装；旧 CLI/固定模式不安装。保留运行级及步级全部已确认行为，不改变 SQL/API/UI。

**B 类边界**：不申请删除自适应、逐步模式、采样、探针或通用评分，不把 `_adapt` 合并为上游固定值，也不删 metadata 列。上游只覆盖静态配置，现有产品决策已经确定保留方向，本次不需要新的产品拍板。若后续提出这些裁剪，应另行量化线上采用率/效果并按 blocked → 负责人决策执行，不能把本报告解释成删除授权。

其余性能边界已在③④明确：目录扫描、全消息处理、工作区级 telemetry 合并、预算一致性都不能仅凭静态复杂度声称已经造成线上事故。本次只提交已复现、范围明确的 A 类根因修复；不新增架构层、不发起破坏性精简。

## 验证记录

新增 `TestAdaptiveStartupDiscoversCatalogOnce` 在修复前的四个子场景均失败，均报告 `startup discovered the catalog 2 times, want 1`；修复后四个场景及插件门控测试全部通过。场景为成功、Jev 超时、目录读取错误和 fallback 目录；同时断言运行挡位、插件是否安装及运行级/步级候选顺序一致。这里只量化目录调用次数 2 → 1，未将 30s 超时上限当作每次启动实测收益。

本机 Go 默认 `GOTOOLCHAIN=local` 的 1.27.1 低于仓库要求 1.27.3，测试通过命令级 `GOTOOLCHAIN=auto` 使用仓库所需工具链，没有修改 go.mod。实际运行：

```sh
# server/ 下
GOTOOLCHAIN=auto go test ./internal/daemon/jev ./internal/daemon/jevsample ./internal/daemon/effortmod -count=1
GOTOOLCHAIN=auto go test ./internal/daemon -run 'Test(AdaptiveStartupDiscoversCatalogOnce|PrepareStepEffortGates)' -count=1
GOTOOLCHAIN=auto go test -race ./internal/daemon -run 'Test(Adaptive|Thinking|Step|RunTaskFlushesStepOutcomes|PrepareStepEffort|EffortMod|SupportsClaudePerTurn|Jev|NormalizedError|ErrorFeature|ParseExitCode|TagThinking|PerTurnEffort|ResolveTaskModelSelection)' -count=1
GOTOOLCHAIN=auto go test -race ./pkg/agent ./cmd/multica -run '(Thinking|Effort|Adapt|Jev)' -count=1
GOTOOLCHAIN=auto go test -race ./internal/daemon/jev ./internal/daemon/jevsample ./internal/daemon/effortmod -count=1
GOTOOLCHAIN=auto go vet ./internal/daemon

# repo root 下
pnpm --filter @multica/core test agents/thinking-adapt.test.ts chat/thinking-level.test.ts runtimes/queries.test.ts
pnpm --filter @multica/views test common/thinking-level-badge.test.tsx agents/components/inspector/thinking-picker.test.tsx agents/components/inspector/thinking-prop-row.test.tsx
pnpm --filter @multica/core test api/task-message-metadata.test.ts
pnpm --filter @multica/views test runtimes/components/runtime-quota-cell.test.tsx
git diff --check
```

上述 Go 测试、race 检查及 go vet 通过；前端 8 文件、194 项测试通过（core 64，views 130）。

限制：`make status` 确认本检出未注册 managed environment，未连接假定的本机 PostgreSQL，因此 handler 的数据库/Redis 集成测试及 EXPLAIN ANALYZE 未执行（handler TestMain 无 DB 会整包跳过，不能报作通过）。未执行要求 `claude-code/testing` 宿主的 TS mod 测试、真实外部 Jev/Agent 测试、宿主机采样、全仓测试或浏览器截图/性能测量。现有 live 评测仍受环境门控并跳过。

## 直接范围逐文件清单

以下数字固定取自上述两提交的 `git diff --numstat`，包含测试与嵌入资源。扩展集成文件见②；不把共享文件全量差异归因给 F14。

| 文件 | + / − | 核查职责 |
|---|---:|---|
| `packages/core/agents/thinking-adapt.ts` | 28 / 0 | core：候选/能力门控；views：状态/来源/延迟文案；纯函数 |
| `packages/views/common/thinking-adapt.ts` | 54 / 0 | core：候选/能力门控；views：状态/来源/延迟文案；纯函数 |
| `server/cmd/multica/cmd_jev.go` | 118 / 0 | 显式业务评分 CLI，严格输入及 loopback 传输 |
| `server/internal/daemon/effortmod/effortmod.go` | 106 / 0 | 嵌入安装、上下文文件、插件目录合并 |
| `server/internal/daemon/effortmod/effortmod_test.go` | 89 / 0 | 安装资源/目录合并回归 |
| `server/internal/daemon/effortmod/mod/.claude-plugin/plugin.json` | 6 / 0 | 插件身份与版本 manifest，嵌入 binary |
| `server/internal/daemon/effortmod/mod/.gitignore` | 1 / 0 | 插件开发依赖忽略规则 |
| `server/internal/daemon/effortmod/mod/hooks/hooks.json` | 1 / 0 | register.ts 的加载声明 |
| `server/internal/daemon/effortmod/mod/hooks/register.ts` | 428 / 0 | session/turn hook、材料截取、2s 回退、效果记录 |
| `server/internal/daemon/effortmod/mod/tests/register.test.ts` | 530 / 0 | hook 门控、续档、撤销、去重/材料边界 |
| `server/internal/daemon/jev/evaluate.go` | 127 / 0 | 64KiB 严格解析、评分区间验证、共享源调用 |
| `server/internal/daemon/jev/evaluate_test.go` | 132 / 0 | 非法请求、score 响应、超时/熔断/取消 |
| `server/internal/daemon/jev/jev.go` | 688 / 0 | 多源传输、候选验证、熔断及快照 |
| `server/internal/daemon/jev/jev_test.go` | 1236 / 0 | HTTP mock：超时/切源/熔断/探针；live 测试门控 |
| `server/internal/daemon/jevprobe.go` | 85 / 0 | 分钟 tick 和十分钟闲置探测 |
| `server/internal/daemon/jevsample/jevsample.go` | 436 / 0 | 可选采样、容量/轮转/权限/单写队列 |
| `server/internal/daemon/jevsample/jevsample_test.go` | 426 / 0 | 队列、丢弃、大小上限、日期/profile 隔离 |
| `server/internal/daemon/thinking_adapt.go` | 409 / 0 | 运行级决策、state 裁剪、候选复用修复位置、消息标记 |
| `server/internal/daemon/thinking_adapt_test.go` | 543 / 0 | 三模式、候选、回退、内容边界、注入门控 |
| `server/internal/daemon/thinking_evaluation_test.go` | 192 / 0 | fixture/export/wire 一致性，真实评测显式门控 |
| `server/internal/daemon/thinking_fixtures.go` | 130 / 0 | 评测语料渲染，生产决策路径不调用 |
| `server/internal/daemon/thinking_injection_test.go` | 167 / 0 | fake CLI/ACP 端到端注入及重试，不调用安装的 CLI |
| `server/internal/daemon/thinking_level_warning_test.go` | 1 / 1 | 上游静态挡位 warning 回归，diff 仅记录额外参数适配 |
| `server/internal/daemon/thinking_sample_collection_test.go` | 385 / 0 | 决策和运行终态样本关联 |
| `server/internal/daemon/thinking_step.go` | 482 / 0 | task HTTP 门控、锁/候选、插件生命周期、消息标记 |
| `server/internal/daemon/thinking_step_errors.go` | 129 / 0 | 统一错误特征及最近六步重复计数 |
| `server/internal/daemon/thinking_step_errors_test.go` | 132 / 0 | 真实错误格式、路径数字归一化及窗口回归 |
| `server/internal/daemon/thinking_step_fixes_test.go` | 469 / 0 | enablement、回退、重放/撤销及消息修正回归 |
| `server/internal/daemon/thinking_step_outcomes.go` | 129 / 0 | 前/后步骤结果与终态 flush，采样开关下生效 |
| `server/internal/daemon/thinking_step_outcomes_test.go` | 456 / 0 | 终步/取消/相邻结果与重复失败信号 |
| `server/internal/daemon/thinking_step_tag_test.go` | 58 / 0 | step 标签应用与运行级标签替代 |
| `server/internal/daemon/thinking_step_test.go` | 208 / 0 | 逐步请求材料与错误特征 |
| `server/internal/handler/runtime_thinking_adapt.go` | 119 / 0 | heartbeat 验证、广播、runtime 批量装配 |
| `server/internal/handler/runtime_thinking_adapt_http_test.go` | 194 / 0 | HTTP/WS heartbeat 与列表端到端（需 DB/Redis） |
| `server/internal/handler/runtime_thinking_adapt_store.go` | 179 / 0 | Redis TTL/Lua 更新和 pipeline 读取 |
| `server/internal/handler/runtime_thinking_adapt_test.go` | 331 / 0 | 验证、节流隔离、TTL/乱序续期、no-op store |
| `server/pkg/agent/labrastro_effort.go` | 79 / 0 | Claude ui_log 封套解析与效果回调 |
