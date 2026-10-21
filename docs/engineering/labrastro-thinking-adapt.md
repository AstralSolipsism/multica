# 自适应思考挡位：架构与接口契约

OL-992 给智能体的"思考"属性增加第三种挡位设定"自适应"：由决策引擎在每次运行开始前（Claude 还在每一步之前）从当前模型的候选挡位里选一个挡位。本文是 OL-992 各子任务共用的契约，整理自 OL-992 描述中的"架构设计与接口契约"。

- 术语以根目录的 [`GLOSSARY.md`](../../GLOSSARY.md) 为准；为什么把自适应存为 `_adapt`，见 [ADR 0001](../adr/0001-adapt-as-reserved-thinking-level.md)。
- 除 §0 记录的现状外，本文描述的是约定的接口，由[分工](#分工)表里的子任务实现；文中出现的新常量、新文件和新字段，在对应子任务合入前并不存在。
- 子任务改动契约时，在同一个 PR 里更新本文。
- 本文与已合入的代码不一致时视为缺陷：要么修代码，要么在同一个 PR 里修正本文。

## 决策记录

负责人 2026-10-21 在 OL-992 中确认：

- **D1 命名与存储**：叫"自适应"（英文 Adapt），不新增字段，存为 `thinking_level` 的保留值 `_adapt`。
- **D2 外发**：零配置，不设工作区开关。选项说明写明发送什么、发给谁；机器主人可以在本机关闭。
- **D3 微标位置**：挡位微标放在智能体状态的展示处，不做逐行微标。共三处：Chat 底部状态条、Issue 运行卡片的状态行、执行记录窗口顶部。运行期间（包括执行工具时）一直显示当前挡位；运行结束后只在执行记录窗口顶部保留汇总。
- **D4 挡位范围**：候选挡位包括 max 和 ultra。判据只把它们留给两种情况：同一问题在较低挡位已经失败；正确性优先的极难推理。

OL-992 描述前半部分的原始需求里，"Auto"一律改称"自适应"，`thinking_level = "auto"` 改为 `_adapt`，"原位微标"以 D3 为准。原始需求与本文不一致时，以本文为准。

## 0. 背景事实

2026-10-21 核对，代码位置以当天的 main 为准。

1. **挡位成本倍率因模型而异，远小于原始需求所写。** Claude Code 2.1.304 内置的 `effort_cost_index`（以 high = 1 计）：

   | 模型 | low | medium | xhigh | max |
   |---|---|---|---|---|
   | Opus 5.5 | 0.48 | 0.66 | 1.66 | 3.44 |
   | Sonnet 5.5 | 0.49 | 0.54 | 1.87 | 5.5 |
   | Haiku 5.5 | 0.38 | 0.52 | 2.03 | 4.34 |
   | Fable 5.1 | 0.75 | 0.86 | 1.38 | 1.74 |

   max 与 low 之比约为 2.3–11 倍，不是 80 倍。自适应能省额度，但遇到难题会升挡，不保证总用量下降。
2. **一次运行内换挡，只在一定条件下保留缓存。** CLI 在 `system/init` 里报告 `per_turn_effort_active=true` 时，换挡才保留缓存前缀；目前满足条件的是带 `per_turn_effort` 能力的 Opus 5.5、Sonnet 5.5、Haiku 5.5、Fable 5.1。为 false 时换挡会重写缓存前缀。会话中途还可能收到 `system/per_turn_effort_changed`，变为 false。
3. **有挡位控制的运行时共 12 个（含 claude）**，即 `server/pkg/agent/thinking.go` 中三张表的并集：
   - 固定词表（`providerThinkingEnums`）：claude、codebuddy、pi、omp；
   - daemon 本地目录（`thinkingDynamicCatalogProviders`）：codex、dsh、grok、opencode、kimi；
   - ACP 目录（`acpCatalogThinkingProviders`）：reasonix、hermes、dim。

   例外：
   - deveco 不在三张表里，服务端拒绝任何非空挡位，它也没有挡位目录；
   - dim 的模型发现目前没有标注挡位；
   - hermes 只有 jcode 二进制报告挡位，Hermes Agent 不报告；
   - kimi 需要 ACP ≥ 0.29.0。

   所以是否提供自适应，由发现出的挡位决定，不按运行时名单写死。
4. **`auto` 已经是真实的挡位值。** reasonix 报告 `auto|disabled|low|high|max`，dim 报告 `auto/high/max`，omp 的 `--thinking` 也接受 `auto`（服务端的 omp 词表有意不收）。服务端对动态目录和 ACP 目录类 provider 只校验挡位的格式，`auto` 能通过，所以 reasonix 等运行时的智能体已经可以存这个值。
5. **旧 daemon 会原样透传不认识的挡位。** 领取时的 `thinking_level` 没有能力位门控（`buildClaimedTaskResponse`，`server/internal/handler/daemon.go`）；目录无法验证时，daemon 把值直接交给 CLI（`resolveTaskModelSelection`，`server/internal/daemon/daemon.go`）。
6. **思考行。**
   - Claude 的思考块原先在解析时被丢弃，OL-1001（PR #149）已修复：`claudeContentBlock` 现在读取 `thinking` 字段。
   - Codex 没有思考行。
   - 低挡位时，模型常常不产出思考块。

   只把微标挂在思考行上，正好是降挡的那些步看不到，这是 D3 的依据之一。
7. **运行消息没有元数据字段。** `task_message` 只有给工具输入用的 `input` JSONB。
8. **Jev 服务。**
   - OpenCode Zen：[文档](https://opencode.ai/docs/zen/)写明需要 Console API key，`jev-1.13-free` 是"限时提供"，也没有说明免费档如何处理数据。2026-10-21 实测，`/zen/v1/systemone` 和 `/inference/systemone/v1/systemone` 都能免 key 调通；热连接 340–390ms，冷连接 1.0–1.4s。
   - 百炼：[`decision-model-preview`](https://www.alibabacloud.com/help/zh/model-studio/decision-model-api) 的端点与鉴权见 §3。限制：state ≤ 65,536 tokens，每次请求 ≤ 16 个问题，choice 有 1–255 个选项。"限时免费"未能核实。
   - 响应格式：`answers.<id>.{choice, confidence, probabilities}`。
9. **Claude Code 2.1.304 的 mod API。** `turn.step` 可以改写 `effort`（只接受 `low|medium|high|xhigh|max`）；另有 `$.http.fetch`（默认 30s 超时、4MiB 上限、可走 `socketPath`）和 `$.session.messages`。改写是否真正生效、能否访问回环地址、从哪个版本起可用，由 OL-1000 核实。
10. **max 与 ultra 的定位。**
    - Anthropic：max 用于"正确性比成本更重要"的场合；最高几档"只在难题上值回成本，应在实测显示下一档仍有不足时再升"。在长链路编码上，最高几档以数倍成本换来很少的提升；"先用低挡、只把失败的部分放到高挡重跑"，能以略多于一半的成本保持同等通过率。
    - Claude Code 把 Max 当作只对当前会话生效的特例。
    - Codex：仓库内置的 Codex 目录（`codexStaticModels`，`server/pkg/agent/models.go`）把 max 描述为"为最难问题提供最大推理深度"，把 ultra 描述为"最大推理并自动分派子任务"；ultra 只有部分模型提供。

## 1. 术语与代码中的名字

术语的定义见 [`GLOSSARY.md`](../../GLOSSARY.md)。下表把术语对应到代码和协议里的名字：

| 术语 | 代码与协议中的名字 |
|---|---|
| 挡位 | `thinking_level` 的取值；Go 中为 `ThinkingLevel` |
| 跟随 CLI 配置 | `thinking_level` 为空 |
| 固定挡位 | `thinking_level` 的其他取值；消息元数据中为 `mode: "fixed"` |
| 自适应 | `thinking_level = "_adapt"`（常量 `ThinkingLevelAdapt`）；能力位 `thinking-adapt-v1`；消息元数据中为 `mode: "adapt"` |
| 运行 | `task`（如 `task_message`） |
| 步 | 消息元数据中的 `step` |
| 候选挡位 | `AdaptThinkingCandidates` |
| 决策引擎 | Jev；daemon 配置前缀 `MULTICA_JEV_` |
| 决策 | Jev 客户端返回的 `Decision` |
| 回退 | 消息元数据中的 `fallback` |

补充三条边界：

- `thinking_level` 的其余取值保持原义。reasonix、dim 的 `auto` 是 CLI 自己的挡位，与自适应无关。
- 候选挡位取自当前 (provider, model) **已验证**的目录，去掉 `auto` 和关闭思考类（`off`、`none`、`disabled`），保留 max、ultra（D4）。剩下不足 2 个时不提供自适应。
- 回退在以下情况发生：超时、出错、返回值不在候选里、熔断中、本机关闭，以及这次运行拿不到候选挡位。运行级回退为不注入挡位（同跟随 CLI 配置）；步级回退为不改写这一步的挡位。任何情况下都不阻塞、不中断运行。

## 2. 存储、校验与领取（D1、D2）

- **存储**：不新增字段，也不需要迁移。常量 `ThinkingLevelAdapt = "_adapt"`（`server/pkg/agent`），注释写明前导下划线的用意。
- **候选规则**：`AdaptThinkingCandidates(levels)` 去掉 `auto`、`off`、`none`、`disabled`，其余保持目录里的顺序；调用方自己检查结果是否不少于 2 个。规则同时导出为 JSON 测试向量（`server/pkg/agent/testdata/adapt_thinking_candidates.json`），前端用同一组向量实现同一规则。
- **校验**（`server/internal/handler/agent.go` 的 Create、Update）：`_adapt` 的判断放在现有的 `IsKnownThinkingValue` 之前，满足以下全部条件才接受，否则返回 400：
  - provider 满足 `ThinkingControlSupported`；
  - codex、omp 必须指定 model；
  - reasonix、hermes、dim 按缓存目录判断所选模型（未指定时为目录的默认模型）的候选不少于 2 个。

  其他取值的校验和错误信息不变。
- **换运行时、换模型、复制**：
  - 换运行时：与现有逻辑一样，把 model、`thinking_level`、`service_tier` 一并清空；没有显式改 `thinking_level` 的请求，服务端也清掉 `_adapt`。
  - 换模型：新模型不再满足条件时清空。服务端按上面的校验条件判断；前端按目录里的候选挡位判断，目录未知时不动（与 `buildModelChangeUpdate` 对固定挡位的处理一致）。
  - 复制智能体：同一运行时内保留，跨运行时丢弃，与现有行为一致。
- **领取**：能力位 `thinking-adapt-v1`（`protocol.DaemonCapabilityThinkingAdaptV1`）。领取请求没带这个能力位时，`buildClaimedTaskResponse` 把 `_adapt` 改写为空值再下发，旧 daemon 就按跟随 CLI 配置执行；带了才原样下发。daemon 在实现 §5 的同时声明这个能力位。
- **daemon 兜底**：`_adapt` 永远不进入任何 CLI 参数或 ACP 调用。`resolveTaskModelSelection` 必须在挡位校验之前处理它，因为目录无法验证时，这个函数会把值原样交给 CLI（§0.5）。
- **CLI**：`multica agent create/update --thinking-level` 的帮助文案说明 `_adapt`。
- **工作区开关**：没有（D2）。

## 3. daemon 决策引擎

决策引擎客户端是 daemon 内的独立包，只依赖标准库和 daemon 的配置加载。

### 配置

只在 daemon 本机配置，做法照 `MULTICA_ZENMUX_*`：只读环境变量，不写日志、不序列化、不上报。

| 变量 | 含义 | 默认值 |
|---|---|---|
| `MULTICA_JEV_DISABLED` | 为真时本机关闭，自适应一律回退 | 不设置 |
| `MULTICA_JEV_SOURCES` | 逗号分隔的有序来源列表 | `opencode-free` |
| `MULTICA_JEV_TIMEOUT_MS` | 单个来源的硬超时（毫秒） | `1500` |
| `MULTICA_JEV_OPENCODE_API_KEY` | `opencode` 来源的 key | — |
| `MULTICA_JEV_DASHSCOPE_API_KEY` | `dashscope` 来源的 key | — |
| `MULTICA_JEV_DASHSCOPE_WORKSPACE_ID` | `dashscope` 来源的业务空间 ID | — |
| `MULTICA_JEV_DASHSCOPE_REGION` | `cn-beijing` 或 `ap-southeast-1` | `cn-beijing` |

缺少必需变量的来源直接跳过，只告警一次。这些变量写进 `apps/docs/content/docs/environment-variables.mdx` 及其各语言版本，并写清三点：默认零配置时，选了自适应的运行会把脱敏、截断后的运行摘要发到 OpenCode Zen 免费通道；`MULTICA_JEV_DISABLED=1` 可以在本机关闭；key 只留在本机。

### 来源

| 来源 | 端点 | model | 鉴权 |
|---|---|---|---|
| `opencode-free` | `https://opencode.ai/zen/v1/systemone` | `jev-1.13-free` | 不带鉴权头 |
| `opencode` | 同上 | 默认 `jev-1.13` | `Bearer $MULTICA_JEV_OPENCODE_API_KEY` |
| `dashscope` | `https://{workspace_id}.{region}.maas.aliyuncs.com/compatible-mode/v1/systemone` | `decision-model-preview` | `Bearer $MULTICA_JEV_DASHSCOPE_API_KEY` |

百炼必须使用带业务空间 ID 的 `maas.aliyuncs.com` 地域域名。原始需求记录：通用域名 `dashscope.aliyuncs.com` 的 systemone 路径返回 404。

### 请求与响应

- **请求**：`POST .../v1/systemone`，`Content-Type: application/json`。请求体不压缩，也不设置 `Content-Encoding`。原始需求记录：OpenCode Zen 网关不解压 zstd，会返回空的 HTTP 400；官方 Node SDK 在请求体较大时默认开启 zstd。
- **请求体**：

  ```json
  {
    "model": "jev-1.13-free",
    "state": "...",
    "questions": {
      "effort": {
        "type": "choice",
        "instructions": "...",
        "criteria": { "<候选挡位>": "<判据>" }
      }
    }
  }
  ```

  `state` 可以是字符串或 JSON 对象，内容见 §4。
- **响应**：读取 `answers.effort.{choice, confidence, probabilities}`；顶层的 `latency_ms` 可以缺失。`choice` 不在候选里时，视为该来源失败。

### 容错

- 所有来源共享一个保持长连接的 HTTP 连接池；每个来源单独做硬超时。
- 超时、网络错误、非 2xx、JSON 不合法或 `choice` 不合法时，切到下一个来源。全部失败则回退，原因为 `timeout`、`error` 或 `invalid`。
- 熔断：所有来源连续失败 3 次后，60 秒内不发请求，直接回退（原因为 `breaker`）；到期后放行一次试探。
- 本机关闭时不发请求，直接回退（原因为 `disabled`）。

### 决策

客户端返回的 `Decision` 包含 `Level`、`Confidence`、`Probabilities`、`LatencyMS`（本地测得的端到端耗时）和 `Source`（来源名称）。

### 健康快照

每个 daemon 一份，供 §8 上报：

| 字段 | 含义 |
|---|---|
| `status` | `idle`、`available`、`degraded`、`unavailable`，见下 |
| `active_source` | 最近一次成功的决策或探测所用的来源名称 |
| `last_latency_ms` | 最近一次成功的决策或探测的耗时 |
| `decisions_ok`、`decisions_fallback` | 本次 daemon 启动以来，客户端返回成功决策与回退的次数；`no_candidates`（§5）不经过客户端，不计入 |
| `since` | 计数的起点，即本次 daemon 启动的时间 |
| `updated_at` | 快照最近一次变化的时间 |

状态：

- `unavailable`：本机已关闭，或熔断中；
- `idle`：没有关闭，且本次启动后还没有做过决策；
- `available`：最近一次决策或探测成功；
- `degraded`：最近一次决策或探测失败，但还没有熔断。

快照只含来源名称，不含 URL、key 或运行内容。

**探测**：daemon 本次启动后为自适应做过真实决策，之后 10 分钟内又没有新的真实决策时，发一次不含业务内容的合成探测，每 10 分钟最多一次。探测只更新快照，不计入决策次数。从未用过自适应的 daemon 不探测，保持 `idle`。

## 4. 判据与 state

运行级和步级决策共用这一节的规则。

### 判据（criteria）

- 按候选挡位的顺序，把它们映射到"机械 → 常规 → 深入 → 最深"几档语义，并附上 CLI 自己的 label 和 description。
- 已知 token 的顺序是 `none < minimal < low < medium < high < xhigh < max < ultra`；无法排序的自定义值只用它自己的 label 和 description。
- 最高档（max、ultra）的判据写明只用于两种情况（D4）：
  - 同一问题在较低挡位已经失败，例如同一个报错修了仍然复现，或触发评论说上次没修好；
  - 正确性优先的极难推理。

### state

- **运行级**：运行类型（任务触发、Chat 消息或自动化）、标题、描述前 1500 字、触发评论前 1000 字、provider、model。
- **步级**：运行目标（同上的标题与描述）前 500 字、步序号、上一步助手文本前 500 字、上一步工具调用的名称与输入摘要、工具结果首尾各 400 字（含退出码和报错特征），以及最近若干步里同类报错的重复次数。
- **处理**：所有发往决策引擎的 state 都由 daemon 构造，先过 `server/pkg/redact.Text` 脱敏，总长截到 4KB。不得包含智能体指令、skill 内容、环境变量和文件全文。

### 判据评测

用一组代表性的 state fixture 评测判据，分别用 Claude（low 到 max）和 Codex（minimal 到 ultra）两组候选各跑一遍。预期：

- 机械类（读文件之前、收尾、改错别字、升级依赖）选候选中的最低或次低挡，绝不选 max、ultra；
- 低级报错（编译错误、连接被拒绝）不高于 medium；
- 第一次出现的深层问题（刚读入复杂的并发代码、`DATA RACE`、核心断言失败、并发竞态、架构死锁）选 high 或 xhigh；
- 重复失败后的升级场景选 max；Codex 上可以是 max 或 ultra。

## 5. 运行级决策

在 `resolveTaskModelSelection`（`server/internal/daemon/daemon.go`）定位模型之后：

1. 若 `thinking_level == "_adapt"`，从已验证的目录（`Catalog.Verified()`）取出该模型的挡位，求出候选。
2. 目录未验证、候选不足 2 个，或 codex/omp 没有指定 model 时，不调用 Jev，也不注入挡位，记一条 info 日志，按回退处理（原因为 `no_candidates`）。
3. 否则按 §4 构造判据和 state，调用 Jev，把结果写入 `ThinkingLevel`；回退时置空。
4. fresh-session 重试和 codex 的第二次尝试复用同一个决策，不再调用 Jev。

选中的挡位走各运行时现有的注入路径：claude 的 `--effort`、codex 的 `model_reasoning_effort`、opencode 的 `--variant` 或 `#level`、pi/omp 的 `--thinking`、kimi/reasonix/hermes 的 `set_config_option`。跟随 CLI 配置和固定挡位的路径保持原样：不构造判据，不调用 Jev。

## 6. Claude 的步级换挡

传输通道和最低 CLI 版本以 OL-1000 的结论为准；结论与本节不同时，在 OL-1010 放行前更新本节。

- **启用条件**：同时满足
  - claude 运行时、挡位设定为自适应；
  - CLI 版本不低于步级换挡的最低版本；
  - 本次运行的 `system/init` 报告 `per_turn_effort_active=true`。
- **启用标记**：daemon 读到 init 为 true 时写入 `<task config>/effort/enabled`；读到 `system/per_turn_effort_changed` 降为 false 时删除它。mod 每一步先查这个标记，没有就不改写。
- **每一步**：
  - 第 1 步用运行级决策的挡位。
  - 从第 2 步起，主线程的每一步都向 daemon 要决策。成功则 `yield* next({ ...e, effort })`；失败或超时（总计约 2s）则 `next(e)`，不改写这一步。
  - 子智能体的请求不改写。
- **mod**：名为 `labrastro-effort`，与 `labrastro-ysk` 一起通过 `CLAUDE_CODE_PLUGIN_DIRS` 加载，安装方式照 `prepareYouShouldKnow`（`server/internal/daemon/labrastro_ysk.go`）。
- **mod → daemon**：`POST http://127.0.0.1:{MULTICA_DAEMON_PORT}/tasks/{task_id}/thinking-decision`，带 `Authorization: Bearer $MULTICA_TOKEN`。
  - daemon 的健康服务（`serveHealth`）校验 token 和活跃运行，做法照 `/repo/checkout`。
  - 请求体由 OL-1010 定义，内容是上一步的原料和同类报错的重复次数；daemon 按 §4 构造 state，调用 Jev，并计入健康快照。
  - 返回 `{level, confidence, probabilities, latency_ms, source}`，或回退原因。
  - 回环地址不可达时，按 OL-1000 推荐的通道实现。
- **生效回报**：mod 改写后用 `$.ui.log` 写一行生效记录。daemon 照 `consumeYouShouldKnowLog`（`server/pkg/agent/labrastro_ysk.go`）的做法把这一行从流里摘走，不成为运行消息，并用它给这一步之后的消息打标（§7）。

## 7. 运行消息的元数据

- **字段**：`task_message.metadata JSONB NULL`，fork 迁移，不加默认值和索引。
  - daemon 在消息上附带它；元数据不同的相邻消息不得合并成一条。
  - 服务端只接受 JSON 对象，单条上限 4KB；不合格时只丢弃这个字段并告警，不拒绝整批。
  - `GET /api/tasks/{taskId}/messages` 和 WS `task:message` 原样带回。core 的 schema 宽松解析：未知字段保留，坏值降为 undefined。
- **结构**：

  ```ts
  type ThinkingMetadata = {
    level: string; // always present; "" on fallback
    mode: "adapt" | "fixed";
    step?: number; // 1-based
    source?: string;
    confidence?: number;
    probabilities?: Record<string, number>;
    latency_ms?: number;
    fallback?: "timeout" | "error" | "invalid" | "breaker" | "disabled" | "no_candidates";
  };
  // task_message.metadata = { thinking: ThinkingMetadata }
  ```

  `level` 必须出现，回退时为空字符串，并用 `fallback` 写明原因。
- **打标**：
  - 打在每条 thinking 消息上，以及每一步的第一条消息上。
  - Claude 的一步是主线程（`parent_tool_use_id` 为空）的一次模型请求；同一次请求可能拆成多条 assistant 事件，它们共用一个消息 ID。其他运行时把整次运行当作一步。
  - 自适应：`mode: "adapt"`，带上决策的各项字段；回退时 `level` 为空、写明 `fallback`。
  - 固定挡位：`{mode: "fixed", level}`。
  - 跟随 CLI 配置：不打标。
- **用途**：驱动智能体状态处的当前挡位和运行汇总（D3）。
- **禁止**：不新增消息类型，不产生评论，也不产生独立的日志行。

## 8. 快照上报与展示

- **上报**：健康快照作为心跳的可选字段 `thinking_adapt`，只附在 provider 满足 `ThinkingControlSupported` 的运行时心跳上；HTTP 和 WS 两种心跳都要带（`heartbeatExtrasFor`）。
- **存储**：服务端按 (workspace, daemon) 存进 Redis，做法照 host metrics（`server/internal/handler/runtime_host_metrics_store.go`）：TTL 90 秒，较新的样本胜出。快照变化时发出 `runtime:telemetry_updated {daemon_id}`，节流方式与 host metrics 相同。没有 Redis 时静默不存。
- **接口**：`GET /api/runtimes` 的每行增加 `thinking_adapt` 字段：运行时有挡位控制、且有快照时才有值，其余为 null（与 `system_stats` 一致）。core 的 runtime schema 对它宽松解析，未知的 `status` 也能降级。

## 9. 前端

### 选择器

改动在 `packages/views/agents/components/inspector/` 的 `thinking-picker.tsx` 和 `thinking-prop-row.tsx`。

- **出现条件**：候选不少于 2 个时，在列表顶部提供"自适应"，选中时写入 `thinking_level = "_adapt"`。候选规则在 core 里实现，单测直接读 §2 的测试向量。
- **置灰**：运行时的 `metadata.capabilities` 不含 `thinking-adapt-v1` 时置灰，并说明 daemon 版本过旧、需要升级。置灰只是提示，真正的门控是领取时的改写（§2）。
- **副标题**：显示该运行时 `thinking_adapt` 快照的状态（例如"可用 · OpenCode Zen · 290ms"），并用一句话说明：选中后会把脱敏后的运行摘要发给外部决策服务，默认是 OpenCode Zen 免费通道。
- **显示**：触发器、只读态、资料卡都显示"自适应"，不显示 `_adapt`。reasonix、dim 自己的 `auto` 仍按 CLI 的 label 显示，要能和"自适应"区分。
- **清理**：换模型后，新模型仍有不少于 2 个候选时保留自适应，否则清掉；换运行时清掉；同一运行时内复制智能体时保留（§2）。

### 额度区

有快照时，在 `RuntimeQuotaCell` 和 `RuntimeQuotaCard`（`packages/views/runtimes/components/runtime-quota-cell.tsx`）里加一行。没有 `plan_quota` 时也要显示这一行；没有快照时不显示。

| 状态 | 显示 |
|---|---|
| `available` | 绿点 + 来源 + 延迟 |
| `degraded` | 黄点 + 说明 |
| `unavailable` | 黄点 + "暂不可用（自适应已回退默认挡位）" |
| `idle` | 灰点 + "尚未使用" |

悬停显示本次 daemon 启动以来的成功次数和回退次数。

### 状态微标（D3）

| 位置 | 文件 | 放在哪 |
|---|---|---|
| Chat 底部状态条 | `packages/views/chat/components/task-status-pill.tsx` | 阶段文案之后，例如"思考中 · xhigh · 12s" |
| Issue 运行卡片收起时的状态行 | `packages/views/issues/components/inline-comment-run.tsx` | `RunActivitySummary` 旁，保持它的文本节点稳定 |
| 执行记录窗口（"智能体执行记录"）顶部 | `packages/views/common/task-transcript/agent-transcript-dialog.tsx` | "进行中"状态徽标旁 |

- **内容**：
  - 当前挡位取消息序列里最近一次的 `metadata.thinking`，直接基于原始消息计算，不改 `buildTimeline` 的合并逻辑。
  - 自适应：显示挡位，并与上一步比较，带 ↑ 或 ↓；无法排序时不带。
  - 回退：显示"默认"。
  - 固定挡位：只显示挡位，不带箭头。
  - 跟随 CLI 配置、没有元数据的旧消息：不显示。
- **时段**：运行期间一直显示，执行工具时也显示，此时表示发起这次调用的那一步的挡位。运行结束后，Chat 状态条和卡片状态行随之消失，只在执行记录窗口顶部保留汇总，例如"自适应 · 8 次 · 最高 xhigh"。
- **Tooltip**：
  - 自适应：决策详情，例如"Jev 动态决策：xhigh · 置信度 88% · 耗时 284ms · 来源 OpenCode Zen"，加上概率分布；
  - 回退：原因（超时、出错、返回值无效、熔断、本机关闭、拿不到候选挡位）；
  - 固定挡位："固定挡位"；
  - 汇总：每一步的挡位序列和回退次数。
- **交互**：微标所在的行仍可点击，不得破坏行的点击、展开和键盘可达性。
- **禁止**：不做逐行微标。

### 文案与范围

- 新文案同步 `en`、`zh-Hans`、`fr`、`ja`、`ko`，按 [`branding.md`](branding.md) 放进 fork 命名空间，并通过 `packages/views/locales/parity.test.ts`。英文名用 Adapt。
- 移动端不在范围内（需求未要求），新字段对移动端透明。

## 未决事项

- **步级换挡的通道与最低版本**（§6）：等 OL-1000 的结论。
- **一步回退时实际生效的挡位**：回退时不改写这一步，这一步按 CLI 收到的挡位执行。这个挡位是启动时的挡位，还是上一步改写后的挡位，由 OL-1000 核实。在此之前按 §7 记录：`level` 为空，写明 `fallback`。
- **deveco 的挡位目录**：DevEco CLI 能否列出每个模型的 variant，由 OL-1007 调查；不能列出时，deveco 不提供自适应。

## 分工

| 子任务 | 内容 | 对应章节 |
|---|---|---|
| OL-1000 | 可行性验证：Claude 步级换挡（不合入代码） | §0.2、§0.9、§6 |
| OL-1001 | 修复 Claude 思考块被丢弃（PR #149） | §0.6 |
| OL-1002 | daemon 的 Jev 决策客户端 | §3 |
| OL-1003 | 运行消息的元数据通道 | §7 |
| OL-1004 | `_adapt` 的校验、候选规则、领取与 CLI | §1、§2 |
| OL-1005 | 运行级自适应、判据评测、打标 | §4、§5、§7 |
| OL-1006 | 健康快照的上报、存储与接口 | §3、§8 |
| OL-1007 | dim 与 DevEco 的挡位目录 | §0.3 |
| OL-1008 | 前端：选择器与额度区 | §9 |
| OL-1009 | 前端：状态微标与悬停详情 | §7、§9 |
| OL-1010 | Claude 步级换挡的 mod 与 daemon 端点 | §6、§7 |
| OL-1011 | 端到端联调与验收证据（不合入代码） | 全文 |
| OL-1012 | 术语表、ADR 与本文 | — |
