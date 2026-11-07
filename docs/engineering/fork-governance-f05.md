# F05：项目工程管理总览、动态阶段与基线 Wiki 治理评估（OL-1276）

审计日期：2026-11-07。上游基线 `v0.8.1` = `b1ea927def6490c43bedff537b6f4ed9a47fa828`；被审计的 `origin/main` 固定为 `873ab8b4eb657d3fbf75227887852ee0393a7174`。另核对了上游源码中的 `issue.stage`、`project.lead_id`、claim 注入的项目描述。文中把代码事实、合成数据实测和未做的验证分开写。

**结论**：F05 是 Fork 独有的核心能力，上游没有对应功能，也没有冲突。迁移和接口的数量是仓库规则决定的，不算过度设计。真正的问题都在“读路径”上，而且基线越大越明显：

- 前端缓存挂在了上游会频繁整体失效的前缀下，形成刷新风暴；
- 只需要配置或元数据的入口，也在下载整本基线正文；
- 后端按章节逐个查询（N+1）；
- 读事务一直持锁到响应写完；
- 整本 Wiki 在每次父组件渲染时都重新解析。

以上都按 A 类无损修复。需要负责人拍板的 4 项列在 ⑤，代码未动。

## ① 功能必要性与上游重叠

| 子能力 | 上游 v0.8.0 / v0.8.1 | 结论 |
|---|---|---|
| 工程开关、决定人 | 只有 `project.lead_id`，没有工程开关和决定人 | 保留。决定人列表为空时，回落到 owner/admin 和人类 lead，复用上游语义 |
| 动态阶段（`stages` JSONB、`current_stage`） | 有 `issue.stage` 整数（子 issue 分阶段），没有项目级的阶段定义 | 互补。路线图按上游 `issue.stage` 聚合，Fork 只补阶段标题、目标和当前阶段 |
| 基线 Wiki（固定章节和模块章节、候选/采纳、历史、Diff） | 无 | Fork 独有，保留 |
| 小节级“厚书薄读”（`--index`、`--section`、MergeSection） | 无 | 专为智能体按需读取设计，claim 提示里也引导这样读。保留 |
| claim 上下文摘要 | 上游注入 `project.description` 和 resources | 只在 claim 时追加，不回写。保留；但模块章节没有条数上限（见 B1） |
| 侧栏右键入口、详情页入口 | 无 | 保留，已改为读轻量配置 |
| 待拍板 issue 汇总 | 复用上游 `listIssues` 和 timeline | 保留。时间线是逐个 issue 请求，记入非阻断池 |

没有线上使用量遥测，所以本报告不把任何子能力判定为“低频应删除”。

## ② 侵入面与克制性

- **迁移**：`9039`–`9048`，共 10 个迁移、20 个文件、156 行。
  - `9039` 建 3 张表，按仓库规则不加外键。
  - `9040`–`9045` 是 6 个 `CONCURRENTLY` 唯一索引。仓库规则要求每个并发索引单独一个文件。6 个索引都有实际用途：upsert、按章节列表、编号翻页取 MAX、按 ID 读取、“每章最多一个候选”的完整性约束。没有冗余。
  - `9046`–`9048` 是已发布的演进迁移（决策凭据枚举、`stages` 列、模块章节），不能合并或改写。
- **运行时代码**（审计提交时的行数）：
  - 后端加 CLI 共 2,723 行：`labrastro_engineering.go` 955、`labrastro_baseline_sections.go` 100、`engineering/{diff,sections}.go` 411、CLI 三个文件 1,139（`project baseline` 里含 F06 的批注子命令）、SQL 91、其余 27。
  - 前端 3,204 行：`engineering-baseline.tsx`（1,116 行）和 overview 里含 F06 的接线。
- **上游文件挂载点**：共 8 处，都是单点挂载。
  - `router.go`：注册路由。
  - `project_resource.go`：claim 摘要，1 行。
  - `project.go`、`workspace.go`：删除时清理数据，在同一事务内。
  - `task_token_workspace.go`：保留决策错误码，+3/-1。
  - `project-detail.tsx`、`work-tree.tsx`：入口。
  - `paths.ts`：+6。
  - 另外在 `use-realtime-sync.ts` 和 projects 的 queries/mutations 里追加了 Fork 段落。
- **抽象程度**：`labrastro_engineering.go` 虽然近千行，但只有一层状态对象加纯函数包 `engineering`，没有多余的服务层。拆文件只是外观上的变化，不建议做。
- **死代码（已删）**：前端的 `getProjectBaselineIndex`、`getProjectBaselineSection`、`diffProjectBaselineHistory`、`projectBaselineDiffOptions`，以及对应的 Index/Slice schema，没有任何 UI 调用方。CLI 直接访问这些接口，不受影响。

## ③ 数据库、后端与 daemon

### 测量方法

- **环境**：本机 PostgreSQL 15.19，通过 `.env.worktree` 建了隔离库，完整跑完迁移。没有接触生产库。
- **数据**：目标项目有 4 个固定章节加 20 个模块章节，每章 40 个修订，每个修订约 60 KB（上限是 64 KB）。另有 600 个噪声项目分布在两个工作区，以及 42,000 个 issue。
- **SQL 计划**：用 `docs/engineering/evidence/f05-engineering-plans.sql` 可重跑。
- **接口耗时**：用临时的 httptest 测试调用真实 handler，计数用 pgx tracer，每项取 7 次的中位数。这不是生产负载，也不是并发压测。

### 逐 SQL 结论

10 条读路径全部走索引，执行时间在 0.02–2.1 ms 之间，没有全表扫描，也没有 OL-1263 那类 CTE 漏剪枝：

- `LabrastroBaselineOpenIssues` 用 `idx_issue_project_status`，再做 top-N 排序；
- 修订列表、取 MAX、按编号读取都用 `(workspace, project, chapter, revision_number)` 唯一索引倒序扫描；
- 新增的批量读取用 `idx_project_baseline_revision_id` 加 `= ANY`。

`EXPLAIN` 看不到 TOAST 解压和序列化，所以真正的开销体现在下面的往返次数和响应体积上。

### 接口实测（24 章 × 60 KB）

| 读路径 | 修复前 | 修复后 |
|---|---|---|
| `GET /engineering` | 58 条 SQL，3.19 MB，35 ms | 11 条 SQL，3.19 MB，26–34 ms |
| `GET /engineering?with_chapters=false`（新增） | — | 9 条 SQL，379 B，0.8 ms |
| `GET /baseline?index=true` | 34 条 SQL，132 ms | 11 条 SQL，49–53 ms |
| `GET /baseline?section=…`（24 章同名） | 34 条 SQL，408 ms | 11 条 SQL，108–114 ms |
| `GET /baseline?section=…&chapter=…` | 34 条 SQL，127 ms | 11 条 SQL，54–57 ms |
| `GET …/revisions?limit=10` | 663 KB，7 ms | 加 `with_content=false` 后 48 KB，2 ms |
| `GET …/revisions?limit=50` | 2.65 MB，23–35 ms | 加 `with_content=false` 后 192 KB，3.9 ms |
| 每次任务 claim 的工程摘要 | 26 条 SQL，76 ms | 3 条 SQL，47–50 ms |

### 发现与处置

- **【已修】章节 N+1**：概览、`--index`/`--section` 和 claim 摘要都是按章节逐个读取已采纳/候选修订，共 2N+1 次往返。现在改为一次 `LabrastroListBaselineRevisionsByID`。如果某个有效指针找不到对应行，仍返回 404，语义不变。
- **【已修】读事务持锁到响应写完**：读路径持有 `project`/`member` 的 `FOR SHARE` 锁，同时把 MB 级 JSON 写给客户端。客户端越慢，持锁越久，期间项目编辑、提案、拍板和删除项目都会被挡住。现在数据读完就结束快照，再写响应。新增的回归测试会在“写响应期间”尝试编辑项目：修复前触发 `lock timeout`，修复后通过。
- **【已修】小节读取的 CPU 热点**：
  - `ReadSections` 原来每个标题都把整段正文重新转一次小写（24 章时分配 89 MB），现在提到循环外；
  - 只做校验的调用方不再顺带解析全部小节；
  - 扫描时先排除不可能是标题的行。

  合计 420 ms → 112 ms（基准测试）。
- **【已修】PATCH 校验顺序**：`decider_member_ids` 的 UUID 格式错误，原来要在开事务、加锁之后才报 400，现在先于加锁返回，和 decisions 接口一致。
- **写路径事务边界合理**：提案和拍板都先锁项目行，再锁章节文档行，加上 base/candidate 的 CAS 检查，同一项目串行执行。这是设计如此，已有并发测试覆盖。
- **MergeSection 契约**：替换一个小节会连同它的下级小节一起替换。`--section` 读取返回的也是整棵子树，所以“读取-修改-写回”是安全的。如果只提交正文，下级小节会被删掉，但候选 Diff 会显示为 removed，再由人工拍板。代码未改。
- **daemon**：F05 没有后台任务，也没有轮询。

## ④ 前端渲染与使用体验

### 刷新风暴（已修）

工程相关的查询键挂在 `projects/{wsId}/detail/{id}` 下面。上游有几处会整体失效 `projectKeys.all(wsId)`：

- issue 状态或所属项目变化；
- 带项目的 issue 新建、删除；
- 批量更新；
- 所有 `project:*` 事件。

结果是：智能体每改一次 issue 状态，打开着的概览（3.19 MB）、每章最近 10 版历史（每章 663 KB）、已经加载的全部无限分页历史，都会重新拉取一遍。打开 24 章的基线页时，一轮刷新约 21.7 MB。

现在这些查询键移到独立的根 `project-engineering/{wsId}` 下，改由三条路径刷新：

- 各自的实时事件；
- 写操作；
- 断线重连（新增重连失效，并有测试覆盖）。

删除项目时也一并清理这部分缓存。

### 下载量（已修）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 项目详情页 | 下载整本概览，3.19 MB | 读轻量配置，379 B |
| 侧栏右键菜单 | 首次打开下载整本概览，3.19 MB | 读轻量配置，379 B |
| CLI `project engineering get` | 整本概览，3.19 MB | 379 B |
| 基线页的历史列表、每节“最新修订” | 实际只用到元数据和 `anchorsDiff`，却下载了全文 | 改用 `with_content=false`，打开一次约 21.7 MB → 4.5 MB |

旧服务端会忽略新参数，返回完整数据，前端 schema 照样能解析。

### 整本渲染（已修）

Wiki 一次渲染全部章节。搜索时每敲一个字、悬停、阅读进度记录、编辑草稿，都会触发父组件重渲染，原来每次都要把所有小节交给 ReactMarkdown 重新解析一遍，还要为每个文本节点重新编译一个包含“所有标题 + 所有 issue 编号”的正则。

现在每节只编译一次匹配器，解析结果在 `content`/插件不变时复用，Wiki 的 context 也做了 memo。

jsdom 实测（300 小节、400 个 DAG 节点）：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 首次渲染 | 3.68 s | 2.47–2.56 s |
| 数据不变的父组件重渲染 | 2.13–2.22 s，300 节全部重新解析 | 0.16–0.44 s，重新解析 0 节 |

回归测试修复前失败（6 次解析，预期 2 次）。剩余的耗时主要来自 jsdom 自身的协调和引用链接的 context 更新。没有在真实浏览器里跑 Profiler。

### 其他

- **【已修】旧候选的深链接**：链接到已关闭的候选修订时，只会在 4 个固定章节里查找，模块章节的旧修订一律显示“候选不存在”。现在按概览返回的全部章节查找，并改为先扫元数据，找到后再读那一版正文。原来每页按 200 条全文分页扫描，最坏约 12.8 MB 一页。
- **状态与样式**：
  - 加载、错误、未启用三种状态都有骨架屏或 `CollectionPageState`；
  - 组件里没有写死颜色或 Tailwind 默认字号，全部用语义 token；
  - 窄屏下目录不再吸顶（见 B4）。

  以上是读代码得出的结论，没有在浏览器里截图走查。
- **CLI**：`engineering set` 的 403 提示是中文，其他错误提示都是英文；`--current-stage` 的帮助文本显示“默认 1”，实际上只有显式传入才会生效。两处都是文案问题，记入非阻断池。

## ⑤ 分级处置

### A 类（已修复，同一 PR）

1. 章节修订批量读取：概览、索引、小节读取、claim 摘要的 SQL 从 2N+1 次降到 1 次。
2. 读路径在写响应前释放快照锁。
3. 小节读取的 CPU 热点修复。
4. PATCH 的 UUID 格式校验提到加锁之前。
5. 新增只读配置的 `with_chapters=false` 和历史元数据的 `with_content=false`，详情页、侧栏、CLI、历史列表改为使用它们。
6. 工程相关查询键移出项目前缀，补上重连失效和删除项目时的清理。
7. 深链接覆盖模块章节，并改为先扫元数据。
8. Markdown 解析复用，匹配器每节只建一次。
9. 删除前端无调用方的读取接口。

### B 类（待拍板，代码未动）

| # | 事项 | 量化依据 | 方案与影响 | 建议 |
|---|---|---|---|---|
| B1 | claim 摘要没有条数上限 | 测试只覆盖 4 个固定章节（≤ 2,000 字、≤ 14 行）。每多一个模块章节就多一行，24 章时约 7 KB、33 行，每个任务都会注入 | a 维持现状；b 最多列 N 章，其余写成“另有 K 个模块，用 `--index` 查看”；c 模块只列标题不列小节 | **b**，按约 2,000 字的总预算截断。这会改变智能体看到的提示内容 |
| B2 | 基线页一次渲染并下载整本 | 24 章 × 60 KB 时概览为 3.19 MB，首次渲染 2.5 s（jsdom） | a 维持现状；b 按章节懒加载（改接口和交互）；c 只对视口外章节用 `content-visibility` | **a**。重渲染开销已经消除。等实际基线超过约 10 章 × 30 KB 再评估 b |
| B3 | 概念自动链接大小写不一致 | 匹配用的正则不区分大小写，查找却要求大小写完全一致，所以大小写不同的提及会被匹配到又悄悄丢掉 | a 查找也改成不区分大小写，英文概念的大小写变体会出现链接；b 概念部分的正则改为区分大小写，页面不变，只是不再白白匹配 | 建议 **a**，更符合正则的原意；它会改变页面上的链接，所以请拍板 |
| B4 | 窄屏（< lg）下目录不吸顶 | 窄屏时目录会把全部章节和小节铺在正文之前，300 节时正文被推到很靠下 | 窄屏下把目录折叠起来，或只列章节 | 建议做，属于界面改动 |

**交给 F06（OL-1277）**：批注的 batches 和 details 查询键也挂在项目前缀下，基线页上存在同样的刷新风暴，建议按本 PR 的方式移出。

## 验证

- **Go**：
  - `./internal/handler` 中 Labrastro/Project/Claim/Baseline/Engineering 相关测试加 `-race` 通过；
  - `./internal/engineering`、`./internal/middleware`、`./cmd/multica`、`./cmd/migrate` 通过；
  - `go vet` 通过。
- **前端**：
  - core 全量 284 个文件 3,740 个用例通过；
  - views 全量 699 个文件：两次满负载并行运行时，分别有 2 个和 9 个与本改动无关的用例超时（升级弹窗、富文本、workflow、agent 文件夹、autopilot 弹窗、issue 详情）。这 8 个文件单独重跑全部通过（240 个用例）；
  - core、views、web、desktop 的 `tsc` 通过；
  - lint 0 个错误，触及的文件里没有新增告警。
