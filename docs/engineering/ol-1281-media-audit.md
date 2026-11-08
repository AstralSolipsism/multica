# F15：媒体任务与预置 image-studio 审查

审查日期：2026-11-08。上游基线 `v0.8.1` = `b1ea927def6490c43bedff537b6f4ed9a47fa828`；本次冻结的 `origin/main` = `e31506b3c8eb47cd8694e3bfe160856d6c12a27a`。同时检查了 `v0.8.0` (`9b1ab4f9eed9153a94719596eb8a728d2770f065`) 的路径与实现。以下结论来自这个范围的真实源码，不把文件名包含 media 的渠道附件功能算入 F15。

## ① 必要性与上游重叠

上游两个版本均没有 `media_job` 表、媒体领取/回执 API、`multica media`、原生图像适配器或预置 image-studio。上游已有运行时注册、额度、普通任务调度、附件存储、skill 绑定和图片展示。本功能复用这些基础设施，新增的是跨调用者/订阅主机的授权、图像生成调度与附件回执，不能用普通附件上传等价替代。

| 子特性 | 结论与边界 |
| --- | --- |
| `image-generate` / `image-edit`，`auto` / `codex` / `agy` | 保留。原生执行器使用宿主登录，调用者只上传参考图和领取附件；有独立于普通任务的单运行时串行约束 |
| 配额排名、明确限额后的换机、上传幂等 | 保留。避免重复付费生成；普通任务重试不能直接套用 |
| 预置 image-studio | 保留。普通可编辑、可删除、按智能体选择绑定的 skill，不是强制注入；只在新建工作区时初始化 |
| 视频、Flow、Whisk、image-remix | 当前源码已经拒绝，不能把 issue 背景提到的视频当成现存产品能力。1 GiB 传输和 image/video MIME 接收属于通用传输边界，不等于提供视频生成 |
| `--model` | 文档、CLI 帮助和两个执行器均声明不支持，API 校验却接受非空值：这是已有契约执行过晚，可无损提前失败 |

没有使用量遥测，不能声称某个来源高频或低价值。没有据此下线来源、合并调度器、删除字段或修改 skill 的默认绑定方式。skill 中的模型品牌描述不是协议验证证据；服务只保证 provider family，不能保证具体模型版本。

## ② 侵入面与克制性

审查清单共 62 个发生差异的文件（整个文件 diff 合计 +8,444 / −163 行）：46 个 F15 专属文件和 16 个共享接入文件，详见同目录 `ol-1281-media-files.md`。其中 20 个测试 Go、8 个迁移 SQL、2 个 JSON fixture、2 个文档/skill 文件，另有 30 个 Go/SQL 文件（含生成代码和测试工具）。共享文件的整个 diff 含其他治理单元，不能把其全部行数归因于 F15。直接前端文件、媒体任务专用 React 组件和 Query hook 均为 0；通用附件/skill 展示另作调用链核查。

数据库为 4 个迁移、8 个 SQL 文件、1 张无外键表、3 个索引。`9035_labrastro_media_job` 建表和反向删表；`9036_labrastro_media_job_identity_index` 建 id 唯一索引；`9037_labrastro_media_job_queue_index` 建 `(workspace_id,state,created_at)`；`9038_labrastro_media_job_running_index` 建 running 状态的 runtime 唯一索引。后三者各自单语句 CONCURRENTLY，迁移恢复目录中已注册。删除工作区在既有清理事务中删媒体任务。本次不改已发布迁移、不增表或缓存。

`Executor` 只有 Capabilities/Submit，两个实现共享下载、上传、临时目录、取消和回执链路，边界合理。WS 通过现有 HTTP handler 桥接复用权限和状态机。流式存储使用既有 LocalStorage/S3Storage，不引入第三套文件服务。Codex 复用 RPC/进程所有权工具，Antigravity 复用同一进程取消机制。

预置初始化只有 `CreateWorkspace → seedPresetSkills(qtx)` 一个调用点，一次 CreateSkill；普通工作区、智能体和 skill 列表没有 ensure/upsert。嵌入文件解析只发生在创建时，无需增加缓存。现有测试覆盖编辑、绑定隔离、删除后列表不复活。

## ③ SQL、后端和守护进程性能

### 全部 13 条媒体 SQL

下表先给出由谓词和索引推导的计划形态；不假装它们是生产测量。可复现实验和实测结果单独记录，生产基数和缓存状况未知。

| 查询 | 范围、索引和风险 |
| --- | --- |
| CreateMediaJob | MATERIALIZED CTE 先按 workspace id 和 caller 限定 workspace/member，再 FOR KEY SHARE 后 INSERT；不是先全库聚合的漏剪枝 CTE。与移除成员/删除工作区串行化，无 FK |
| GetMediaJob | id 唯一索引最多 1 行，再校验 workspace |
| LockMediaJob | 同上 + 行锁；取消、回执、附件落库共用 |
| ExpireMediaJobs | workspace + queued/running 命中队列索引前缀，再过滤 expires_at。成本随本工作区活跃行增长，不随全库历史行线性增长；每个 GET 再做全工作区扫描属于可去除的放大 |
| QueuedMediaJobs | 先 workspace/state，按 created_at/id 排序；id 不在队列索引内，同时间戳可需增量/额外排序。runtime PK、member 存在性和两条 JSON routes 在 LIMIT 50 之前过滤，避免不可路由来源挤满前 50。FOR UPDATE SKIP LOCKED 避免队列等待；LIMIT 50 不保证只检查 50 行，极端不匹配 backlog 仍可扫描很多行 |
| SettleMediaRuntimeJobs | running 唯一部分索引按 runtime 最多命中 1 行，workspace 再限定；优化器也可能选择 workspace/state 索引（下述实测即如此）。重启/丢回执时保留已上传附件，否则失败，不重放生成 |
| AvailableMediaRuntimes | workspace/status/daemon 过滤，NOT EXISTS 可通过 running 部分索引做 anti join；返回整个工作区候选，应用层按每个 job/caller 选择，最坏 O(50×R)。空队列也执行是冗余工作 |
| StartMediaJob | id 唯一索引 + workspace/state 条件更新；running 部分唯一索引保证单运行时占用 |
| FinishMediaJob | id/workspace 单行更新；调用者在事务里持有 job 锁并判断状态/attempt，SQL 本身不是无条件幂等 API |
| AttachMediaJob | id/workspace 单行更新，传输后才锁 job；大文件网络等待不占 job 行锁 |
| CoolMediaRuntime | runtime id/workspace 单行 JSONB 合并；一次明确额度失败触发，保留其他 metadata |
| DeleteMediaJobsForWorkspace | workspace 命中队列索引前缀，覆盖该工作区全部状态；随工作区历史量增长 |
| 新增 ExpireMediaJob（本次修复） | id/workspace + active/deadline 条件，普通读取仅过期目标行；领取路径保留工作区批量过期 |

领取路径还会在至多 50 个候选上调用 `getWorkspaceMember`。SQL 已有 EXISTS，此处是二次当前权限检查，可能命中共享成员缓存；冷缓存最坏增加 50 次查询。此轮保留检查，避免顺手改变撤权边界。`CreateMediaJob` 最多 16 个输入附件查询，属于输入上限内的校验，不是无界列表 N+1。

事务锁：claim 先 runtime 后 running job；rate-limit report 先 job 后更新 runtime，存在交叉并发时的锁序反转。正常守护进程每个 runtime 串行，回执重试耗尽再 claim；服务端慢请求的迟到回执仍可能与下一次 claim 重叠。当前 receipt 重试及 assignment-lost 收敛能终结状态，但不保证无死锁。此处先作为并发边界记录，未以推测增加全局锁或新调度状态。

### 轮询、预算和重试

| 路径 | 现状与成本 |
| --- | --- |
| mediaLoop | 3s 本机 tick，扫描 runtime 并维护 worker；本身不访问 DB |
| 空闲 worker claim | 每个可用 runtime 每 3s 一次，R 个约 20R 次/分钟。HTTP/WS 只是传输差异，WS 并不省掉 SQL；目前错误没有指数退避 |
| 执行期间 status | 每 3s 请求一次，校验 job、runtime、member；401/403/409 取消。取消延迟通常受 3s tick 影响，网络慢时还受 30s HTTP 超时影响 |
| CLI wait | 每秒 GET，单个 30min job 最多约 1,800 次；目前每次还触发工作区 expire。本次收窄为目标行，保持完成感知延迟 |
| 领取/回执 | WS RPC 10s；明确不支持/未发送才 HTTP fallback，uncertain 不双投；HTTP 客户端 30s。回执共享独立 10s 总预算、最多 3 次、1s/2s 等待 |
| 文件上传 | 最多 3 次，重用本地文件，不重新执行模型；非 429 的 4xx 停止。父 job deadline 30min；CLI 35min；Antigravity 额外 20min 上限 |
| 来源探测 | 复用 2min CLI discovery，各 probe 上限 15s。持有 nativeMediaMu 期间运行探测，使并行来源串行，worker 取 executor 可等待；不在 WS reader 内直接跑模型 |
| 限额 | 明确限额才重新排队；capability cooldown 至多 7 天显式值，缺值用额度重置或 1min；最多 32 次 assignment，30min job 截止仍生效 |

本轮不调整 3s/1s 间隔，不增加推送协议。减少每次轮询的工作量：无 routes 不扫描队列；队列空不加载运行时；GET 不扫描邻居。空队列每 tick 少 1 条候选查询，无 route 每 tick 少 2 条查询，分别约省 20R / 40R 条 SQL/分钟。API 鉴权、失联回执结算和事务提交仍执行。有任务时改为队列锁后加载运行时快照，会延长这一次候选查询所需的队列持锁时间；其他领取使用 SKIP LOCKED，未引入等待队列锁的新路径。

### PostgreSQL 合成数据实测

使用仓库 `make up C=api` 创建和迁移的独立数据库，在单个 psql 会话中 `CREATE TEMP TABLE ... LIKE public... INCLUDING ALL` 克隆完整列与索引，连接退出自动释放。没有访问生产数据。可重跑脚本为 `ol-1281-media-plans.sql`；它使用 100,000 条 completed、10,000 条 active（其中 1 条 running）、100 个 runtime、1 个 member；授权 INSERT 实验再增加 1 条 queued。

| 查询 | EXPLAIN (ANALYZE, BUFFERS) 实测摘要 |
| --- | --- |
| CreateMediaJob | CTE 先限定到各 1 行的 workspace/member，再 LockRows、INSERT；0.254 ms。小表合理采用 Seq Scan，不是漏剪枝 |
| 原 GET 的批量 expire | Bitmap Index + Bitmap Heap，过滤 10,001 行；local hit=292/read=60，3.035 ms |
| 修复后单行 expire | id Index Scan，过滤 1 行；local hit=2/read=2，0.038 ms |
| QueuedMediaJobs | workspace/state Index Scan → route Semi Join → Incremental Sort → LockRows → Limit；读入 65 个候选，返回 50 个，排序峰值 34 kB，local hit=60，0.311 ms |
| AvailableMediaRuntimes | Merge Anti Join；100 个 runtime 排序（47 kB），running 部分索引读 1 行，输出 99 个，0.128 ms |
| SettleMediaRuntimeJobs | 选择 workspace/state Index Scan，过滤 runtime 后更新 1 行，0.092 ms |

这些数字是一轮本地合成数据结果，临时表使用 local buffers，不能直接当作生产 shared-buffer/RSS 或 P95 指标。稳定收益是 GET 候选规模从全部活跃行降为 1 行，并消除另一个过期 job 行锁对本 GET 的阻塞；不是承诺生产固定加速倍数。claim 的批量 expire 仍与活跃量相关，未假装已消除全部轮询成本。

### 内存和文件边界

CLI multipart 用 framing + 文件 reader；服务端 ParseMultipartForm 的文件内存阈值 1 MiB，超出落盘，form 临时文件最后清理（非文件字段另有标准库预算）。服务器下载用 GetReader + range，守护进程用 LimitReader + io.Copy；生成文件通过已知长度的 reader 上传。媒体输出 sniff 512 bytes 后 MultiReader；LocalStorage 原子落盘，S3 直接 PutObject 已知长度，不使用全文件 ReadAll 或 multipart uploader 大分片缓冲。

因此图片 payload 在平台传输链路的内存不随 1 GiB 文件线性分配；这不等于总 RSS 恒定。Codex scanner 每行上限 32 MiB，JSON 解析有额外副本；Antigravity stdout、单份 transcript、日志各有 8 MiB 上限，读取和解析会同时保留若干缓冲。每个 runtime 各有 worker，多 runtime 会累积内存和子进程开销；原生 CLI 自身的内存没有实测。16 个参考输入每个可达 1 GiB，临时磁盘可达约 16 GiB 加输出，未设全局磁盘配额。

上传前、传输后和落库锁内再次检查撤权/attempt/deadline；取消不等网络流传完才拿锁。临时目录在执行结束删除，关机等待 worker 回收。最终文件必须在 job 目录内且是大小受限的普通文件。传输错误不携带宿主凭据或完整 prompt。

## ④ 前端和 CLI 体验

没有媒体任务专用前端、React Query poller、状态列表或新主题控件。结果沿既有附件渲染：`UploadMediaOutput` 成功新建附件后只发一次 `issue_attachments:changed`；重复上传命中 receipt 不再次发事件。web/desktop 只失效该任务的 attachments key 并推进 revision，mobile 只处理当前任务。未发现 F15 独立的全局 invalidation 风暴。

`ImageView → Attachment` 复用图片加载/预览与样式（lazy loading、async decoding、上传/下载状态、可访问名称）；预置 skill 复用普通 skill 列表，`skillListOptions(wsId)` 没有 refetchInterval。没有新增大列表渲染路径。媒体输出直接 CreateAttachment 时未写 width/height，不能套用普通上传已计算尺寸的结论：组件先用固定比例占位，图片实际比例不同时加载后仍可能变化。窄栏、暗色、加载/空状态沿用通用组件；本次只做源码核查，未把未运行的浏览器视觉测试算作通过。

CLI 已在网络前拒绝非法 output、互斥 flags、provider/capability、过多输入、非法附件 UUID；prompt 文件读取最多 32,001 bytes。原实现的非空 model 在公共 Validate 中未拒绝，执行器才报错，可能先上传最多 16 个参考文件再等待主机。本次把既有不支持契约移到公共 Validate，CLI/API 共用明确错误，执行器仍保留边界防御。

无候选主机时维持 queued，最长等 30min；CLI 只在终态打印回执，运行期没有进度条。cancelled 返回状态且退出成功，是现有命令语义。是否新增进度、缩短等待或改变退出码都属于可见交互决策，本轮不改。

## ⑤ A/B 分级与落地

| 分类 | 处置 |
| --- | --- |
| A：单任务查询放大 | 新增精确过期 SQL，只替换 GET/cancel 读取路径；领取仍清理全工作区。回归：读目标不被另一个过期 job 的行锁拖住，目标过期和 claim 清理仍正确 |
| A：空闲领取浪费 | 队列/候选查询按 routes 与候选 job 存在性惰性执行，不改调度优先级或 lost-assignment 结算。回归：冷却/无能力/空队列不读无用候选，正常任务仍按额度领取 |
| A：已不支持的 model 延迟校验 | 公共 Validate 提前拒绝；CLI 有本地参考文件时仍 0 HTTP，API 400 且不创建 job |
| A：其余性能边界 | 保留上述有界 N+1、claim 批量过期、探测持锁和无错误退避的事实；没有生产基数/故障频率证据，不额外造缓存或服务 |
| B：来源裁剪、删表/删字段、并入普通任务、改变默认 skill 绑定、延长轮询或新增交互 | 未提出执行方案，未实施。现有证据不支持裁剪，也没有需要负责人二选一的产品方向，因此本轮按 A 类交付，无 B 类阻塞 |

## 验证记录

先完成五维评估并加入回归，再修改实现。修复前实测失败：邻居过期 job 持锁时 GET 在 1s 截止后返回 500；空队列仍执行 AvailableMediaRuntimes、无 route 仍执行 QueuedMediaJobs；非空 model API 返回 202，CLI 发出了输入上传 HTTP。修复后这些回归全部通过。

在仓库管理的隔离数据库、Go 1.27.3 下执行：

```sh
GOTOOLCHAIN=auto make sqlc
bash scripts/dev-env.sh exec -- env GOTOOLCHAIN=auto bash -c 'cd server && ../scripts/go-test-with-agent-cli-guard.sh -- go test -race -p 2 -parallel 2 ./internal/handler ./internal/daemon/... ./internal/service ./internal/migrations ./internal/cli ./internal/storage ./pkg/protocol ./pkg/agent ./cmd/multica -run "Media|PresetSkills|CreateWorkspaceSeeds|CodexImage|CodexNativeImage|AntigravityImage|UploadStream" -count=1 -v'
bash scripts/dev-env.sh exec -- env GOTOOLCHAIN=auto bash -c 'cd server && ../scripts/go-test-with-agent-cli-guard.sh -- go test -race -p 2 -parallel 2 ./pkg/agent -run "^TestAntigravityNativeImage(Execution|Cancellation)$" -count=1 -v'
bash scripts/dev-env.sh exec -- env GOTOOLCHAIN=auto bash -c 'cd server && ../scripts/go-test-with-agent-cli-guard.sh -- go test -race ./internal/daemon/media -count=1 -v'
git diff --check
```

上述 race 选择运行及补跑适配器用例共 96 个顶层测试通过，无 race 报告。没有匹配测试的子包只算编译通过，不算行为验证。核心断言包括：

- GET 不受邻居过期 job 行锁阻塞；目标 deadline 校验仍有效，claim 仍清理过期邻居。
- 空队列不查候选运行时，无能力/冷却时不查队列；仍执行过期清理和 lost-assignment 结算；quota ranking、不可路由 backlog 不饿死其他来源均通过。
- 非空 model API 400 且 0 job，CLI 带本地输入时 0 HTTP。
- `TestMediaEndToEndStreamingRPC` 完成 110 MiB 输出、3 次上传且仅 1 次生成、幂等附件、WS 心跳继续、显式 out 下载和临时目录清理。
- Codex/Antigravity 各自通过真实 caller CLI + 测试宿主进程的凭据分离生成/编辑链路；取消、撤权、配额换机、native receipt 和路径边界通过。
- 9035–9038 正向/回滚循环、预置 skill 的创建/编辑/绑定隔离/删除不复活通过。

限制：`make test` 已尝试，但其 ensure-postgres.sh 固定调用 Docker，环境未安装 Docker，在测试前退出；因此不声明全库 make test 通过。实际 DB 测试使用 `make up C=api` 管理并迁移的本机 PostgreSQL，未跳过数据库测试。没有执行付费真实来源 smoke、生产 RSS 压测或浏览器视觉回归。SQL 实测是上节合成数据，原始 EXPLAIN 随任务评论附件交付。
