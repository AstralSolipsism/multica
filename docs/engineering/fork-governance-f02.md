# F02：Issue 搜索与列表扩展治理评估（OL-1272）

审计日期：2026-11-07。上游基线 `v0.8.1` = `b1ea927def6490c43bedff537b6f4ed9a47fa828`；被审计的 `origin/main` 固定为 `2c7a522896729b3eea771f38ab6b69f0cdf56159`。同时检查了本地 `v0.8.0` 的真实源码。以下区分代码证据、合成数据库实测和未做的生产/浏览器验证。

结论：保留 project、scope、终态可搜索和分页能力。可直接落地的 A 类问题是开放项搜索漏剪终态评论、CLI 负 offset 回显与实际请求不一致、无 project 时遗漏 workspace 前置检查，以及可变 limit 共用前端缓存键。无需新增表、索引、服务或轮询，也没有要求负责人裁剪功能的依据。

## ① 功能必要性与上游重叠

| 子能力 | v0.8.0 / v0.8.1 的实际覆盖 | Fork 增量及结论 |
|---|---|---|
| 标题、描述、评论及多词匹配 | 两个版本均已有；实际实现为预先 LOWER 后 LIKE，不是直接 ILIKE | 复用原有候选流水线和跨字段/跨评论词项语义，保留 |
| 项目范围 | ListIssues 原生支持 project_id；SearchIssues 基线不支持 | 搜索补齐 project，OL-1263 已将项目条件下推到评论 CTE；不能把列表已有能力当作搜索重复功能 |
| scope=title_desc | 基线不支持 | 明确跳过评论匹配，避免过程噪声；仍允许词项分布在标题与描述，保留 |
| offset / has_more | SearchIssues API 原生解析 offset，但 CLI 未暴露，也不返回 has_more | CLI 透传 offset，服务端 limit+1 后切片；没有精确 COUNT 开销，保留 |
| include_closed | 基线已有 include_closed，API 与 CLI 默认排除终态 | 收敛对齐上游：CLI `--include-closed` 保持默认 `false`（移除分叉 `--open-only`），前端 picker 显式传 `include_closed: true` |
| 普通列表 | project、分页、open_only、自定义状态展开、排序等主要来自上游 | `ListIssues` 本体在两个固定提交间无 F02 新增查询分支；仍检查真实 SQL，不归功于 Fork |
| picker Query | 上游没有本次依赖编辑器的 issueSearchOptions | 已确认依赖关系可引用完成项，因此包含终态有具体调用方；limit 必须进入 Query 身份 |

没有线上采用率或查询频率遥测，不将任何子能力描述为“低频应删除”。编号命中不校验前缀、默认 scope 下编号单独命中回退显示 comment、title_desc 下回退显示 description（移除分叉 `"number"` 枚举），与上游 PR 标准保持一致。

## ② 侵入面与克制性

任务指定的三个共享文件相对基线完整 diff 为 **394 行新增、125 行删除**：`issue.go` +190/-74、`cmd_issue.go` +122/-45、`queries.ts` +82/-6。它们还包含依赖图、文本转义等其他功能，不能把这些整文件数字全部算作 F02。

F02 运行时代码边界为 **7 个文件（3 Go、4 TS）**，数据库迁移 **0**、daemon 文件 **0**、新增 UI 组件 **0**。原有回归边界为 **4 个 Go 测试文件**；搜索帮助同步涉及 **5 个 CLI 文档语言文件**。本次额外的验证文件和报告不算原有功能侵入面。

| 文件 | 逐文件审查结论 |
|---|---|
| `server/internal/handler/issue.go` | buildSearchQuery 增 project/scope；SearchIssues 多取一行并切片；ListIssues 保留原生动态列表与精确 count。SQL 参数全部绑定，排序列白名单，没有插入用户 SQL |
| `server/internal/handler/search.go` | 仅新增 scope 常量；原有 8s statement_timeout、事务内 work_mem 及取消路径继续复用 |
| `server/cmd/multica/cmd_issue.go` | 注册扩展 flags、project UUID/前缀解析、JSON envelope；不增加独立客户端或缓存 |
| `packages/core/issues/queries.ts` | picker 搜索沿用 TanStack Query；发现 queryFn 使用 limit，但 queryKey 忽略 limit，30s 内另一页大小会错用缓存 |
| `packages/core/api/client.ts` | searchIssues 透传 project/scope、AbortSignal，保持 parseWithFallback |
| `packages/core/api/schemas.ts` | has_more 可选以兼容老服务端；match_source 是 string，能接收 number，没有枚举解析退化 |
| `packages/core/types/api.ts` | has_more 可选；match_source 保持 `"title" \| "description" \| "comment"` 与上游一致 |
| `search_test.go` / `search_candidate_parity_test.go` | SQL 结构、绑定顺序及上游历史结果等价测试；后者验证排序、跨字段、跨评论、通配符转义 |
| `search_ol458_test.go` / `cmd_issue_test.go` | 项目、scope、中英文多词、编号、终态、满页尾页、offset、project 错误前缀与 workspace guard |
| `apps/docs/content/docs/cli{,.zh,.fr,.ja,.ko}.mdx` | 扩展命令示例；本次不改变该示例契约 |

最小修复复用已有 issueWhere，把同一 workspace/project/terminal 条件用于评论 EXISTS；不复制状态规则，不加新索引或通用查询抽象。CLI guard 沿用列表路径，Query key 继续处于 issues/workspace/search 前缀下。

## ③ 数据库、后端与 daemon

### 测量方法

使用本机临时 PostgreSQL **15.19**，C.UTF-8 / UTF8，完整迁移、真实索引和触发器；通过仓库 `.env.worktree` 和环境脚本创建隔离数据库，没有接触平台生产数据库。pg_trgm 1.6 可用、无 pg_bigm；shared_buffers 128MiB，默认 work_mem 4MiB，搜索事务按线上代码设64MiB，plan_cache_mode=auto。显式设置 GOTOOLCHAIN=auto 使用 go.mod 要求的 Go 1.27.3（宿主默认 1.27.1）。

可重跑的 `TestIssueSearchPlans` 仅在同时显式给出 `DATABASE_URL` 和输出路径 `ISSUE_SEARCH_PLANS` 时运行。2,000 个目标 issue、4,000 个其他工作区 issue，每项 5 条约 1KiB 评论，共 30,000 评论；目标工作区 90% 终态，包含自定义 done 类 verified，项目选择 10%，状态分布与项目独立。ANALYZE 后执行真实构建器 SQL；每组采样三次 EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)，报告中位数。不是冷盘、生产负载或并发吞吐基准。

搜索穷举 **216 组**：project 有/无 × all/title_desc × include_closed true/false × 单词/英文多词/中文多词 × limit 1/20/50（实际多取一行）× offset 0/20/5000。另从真实 ListIssues handler 捕获普通、project、status、project+status、open_only、project+open_only、标题命中/多词不命中及项目组合的 SQL，覆盖三个 offset，包括 count、labels、状态等附加读取；不手写近似列表 SQL。查询文本、参数和原始执行计划保存在随任务交付的压缩 JSON 中。

### 逐 SQL 结论

| 阶段 | 执行计划与开销判断 |
|---|---|
| issue_matches | workspace/project 索引先限制候选；title/description 的 LATERAL OFFSET 0 只计算一次 LOWER，标题完整命中可省描述。文本谓词不是 GIN 可直接下推的形式，这是上游已有候选策略，不是 Fork 意外失效 |
| comment_matches | all 模式按 workspace 扫描一次并 BOOL_OR 聚合；各词可分散在不同评论。项目模式已有 issue → comment 索引连接。修复前开放项模式仍处理全部终态评论，是可实测的漏剪枝 |
| ranked_candidates / page_candidates | 不计算总数；排序后 limit+1、offset，唯一 ID 保证同时间稳定排序。limit 小不意味着少扫描候选；深 offset 仍需排名并跳过，不承诺 O(limit) |
| 最终 hydration | 逻辑上先分页再关联，最多返回51行；实测既有 PK lookup，也有扫描该工作区2,000 issue再 hash join 页结果的计划，不能承诺物理读取也只有51行。title_desc 没有 comment_matches；保留的 NULL snippet PK join 实测返回0条，不扫描评论正文 |
| 状态、prefix、重复原件补齐 | 状态先批量展开，结果补齐批量读；没有每行额外网络查询。ARRAY_AGG 仍按单 issue 的匹配评论数量增长，极长单线程不是常数内存 |
| ListIssues 主查询 | 默认排序命中 workspace/position 索引；项目路径命中 project 索引再小范围排序；status 条件可用状态索引。q 使用标题词项 AND，搜索 API 还搜描述和评论，两者不是同一产品语义 |
| ListIssues COUNT | 只带过滤参数，复用 workspace/project/status 索引，可 index-only；仍按候选数计数。不能用搜索的 has_more 替换掉 UI 所需 total |
| ListOpenIssues | 复用上游静态 SQL，排除展开的终态；没有 limit、offset 不生效，这是既有接口契约。不是本次新增无界分页；不擅自给其加 cap |
| labels / status enrichment | 批量读取，空页省 labels；总 SQL 数不随返回项逐项增长 |

修复前开放项、多词、limit20/offset0 无项目处理10,000评论、316ms；项目范围有1,000评论参与 LOWER/聚合、36ms。项目计划可选 issue→comment lookup，也可从 workspace 索引读10,000评论后 hash join 剪为1,000，因此 OL-1263 保证聚合前剪枝，不保证所有计划只读取目标项目行。只有10%的 issue 可返回，90%评论文本计算没有贡献。最终前后对照表与回归摘要见文末。

在全部1,962份计划中，issue/comment 均未出现全表 Seq Scan；未观察到其他工作区正文被归一化、sort/hash 临时磁盘溢出或应用层 N+1。索引内多次 comment lookup 是一条 SQL 的执行节点，不是应用层 N+1。顺序扫描小状态/标签表合理，不以“出现 Seq Scan”作为缺陷标准。搜索为只读事务，无行写锁；8s DB fuse、请求取消和事务内64MiB work_mem 保留。work_mem 按节点分配，多个并发查询仍有资源上限风险；本样本不代表最大工作区。此功能不新增 daemon 定时任务、退避或后台请求。

## ④ 前端与 CLI/API 契约

这里是源码、自动测试和 PostgreSQL 审视，不是浏览器截图审查，未宣称实测窄屏/暗色渲染性能。

`issueSearchOptions` 无 refetchInterval，staleTime 30s，queryFn 使用 AbortSignal；依赖编辑器 `edit-dependencies.tsx` 输入 trim + 300ms debounce，空词不请求，默认20条，结果 useMemo。缓存前缀带 workspace，不存在跨工作区键碰撞；但同一词不同 limit 复用了错误缓存，本次补齐 limit。沿用现有工作区失效机制，不新增事件订阅或全量失效。实时机制仍可能在工作区变更后重取活动搜索，这是已有一致性成本，不能声称已消除全部失效风暴。

依赖编辑器有 searching/空状态、滚动容器、最大高度与语义颜色，结果上限使本查询不生成无限长列表。其搜索错误当前会落到空结果呈现；全局 palette 经 `use-server-search.ts` 走本地索引/服务器回退、取消旧请求及 stale 行保护，不能把它和本 Query 当作重复轮询。未改动组件、CSS、加载/错误交互，也未裁剪本地索引。

| 参数/错误 | CLI | Handler / API |
|---|---|---|
| workspace | list 已前置；search 原先只有传 project 时前置，本次补为所有 search | resolveWorkspaceID 后 UUID 解析；路由权限依赖原有 workspace middleware |
| project | UUID 或十六进制前缀解析；原样返回 resolver 错误，禁止重复 resolve project 前缀 | malformed UUID 400；不存在或其他工作区项目为无结果 |
| scope | 非 all/title_desc 提前报错；all 不发 | 仅 title_desc 特殊处理，未知值沿用 all，这是已发布的容错契约，未擅改成400 |
| limit | list 1–100 越界报错；search 默认20，<=0 或 >50 截为50，JSON回显有效值；本次补帮助描述 | search 默认20/max50，list默认100/max100；非法/非正数回默认，超上限截断，保持历史行为 |
| offset | list 拒负数；search 原先负数不发但回显负数，本次在 project 解析前拒绝 | 非法/负数回0，非负整数生效；open_only 列表无分页 |
| include-closed | 默认 `false`（对齐上游，排除终态并触发终态评论剪枝）；传 `--include-closed` 时发送 `include_closed=true` | 只有字面 true 包含终态；否则批量展开 done/closed 类，含自定义及归档状态 |
| list sort/direction | 白名单或 property:name/id；position 不接受 direction | Handler 支持更多 UI 排序字段；无效 sort 400，position 忽略 direction；CLI 子集不是遗漏接口 |
| list status/priority | 字符串转交，未知过滤值可能为空；不是写入状态的校验路径 | UUID/actor 类型/日期/元数据/属性先校验；open_only 分支使用原生静态过滤子集 |

没有把 CLI 的“提前拒绝”推广成 API 全面严格化，也没有移除兼容参数。ListIssues 的 property/assignee 解析可能早于后续 sort/fields 校验，产生少量只读请求；不新增泛化验证框架。本次只纠正已经复现的 search 边界错误。

## ⑤ 分级处置与核心回归

**A 类落地**：复用 issueWhere 将 terminal 条件下推到评论候选；补齐 search workspace/offset guard 与 flag 帮助；搜索 Query key 加 limit。SQL、CLI、缓存三组新增回归均先复现失败；SQL 回归直接检查候选 CTE，避免只验最终结果而漏掉无效计算。现有项目剪枝、跨评论匹配、排序、编号及 snippet 语义保持。

核心断言：开放项候选不含 done/cancelled/custom-done 的评论、include_closed=true 保留它们；分页首/末/空页的 has_more 正确；非法输入不触发项目解析或搜索 HTTP；两种 limit 独立缓存且 workspace invalidate 仍覆盖两者；前后216组结果顺序与 match_source/snippet hash 全部一致。

**B 类边界**：不申请裁剪评论检索、不合并本地索引、不取消终态查询、不将 offset 替换为游标、不改变开放列表无界契约或 API 容错规则，不进行 UI 交互改版。当前没有必须拍板才能推进的 B 类取舍，因此本 Issue 可交 A 类修复提审；报告不构成未来裁剪授权。

## 前后实测与验证结果

共327条语句配置（216搜索、111列表及其补齐语句），前后各三次，共1,962份 EXPLAIN。**216/216 搜索结果的有序 issue ID、match_source 和 comment snippet hash 一致**。原始数据见任务附件 `f02-before.json.gz`、`f02-after.json.gz`。

以下为 `needle delta`、limit20（SQL实际21）、offset0，中位耗时单位ms。评论数表示进入 LOWER/聚合的行数，buffer 是第二次采样根节点 Shared Hit Blocks；这几组 Shared Read Blocks 均为0。

| 范围 | 终态 | 修复前 → 后 ms | 评论处理行数 前 → 后 | buffer 前 → 后 |
|---|---|---:|---:|---:|
| all，无项目 | 排除 | 316.147 → 33.188 | 10,000 → 1,000 | 1,786 → 907 |
| all，指定项目 | 排除 | 36.031 → 3.848 | 1,000 → 100 | 1,883 → 284 |
| all，无项目 | 包含 | 326.921 → 320.732 | 10,000 → 10,000 | 1,786 → 1,794 |
| all，指定项目 | 包含 | 36.453 → 32.185 | 1,000 → 1,000 | 1,883 → 946 |
| title_desc，无项目 | 排除 | 2.380 → 1.382 | 0 → 0 | 110 → 118 |
| title_desc，无项目 | 包含 | 7.139 → 5.961 | 0 → 0 | 110 → 118 |
| title_desc，指定项目 | 排除 | 0.471 → 0.968 | 0 → 0 | 136 → 135 |
| title_desc，指定项目 | 包含 | 1.968 → 0.967 | 0 → 0 | 131 → 138 |

真正改变的开放评论路径降低约89.5%/89.3%。包含终态和 title_desc 的 SQL 未改变；其耗时和索引选择波动不计为本修复收益。全矩阵最大搜索样本修复前332.071ms、后331.605ms，因为包含终态模式仍然必须处理全工作区评论。limit1或offset超尾页不会免除候选聚合成本。

列表 offset0 / limit20 的修复后主查询：普通0.031ms、project 0.310ms、status 0.080ms、project+status 0.211ms；对应 count 为0.339/0.051/0.055/0.024ms。open_only 返回200行0.709ms、project+open_only 返回20行0.239ms。标题 q=needle 主查询0.081ms，但500命中的精确count需1.311ms，说明小页不能代表计数成本；多词无命中0.059ms。列表 SQL 未改，数据用于检查原有路径而非宣称优化。

已通过的验证（命令在 server 或仓库根目录按路径运行）：

```sh
# 每个分支运行一次；需要已完整迁移的可丢弃 DATABASE_URL。
GOTOOLCHAIN=auto ISSUE_SEARCH_PLANS=/path/to/f02.json \
  go test ./internal/handler -run '^TestIssueSearchPlans$' -count=1 -v
GOTOOLCHAIN=auto go test -race ./internal/handler \
  -run 'Test(BuildSearchQuery|IssueSearch|Search|RunSearchQuery|ListIssues|ListOpenIssues|Terminal|SQLTerminal)' -count=1
GOTOOLCHAIN=auto go test -race ./cmd/multica \
  -run 'Test(RunIssueSearch|IssueSearchCommandRegistration|RunIssueList|IssueList)' -count=1
pnpm --filter @multica/core exec vitest run issues/search-queries.test.ts api/schemas.test.ts
pnpm --filter @multica/core typecheck
pnpm --filter @multica/core exec eslint issues/queries.ts issues/search-queries.test.ts
git diff --check
```

前端194条测试通过；Go上述搜索、列表、超时/取消、自定义终态、上游结果等价回归在真实PostgreSQL及race检测下通过。新增13组API分页边界覆盖默认值、超上限、零、负值、非整数、整型溢出、满尾页与空页。未运行全仓 make test / 浏览器 E2E，未做生产 EXPLAIN 或并发压测；本次无 UI 视觉变更。
