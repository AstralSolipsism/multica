# 自适应思考挡位：架构与接口契约

OL-992 给智能体的"思考"属性增加第三种挡位设定"自适应"：由决策引擎在每次运行开始前（Claude 还在每一步之前）从当前模型的候选挡位里选一个挡位。本文是 OL-992 各子任务共用的契约，整理自 OL-992 描述中的"架构设计与接口契约"。§10 是 OL-1013 的扩展：把平台自己微调的决策模型接成一个来源，并采集决策样本用于训练。

- 术语以根目录的 [`GLOSSARY.md`](../../GLOSSARY.md) 为准。为什么把自适应存为 `_adapt`，见 [ADR 0001](../adr/0001-adapt-as-reserved-thinking-level.md)；为什么自部署决策模型以独立服务接入，见 [ADR 0002](../adr/0002-self-hosted-decision-model-as-separate-service.md)。
- 除 §0、§10.0 记录的现状外，本文描述的是约定的接口，由[分工](#分工)表里的子任务实现；文中出现的新常量、新文件和新字段，在对应子任务合入前并不存在。
- 子任务改动契约时，在同一个 PR 里更新本文。
- 本文与已合入的代码不一致时视为缺陷：要么修代码，要么在同一个 PR 里修正本文。

## 决策记录

负责人 2026-10-21 在 OL-992 中确认：

- **D1 命名与存储**：叫"自适应"（英文 Adapt），不新增字段，存为 `thinking_level` 的保留值 `_adapt`。
- **D2 外发**：零配置，不设工作区开关。选项说明写明发送什么、发给谁；机器主人可以在本机关闭。
- **D3 微标位置**：挡位微标放在智能体状态的展示处，不做逐行微标。共三处：Chat 底部状态条、Issue 运行卡片的状态行、执行记录窗口顶部。运行期间（包括执行工具时）一直显示当前挡位；运行结束后只在执行记录窗口顶部保留汇总。
- **D4 挡位范围**：候选挡位包括 max 和 ultra。判据只把它们留给两种情况：同一问题在较低挡位已经失败；正确性优先的极难推理。

OL-992 描述前半部分的原始需求里，"Auto"一律改称"自适应"，`thinking_level = "auto"` 改为 `_adapt`，"原位微标"以 D3 为准。原始需求与本文不一致时，以本文为准。

OL-1013 的需求另外写明三条边界，§10 照此执行：

- 不把 ONNX Runtime 编进 `multica`，自部署模型由独立的 `/v1/systemone` 服务提供（ADR 0002）；
- 不拿没有微调过的 Laya 底座直接上线，自部署来源通过门禁评测后才能排在外部来源前面；
- 采集器不记录未脱敏的原文或文件内容。（OL-1083 起决策链路不再脱敏，样本里的 state 即未脱敏原文，只留在本机、不得外传。）

负责人 2026-10-21 在 OL-1013 中决定：

- **E1 训练用的算力**：原定放在 GCP，已由下面的方案 A 改为在 149 本机的 GPU 上训练；为 GCP 训练机准备的设置指南 OL-1026 已取消。
- **E2 用外部来源的决策训练自己的模型**：接受。模型只在内部使用，不对外提供服务。
- **E3 宿主机操作**：等本期其他改造完成、统一部署时再推进，届时由负责人指派运维专员。在此之前，不做任何涉及宿主机的运维工作，包括开启采集（OL-1022）、训练（OL-1023）和部署（OL-1024）。

负责人同日经产品经理确认**方案 A**，取代原先 EdgeJev、ONNX 导出、GCP 训练机和 CPU 延迟的安排：

- **服务栈**：淘汰 EdgeJev，训练和服务都用原生 Laya（`laya-train`、`laya-serve`），不再导出 ONNX。依据是 OL-1018 的实测，见 §10.0。
- **线上推理**：`laya-serve` 以 FP16 常驻 149 的 RTX 2080 SUPER，与 kb-worker 共用这张卡（OL-1032）。
- **延迟门槛**：在 149 的 GPU 上以 FP16 推理，按真实 state 长度分布测，P95 < 100ms；运行级和 Claude 步级都适用。这一条取代原始需求验收里的"4 核 CPU ≤ 50ms"。
- **训练**：在 149 本机 GPU 的空闲窗口进行，样本留在 149，不再外传。显存规则和预检见 §10.5。

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
2. **一次运行内换挡，只在一定条件下保留缓存。** CLI 在 `system/init` 里报告 `per_turn_effort_active=true` 时，换挡才保留缓存前缀。OL-1000 在 2.1.304 上实测：
   - **init 的取值**：Opus 5.5、Sonnet 5.5、Haiku 5.5、Fable 5.1 为 true；Sonnet 5、Opus 5 为 false。
   - **为 true 时**：Haiku 5.5、Sonnet 5.5 两次换挡后，下一次请求的 `cache_read_input_tokens` 都等于上一次请求的全部提示量。换挡步写缓存的量与不换挡的步相同，约 130–180 token。Opus 5.5、Fable 5.1 只核对了 init，没有实测缓存。
   - **为 false 时**：首次切到某个挡位，整个前缀都要重写；Sonnet 5 上 `cache_read` 为 0，写入 28.6k。切回之前用过的挡位，复用该挡位上次写到的位置，只补写其后的部分。
   - **`system/per_turn_effort_changed`**：7 次真实运行都没有收到。它只在服务端拒绝消息内的挡位声明时出现：先出 `changed=false`，再出重试后的 assistant；之后 CLI 不再发送消息内声明。这一点是用模拟 400 复现的。
3. **有挡位控制的运行时共 13 个（含 claude）**，即 `server/pkg/agent/thinking.go` 中三张表的并集：
   - 固定词表（`providerThinkingEnums`）：claude、codebuddy、pi、omp；
   - daemon 本地目录（`thinkingDynamicCatalogProviders`）：codex、dsh、grok、opencode、kimi、deveco；
   - ACP 目录（`acpCatalogThinkingProviders`）：reasonix、hermes、dim。

   例外：
   - deveco 已接入动态目录（OL-1007）：`deveco models --verbose` 逐模型打印含 `variants` 的 JSON，解析后即挡位目录；DevEco 内置的 GLM-5/GLM-5.1 不派生 variant，默认安装下没有挡位选择，只有 GLM-5.2、第三方 provider 或在 `deveco.jsonc` 里自定义了 variant 的模型才有。deveco 的目录不标记默认模型，与 codex、omp 一样要求钉住模型才能存挡位；
   - dim 的模型发现已标注挡位（OL-1007）：session/new 带 `thought_level` 时，当前模型获得挡位目录，其余模型没有；
   - hermes 只有 jcode 二进制报告挡位，Hermes Agent 不报告；
   - kimi 需要 ACP ≥ 0.29.0。

   所以是否提供自适应，由发现出的挡位决定，不按运行时名单写死。
4. **`auto` 已经是真实的挡位值。** reasonix 报告 `auto|disabled|low|high|max`，dim 报告 `auto/high/max`，omp 的 `--thinking` 也接受 `auto`（服务端的 omp 词表有意不收）。服务端对动态目录和 ACP 目录类 provider 只校验挡位的格式，`auto` 能通过，所以 reasonix 等运行时的智能体已经可以存这个值。
5. **旧 daemon 会原样透传不认识的挡位。** 领取时的 `thinking_level` 没有能力位门控（`buildClaimedTaskResponse`，`server/internal/handler/daemon.go`）；目录无法验证时，daemon 把值直接交给 CLI（`resolveTaskModelSelection`，`server/internal/daemon/daemon.go`）。
6. **思考行。**
   - Claude 的思考块原先在解析时被丢弃，OL-1001（PR #149）已修复：`claudeContentBlock` 现在读取 `thinking` 字段。
   - 但在 daemon 现行的启动参数下，请求带的是 `thinking: {type: "adaptive", display: "updates"}`。思考块的实际形态是 `{"type":"thinking","thinking":"","signature":"…"}`，文本恒为空，`claude.go` 不为空思考产出消息。所以 Claude 运行目前仍然没有思考行（OL-1000）。
   - 加上 `--thinking-display summarized` 后会有摘要文本，缓存也保持连续；这个参数不在 2.1.304 的 `claude --help` 里。本需求不依赖思考行，不改这个参数。
   - 任何挡位都不保证有思考块，low 下也可能有：Haiku 5.5 在 low、high 都有；Sonnet 5 只在 high 有；Sonnet 5.5 都没有。样本很小，只能说明不保证出现。
   - 同一次请求的思考与随后的 text、tool_use 是几条 assistant 事件，共用一个 `message.id`。
   - Codex 没有思考行。

   只把微标挂在思考行上，很多步根本看不到，这是 D3 的依据之一。
7. **运行消息没有元数据字段。** `task_message` 只有给工具输入用的 `input` JSONB。
8. **Jev 服务。**
   - OpenCode Zen：[文档](https://opencode.ai/docs/zen/)写明需要 Console API key，`jev-1.13-free` 是"限时提供"，也没有说明免费档如何处理数据。2026-10-21 实测，`/zen/v1/systemone` 和 `/inference/systemone/v1/systemone` 都能免 key 调通；热连接 340–390ms，冷连接 1.0–1.4s。
   - 百炼：[`decision-model-preview`](https://www.alibabacloud.com/help/zh/model-studio/decision-model-api) 的端点与鉴权见 §3。限制：state ≤ 65,536 tokens，每次请求 ≤ 16 个问题，choice 有 1–255 个选项。"限时免费"未能核实。
   - 响应格式：`answers.<id>.{choice, confidence, probabilities}`。
9. **Claude Code 2.1.304 的 mod API。** `turn.step` 可以改写 `effort`（只接受 `low|medium|high|xhigh|max`）；另有 `$.http.fetch`（默认 30s 超时、4MiB 上限、可走 `socketPath`）和 `$.session.messages`。OL-1000 用真实模型核实：
   - **改写生效**：日志反代抓到的真实请求里，顶层 `output_config.effort` 逐步等于改写值；消息内的 `role: "system"` 挡位声明逐步追加，请求全部成功。
   - **版本**：静态核对发现，2.1.268 的 `turn.step` 只是观察事件，2.1.269 起才能改写 effort；2.1.292 的二进制已有 `per_turn_effort_active` 等字段，但没有实际运行。端到端只实测了 2.1.304。
   - **`next(e)` 不保持上一步的改写**：每一步收到的 `e.effort` 都是启动时的 `--effort`。直接 `next(e)` 发出的也是启动挡位：实测 low → high → `next(e)`，第三步发出的是 medium。
   - **step 输入**：字段为 `{turnId, index, model, effort, messageCount}`。`index` 从 0 开始；主线程没有 `agentId`；`messageCount` 含内部请求内容，不等于 `messages()` 的长度。
   - **`next()` 的返回值**：`{turnId, index, answer, toolUses[{name, input}], stopReason, usage}`。
   - **`$.session.messages()`**：从第二步起，能取到上一步的工具调用和结果。
     - assistant 消息的 `toolUses[]` 带 `tool_use_id`、`tool`、`input`、`result`、`text`；
     - 随后 user 消息的 `toolResults[]` 带 `tool_use_id`、`text`、`isError`、`result`；
     - 同一结果在两处各出现一次，要按 `tool_use_id` 去重；
     - 上一步的助手文字在 `text` 字段，可能单独占一条消息。
   - **回环地址**：设了 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 时，`$.http.fetch` 访问 `http://127.0.0.1:<port>` 和走 `socketPath` 都不受影响，145 次调用没有失败。
     - 完整往返的稳定中位数：TCP 2.1 ms，Unix socket 1.6 ms，真实 daemon 的 `/health` 1.4 ms；
     - 每次运行的首次调用不超过 22 ms。
   - **日志顺序**：`next()` 之前写的 `$.ui.log`，35/35 步都早于该步第一条 assistant 事件，但中间可能插入其他 mod 的日志。ui_log 行的 `plugin` 字段是 mod 名。
   - **与 labrastro-ysk 共存**：`CLAUDE_CODE_PLUGIN_DIRS` 列两个目录时，两个 mod 都注册 `session.start` 和 `turn.step`，每一步依次经过两者；挡位改写和缓存表现不受影响。
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
| 决策引擎 | Jev 客户端（`server/internal/daemon/jev`）；daemon 配置前缀 `MULTICA_JEV_` |
| 来源 | `MULTICA_JEV_SOURCES` 的一项；`Decision.Source`、消息元数据的 `source`、健康快照的 `active_source` |
| 外部来源 | `opencode-free`、`opencode`、`dashscope` |
| 自部署来源 | `self-hosted`；配置前缀 `MULTICA_JEV_SELF_HOSTED_` |
| 决策 | Jev 客户端返回的 `Decision` |
| 回退 | 消息元数据中的 `fallback` |
| 决策样本 | 样本文件中的 `decision` 记录，连同关联的 `outcome` 记录；配置 `MULTICA_JEV_COLLECT_DIR` |
| 结果信号 | 样本文件中的 `outcome` 记录 |
| 挡位不足、挡位过高 | 清洗统计中的两种纠偏类别 |
| 种子样本 | `tools/jev-distill/seeds/*.jsonl` |
| 判据评测 | `MULTICA_RUN_JEV_LIVE=1` 门控的评测命令 |
| 门禁评测 | 流水线的 `gate` 步骤 |

补充三条边界：

- `thinking_level` 的其余取值保持原义。reasonix、dim 的 `auto` 是 CLI 自己的挡位，与自适应无关。
- 候选挡位取自当前 (provider, model) **已验证**的目录，去掉 `auto` 和关闭思考类（`off`、`none`、`disabled`），保留 max、ultra（D4）。剩下不足 2 个时不提供自适应。
- 回退在以下情况发生：超时、出错、返回值不在候选里、熔断中、本机关闭，以及这次运行拿不到候选挡位。运行级回退为不注入挡位（同跟随 CLI 配置）；步级回退为沿用上一步的挡位，由 mod 显式传入（§6），因为不改写会退回启动挡位（§0.9）。任何情况下都不阻塞、不中断运行。

## 2. 存储、校验与领取（D1、D2）

- **存储**：不新增字段，也不需要迁移。常量 `ThinkingLevelAdapt = "_adapt"`（`server/pkg/agent`），注释写明前导下划线的用意。
- **候选规则**：`AdaptThinkingCandidates(levels)` 去掉 `auto`、`off`、`none`、`disabled`，其余保持目录里的顺序；调用方自己检查结果是否不少于 2 个。规则同时导出为 JSON 测试向量（`server/pkg/agent/testdata/adapt_thinking_candidates.json`），前端用同一组向量实现同一规则。
- **校验**（`server/internal/handler/agent.go` 的 Create、Update）：`_adapt` 的判断放在现有的 `IsKnownThinkingValue` 之前，满足以下全部条件才接受，否则返回 400：
  - provider 满足 `ThinkingControlSupported`；
  - `ThinkingRequiresExplicitModel` 列出的 provider（codex、omp、deveco）必须指定 model；
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

只在 daemon 本机配置，做法照 `MULTICA_ZENMUX_*`：只读环境变量，不写日志、不序列化、不上报。请求地址可以出现在本地日志和错误信息里，包括自部署来源的 URL，以及拼进 `dashscope` 端点的业务空间 ID 和地域；`MULTICA_JEV_DASHSCOPE_REGION` 不合法时的告警也带取值。key 没有例外（见 §10.2）。

| 变量 | 含义 | 默认值 |
|---|---|---|
| `MULTICA_JEV_DISABLED` | 为真时本机关闭，自适应一律回退 | 不设置 |
| `MULTICA_JEV_SOURCES` | 逗号分隔的有序来源列表 | `opencode-free` |
| `MULTICA_JEV_TIMEOUT_MS` | 单个来源的硬超时（毫秒） | `1500` |
| `MULTICA_JEV_OPENCODE_API_KEY` | `opencode` 来源的 key | — |
| `MULTICA_JEV_DASHSCOPE_API_KEY` | `dashscope` 来源的 key | — |
| `MULTICA_JEV_DASHSCOPE_WORKSPACE_ID` | `dashscope` 来源的业务空间 ID | — |
| `MULTICA_JEV_DASHSCOPE_REGION` | `cn-beijing` 或 `ap-southeast-1` | `cn-beijing` |

缺少必需变量的来源直接跳过，只告警一次。这些变量写进 `apps/docs/content/docs/environment-variables.mdx` 及其各语言版本，并写清三点：默认零配置时，选了自适应的运行会把运行摘要（包括工具输出原文）发到 OpenCode Zen 免费通道；`MULTICA_JEV_DISABLED=1` 可以在本机关闭；key 只留在本机。

自部署来源的三个变量见 §10.2，决策样本的两个变量见 §10.3。

### 来源

| 来源 | 端点 | model | 鉴权 |
|---|---|---|---|
| `opencode-free` | `https://opencode.ai/zen/v1/systemone` | `jev-1.13-free` | 不带鉴权头 |
| `opencode` | 同上 | 默认 `jev-1.13` | `Bearer $MULTICA_JEV_OPENCODE_API_KEY` |
| `dashscope` | `https://{workspace_id}.{region}.maas.aliyuncs.com/compatible-mode/v1/systemone` | `decision-model-preview` | `Bearer $MULTICA_JEV_DASHSCOPE_API_KEY` |
| `self-hosted` | `$MULTICA_JEV_SELF_HOSTED_URL`（§10.2） | 默认 `self-hosted` | 设置了 `MULTICA_JEV_SELF_HOSTED_API_KEY` 时为 `Bearer $MULTICA_JEV_SELF_HOSTED_API_KEY`，否则不带鉴权头 |

前三个是外部来源，`self-hosted` 是自部署来源。

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

字段按下列顺序拼接，短的在前，长文本在后：

- **运行级**：运行类型（任务触发、Chat 消息或自动化）、provider、model、标题、触发评论前 1000 字、描述前 1500 字。
- **步级**：先是短字段：步序号、上一步主线程的工具名称与是否出错、退出码、报错特征（前 200 字）、最近 6 个主线程步内与本步报错特征相同的步数（含本步；无报错时为 0）；再是长文本：上一步工具调用的输入摘要（前 300 字）、工具结果 `result`、上一步助手文本（前 500 字）、运行目标（同上的标题与描述，前 500 字）。工具结果超长时截一次：保留开头约 1500 字节与末尾 1000 字节（报错通常在最后），截点取 UTF-8 边界，中间标出截掉的字节数；结果从不整段清空。各字段只按自己的上限截取，互不挤占；步级 state 不做整条 JSON 的总长截断（负责人的决定，OL-1083：各字段已各自限长，各字段全顶格加转义后总长约 8–10 KB，外部来源 65,536 tokens、自部署 2 MiB 都远在其上；运行级仍按 §4 截到 4KB）。
- **截掉字节数的口径**：state 里 `result` 的“N bytes elided”只计 daemon 这一次截取；mod 对超过 64 KiB 的字段已先截过一次（§6），原始输出更长时以 mod 报文里的计数为准。
- **为什么这样排**：运行级超长时截掉的总是末尾（daemon 截到 4KB 是这样，自部署来源按 token 上限截断也是这样，§10.0）。中文描述的前 1500 字就超过 4KB，排在它后面的字段会整段丢掉；D4 要靠触发评论、报错特征和重复次数判断是否升到 max、ultra，所以这些放在长文本前面。步级没有总长截断，但同样把 D4 依赖的字段排在长文本前面。

### 判据评测

用一组代表性的 state fixture 评测判据，分别用 Claude（low 到 max）和 Codex（minimal 到 ultra）两组候选各跑一遍。预期：

- 机械类（读文件之前、收尾、改错别字、升级依赖）选候选中的最低或次低挡，绝不选 max、ultra；
- 低级报错（编译错误、连接被拒绝）不高于 medium；
- 第一次出现的深层问题（刚读入复杂的并发代码、`DATA RACE`、核心断言失败、并发竞态、架构死锁）选 high 或 xhigh；
- 重复失败后的升级场景选 max；Codex 上可以是 max 或 ultra。

评测命令由 `MULTICA_RUN_JEV_LIVE=1` 门控。门禁评测（§10.5）要用这条命令，纠偏清洗（§10.4）要用导出的 fixture，所以还要满足三点：

- **来源可配**：按 daemon 的 `MULTICA_JEV_*` 配置选来源，不写死 `opencode-free`。设上 `MULTICA_JEV_SOURCES=self-hosted`，同一条命令就能评测自部署来源。
- **机器可读的结果**：除了打印，还输出一个 JSON 文件。每个 fixture 一项：id、范围（运行级或步级）、候选组、预期类别、`choice`、`probabilities` 和来源。
- **fixture 导出**：渲染后的 fixture 导出为 JSON 测试数据，放在 `server/internal/daemon/testdata/` 一带。每项包括 id、范围、候选组、state、questions 和预期类别，预期类别是上面四类之一。另有测试保证导出文件与代码里的 fixture 一致。

评测实现位于 `server/internal/daemon/thinking_evaluation_test.go`。从仓库的 `server/` 目录执行：

```sh
MULTICA_RUN_JEV_LIVE=1 MULTICA_JEV_EVAL_OUTPUT="${TMPDIR:-/tmp}/thinking-results.json" \
  go test ./internal/daemon -run '^TestThinkingEvaluationLive$' -count=1 -v
```

测试读取 daemon 的同一套 `MULTICA_JEV_*` 配置，默认超时仍为每来源 1500ms。自部署来源可加 `MULTICA_JEV_SOURCES=self-hosted` 及其连接配置。任何回退或不符合预期的选择都会使测试失败；结果文件仍写出全部用例，含 `confidence`、`latency_ms`、`fallback` 和 `passed`。未指定输出位置时在系统临时目录创建 `multica-thinking-evaluation-*.json`，日志打印完整路径。

导出文件为 `server/internal/daemon/testdata/thinking-fixtures.json`，`scope` 取 `run` / `step`，`candidate_group` 取 `claude` / `codex`，`expected_category` 取 `机械` / `低级报错` / `首次深层问题` / `重复失败`。`questions` 复用 Jev 客户端的有序编码，去掉格式化空白后与实际 HTTP 请求中的对象逐字节一致。更改判据或 fixture 后，用以下命令重新导出，再运行不带更新开关的测试检查一致性：

```sh
MULTICA_UPDATE_THINKING_FIXTURES=1 \
  go test ./internal/daemon -run '^TestThinkingFixtureExport$' -count=1
```

`StepThinkingFixtures()` 和 `BuildStepThinkingState()` 供步级实现复用。后者接收工具输入摘要与工具结果原文；结果超长时按 §4 保留开头与末尾并标出截掉的字节数。

## 5. 运行级决策

在 `resolveTaskModelSelection`（`server/internal/daemon/daemon.go`）定位模型之后：

1. 若 `thinking_level == "_adapt"`，从已验证的目录（`Catalog.Verified()`）取出该模型的挡位，求出候选。
2. 目录未验证、候选不足 2 个，或 `ThinkingRequiresExplicitModel` 列出的 provider（codex/omp/deveco）没有指定 model 时，不调用 Jev，也不注入挡位，记一条 info 日志，按回退处理（原因为 `no_candidates`）。
3. 否则按 §4 构造判据和 state，调用 Jev，把结果写入 `ThinkingLevel`；回退时置空。
4. fresh-session 重试和 codex 的第二次尝试复用同一个决策，不再调用 Jev。

issue 运行沿用领取响应的 `thread_name` 作为标题；服务端仅在领取的挡位仍为 `_adapt` 时附带 `issue_description`，复用已加载的 issue 行。Chat 和自动化分别使用领取载荷中的消息、自动化标题和描述。daemon 只选取 §4 的业务字段，限制各字段字数，再按该节的顺序编码 JSON；材料保持原文（§4）。超过 4096 字节时，从最后一个文本字段向前缩短，保留有效 JSON 和所有字段名；运行级先缩短描述。该总长截断只用于运行级（步级已无总长截断，OL-1083）。

运行级和后续步级调用的共同挂钩是 `decideThinking(ctx, client, trace, request)`。`ThinkingDecisionTrace` 带 `TaskID`、`Scope`、`Step`（运行级为 0，表示无步序号）、`Provider`、`Model`，与外发请求分开。`ThinkingDecisionRecord` 保存这份追踪信息、按 §4 构造的请求、结果及回退原因，通过执行 context 中的 `thinkingRun` 保留到终态处理；本阶段不采集样本。

选中的挡位走各运行时现有的注入路径：claude 的 `--effort`、codex 的 `model_reasoning_effort`、opencode 的 `--variant` 或 `#level`、pi/omp 的 `--thinking`、kimi/reasonix/hermes 的 `set_config_option`。跟随 CLI 配置和固定挡位的路径保持原样：不构造判据，不调用 Jev。

## 6. Claude 的步级换挡

传输通道、最低 CLI 版本和回退的做法依据 OL-1000 的实测（§0.2、§0.9）。

- **启用条件**：同时满足
  - claude 运行时，挡位设定为自适应；
  - CLI 版本不低于 2.1.304，即端到端实测过的版本；2.1.269–2.1.303 没有实测；
  - 本次运行有候选挡位，即运行级没有因 `no_candidates` 回退；
  - 本次运行的 `system/init` 报告 `per_turn_effort_active === true`，缺少这个字段视为 false。

  目前 Sonnet 5、Opus 5 的 init 为 false，这两个模型只做运行级决策：在它们上面逐步换挡，每次首次切到一个挡位都要重写整个前缀（§0.2）。
- **启用标记**：
  - 满足条件时，daemon 读到 init 后写入 `<task config>/effort/enabled`；
  - 读到 `system/per_turn_effort_changed` 为 false 时删除它，本次运行不再写回；
  - 决策端点也检查这个状态，已撤销时回答"未启用"，防止标记删除与下一步之间的竞态。
- **步序号**：一步是主线程的一次模型请求，`step` 从 1 开始，等于 `turn.step` 输入的 `index + 1`。
- **每一步**：只处理主线程（`e.agentId` 为空）的步。
  - mod 记住上一次生效的挡位 `last`，初值为启动挡位 `e.effort`。
  - 第 1 步不请求决策，用运行级决策的挡位。
  - 从第 2 步起，标记存在时向 daemon 要决策。总时限约 2s，由 mod 自己设置，因为 `$.http.fetch` 默认是 30s。
  - 拿到决策：`yield* next({ ...e, effort: level })`，并把 `last` 更新为 `level`。
  - 没拿到新决策（端点返回回退、请求超时或出错、未启用、标记不存在）：`yield* next({ ...e, effort: last })`，显式沿用上一步的挡位。不能直接 `next(e)`，那样会退回启动挡位（§0.9）。
    - 从未换过挡时，`last` 就是启动挡位，效果与 `next(e)` 相同；运行级回退、还没拿到过决策时 `last` 为空，这一步原样 `next(e)`（没有挡位可沿用）。
    - 撤销之后不再请求决策，一直传 `last`，锁定在最后生效的挡位，免得顶层挡位再变而重写缓存。
  - 运行级回退（非 `no_candidates`）仍安装 mod：`last` 从空开始，第一个拿到的决策设挡。
  - 子智能体的步原样 `next(e)`，不改写。
  - 端点按运行只接受递增的步序号：重复或倒退的请求直接回退，不调外部引擎。
- **运行目标**：步级 state 的 `goal` 是运行的标题与描述拼成的纯文本（§4），不是运行级 state 的 JSON。
- **mod**：名为 `labrastro-effort`，与 `labrastro-ysk` 一起通过 `CLAUDE_CODE_PLUGIN_DIRS` 加载，安装方式照 `prepareYouShouldKnow`（`server/internal/daemon/labrastro_ysk.go`）。
- **mod → daemon**：`POST http://127.0.0.1:{MULTICA_DAEMON_PORT}/tasks/{task_id}/thinking-decision`，带 `Authorization: Bearer $MULTICA_TOKEN`。实测往返约 1–3 ms，不受 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 影响，不需要改走 Unix socket（§0.9）。
  - daemon 的健康服务（`serveHealth`）校验 token 和活跃运行，做法照 `/repo/checkout`。
  - 请求体由 OL-1010 定义、OL-1083 简化，内容是构造 state 所需的上一步原料：`{step, assistant_text, tools: [{name, is_error, input_summary, result_text}], error_text}`。mod 每步调用 `next()` 前记下 `$.session.messages()` 的条目数，下一步只取其后新增的条目（即上一步的输出）：宿主把一次请求的输出拆成 text 与逐个 tool_use 的多条条目、并把结果条目穿插其间（§0.9），mod 在这个窗口里从末尾回收到原始用户消息为止，合并 `text` 与 `toolUses`（工具结果已由宿主按 `tool_use_id` 并入，`text`、`isError` 字段）。所有工具一视同仁：Read / NotebookRead 的正文和其他工具的结果一样上传。为了补记结果信号（§10.3），还必须带：
    - 步序号，从 1 开始；
    - 上一步主线程的工具列表 `[{name, is_error}]`；
    - 上一步的报错文本。Bash 失败结果首行固定是 `Exit code N`：daemon 把它解析进 `exit_code`，报错特征取其后的真正报错行；Go 编译/测试输出的 `# 包路径` 与 `FAIL\t包路径 [build failed]` 包头行同样跳过，取真正的报错行。state 描述的那个工具取上一步最后一个报错的工具（没有报错则取最后一个工具），`is_error` 与 `exit_code` 与报错特征一致。
  - 报错特征的归一化和同类报错的重复次数由 daemon 用 Go 计算（`NormalizedErrorFeature` / `ErrorFeatureTracker`，`server/internal/daemon/thinking_step_errors.go`），重复次数是最近 6 个主线程步内与本步报错特征相同的步数（含本步）。daemon 按运行保存这个窗口；无报错的步占窗口位置，但不清空历史，本步计数为 0。一次"修改 + 验证"占 2 步，6 步覆盖三轮尝试。mod 只上传原料。这个函数导出给 OL-1019 复用。
  - mod 侧只对超长字符串做首尾截取：每字段上限 64 KiB（UTF-8 字节），超限时保留开头约 63 KiB 与末尾约 1 KiB、中间标出截掉的字节数（截点落在码点边界上，不拆代理对），绝不整段清空；整个请求上限 768 KiB（序列化后的字节数，给 daemon 的 1 MiB 解码上限留余量），超限时从最早的工具起把大文本字段再截短到两端各约 1 KiB，`name` 与 `is_error` 永不丢，最后一个报错工具（无报错则最后一个工具）尽量保留。
  - 材料全程保持原文（§4）：mod 与 daemon 都不做脱敏，智能体调用大模型时本来就直接发送这些内容。
  - daemon 按 §4 构造 state（`BuildStepThinkingState`），复用 `decideThinking` 调用 Jev（trace 的 `scope` 为 `step`，`step` 为步序号），并计入健康快照。
  - 返回 `{level, confidence, probabilities, latency_ms, source}`、`{fallback}`，或 `{enabled: false}`（"未启用"）。"未启用"不经过 Jev 客户端，不计入健康快照。鉴权沿用 `/repo/checkout` 的任务级 Bearer token；路径里的 `task_id` 与 token 绑定的任务不一致时拒绝。
- **生效记录**：mod 每次请求过决策，无论拿到决策还是回退，都在调用 `next()` 之前用 `$.ui.log` 写一行生效记录，内容是步序号，以及决策各项或回退原因。mod 自己超时或请求出错时，回退原因为 `timeout` 或 `error`。第 1 步、子智能体的步、撤销之后的步都不写。
  - daemon 照 `consumeYouShouldKnowLog`（`server/pkg/agent/labrastro_ysk.go`）的做法，按 ui_log 的 `plugin` 字段认出 `labrastro-effort` 的行，从流里摘走，不成为运行消息。
  - 生效记录早于这一步的第一条 assistant 事件，但中间可能夹着其他 mod 的日志（§0.9）。daemon 把它用在之后第一个新的主线程消息 ID 上，即这一步，按 §7 打标。
  - 打标以生效记录为准，不以端点的返回为准：端点返回的决策，mod 可能已经超时没有收到。

## 7. 运行消息的元数据

- **字段**：`task_message.metadata JSONB NULL`，fork 迁移，不加默认值和索引。
  - daemon 在消息上附带它；元数据不同的相邻消息不得合并成一条。
  - 服务端只接受 JSON 对象，单条上限 4KB；不合格时只丢弃这个字段并告警，不拒绝整批。
  - `GET /api/tasks/{taskId}/messages` 和 WS `task:message` 原样带回。core 的 schema 宽松解析：未知字段保留，坏值降为 undefined。
- **结构**：

  ```ts
  type ThinkingMetadata = {
    level: string; // always present; the level in effect, "" when none was injected
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

  `level` 必须出现，表示这一步实际生效的挡位。回退时用 `fallback` 写明原因，`level` 这样取：
  - 运行级回退：没有注入挡位，`level` 为空字符串。
  - 步级回退：这一步沿用上一步的挡位（§6），`level` 记上一步的 `level`。运行级回退、此后也还没拿到过决策时，上一步的 `level` 就是空字符串。
- **打标**：
  - 打在每条 thinking 消息上，以及每一步的第一条消息上。
  - Claude 的一步是主线程（`parent_tool_use_id` 为空）的一次模型请求。同一次请求的 thinking、text、tool_use 是几条 assistant 事件，共用一个消息 ID，所以按去重后的消息 ID 分步。不按 assistant 事件计步，也不按有没有思考块判断（§0.6）。
  - 其他运行时把整次运行当作一步。
  - 步级换挡启用时：
    - 第 1 步用运行级的标；
    - 第 2 步起按 mod 的生效记录打标，带 `step`；
    - 撤销之后的步没有新决策，不打步级标，当前挡位仍是最后一个标的挡位，与锁定的挡位一致。
  - 自适应：`mode: "adapt"`，带上决策的各项字段；回退时写明 `fallback`，`level` 按上面的规则取。运行级回退没有有效决策，不填 `confidence`、`probabilities` 或 `source`；实际耗时大于 0ms 时保留 `latency_ms`。
  - 固定挡位：`{mode: "fixed", level}`。
  - 跟随 CLI 配置：不打标。
- **按步汇总**：一步可能有多条带标的消息，即这一步的第一条消息和思考消息。比较升降、统计次数都按 `step` 分组；不带 `step` 的标属于运行级决策，算作一步。
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
- **副标题**：显示该运行时 `thinking_adapt` 快照的状态（例如"可用 · OpenCode Zen 免费通道 · 290ms"），并用一句话说明外发去向：选中后，会将运行摘要（包括工具输出原文）发送给本机配置的外部决策服务，例如 OpenCode Zen、阿里云百炼。说明不写死默认来源、不随本机配置变化；当前实际在用的来源由副标题里的快照状态显示。
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
  - 当前挡位取消息序列里最近一次的 `metadata.thinking`，不看消息类型（Claude 目前没有思考消息，§0.6）。直接基于原始消息计算，不改 `buildTimeline` 的合并逻辑。
  - 自适应：显示挡位，并与上一步比较，带 ↑ 或 ↓；无法排序时不带。"上一步"按 §7 的按步汇总分组，不是上一条带标的消息。
  - 回退：
    - `level` 为空时显示"默认"；
    - `level` 不为空时，是步级回退沿用的挡位，显示该挡位，不带箭头。
  - 固定挡位：只显示挡位，不带箭头。
  - 跟随 CLI 配置、没有元数据的旧消息：不显示。
- **时段**：运行期间一直显示，执行工具时也显示，此时表示发起这次调用的那一步的挡位。运行结束后，Chat 状态条和卡片状态行随之消失，只在执行记录窗口顶部保留汇总，例如"自适应 · 8 次 · 最高 xhigh"。"8 次"是步数，按 §7 分组计算。
- **Tooltip**：
  - 自适应：决策详情，例如"Jev 动态决策：xhigh · 置信度 88% · 耗时 284ms · 来源 OpenCode Zen"，加上概率分布；
  - 回退：原因（超时、出错、返回值无效、熔断、本机关闭、拿不到候选挡位）；步级回退还要写明沿用了上一步的挡位；
  - 固定挡位："固定挡位"；
  - 汇总：每一步的挡位序列和回退次数，回退次数是带 `fallback` 的步数。
- **交互**：微标所在的行仍可点击，不得破坏行的点击、展开和键盘可达性。
- **禁止**：不做逐行微标。

### 文案与范围

- 新文案同步 `en`、`zh-Hans`、`fr`、`ja`、`ko`，按 [`branding.md`](branding.md) 放进 fork 命名空间，并通过 `packages/views/locales/parity.test.ts`。英文名用 Adapt。
- 来源名称：选择器副标题、额度区和 Tooltip 共用同一套映射（`thinkingAdaptSourceLabel`，`packages/views/common/thinking-adapt.ts`），五种语言同步；不认识的来源名称原样显示，不报错。

  | 来源 | 中文 | 英文 |
  |---|---|---|
  | `opencode` | OpenCode Zen | OpenCode Zen |
  | `opencode-free` | OpenCode Zen 免费通道 | OpenCode Zen (free) |
  | `dashscope` | 阿里云百炼 | Alibaba Cloud Model Studio |
  | `self-hosted` | 自部署 | Self-hosted |
- 移动端不在范围内（需求未要求），新字段对移动端透明。

## 10. 自部署来源与决策样本

OL-1013 把平台自己微调的 Laya 模型接成一个来源 `self-hosted`，并采集决策样本，按结果信号纠偏后用于训练。本节整理自 OL-1013 描述中的"架构设计与接口契约"，小节编号与那里一致：那里的 §N 即本节的 10.N。需求定下的三条边界、负责人对 E1–E3 的决定和方案 A 见[决策记录](#决策记录)，为什么以独立服务接入见 [ADR 0002](../adr/0002-self-hosted-decision-model-as-separate-service.md)。

### 10.0 背景事实

2026-10-21 核对。代码以当天的 main（`aacf191b0`）为准，外部项目以当天的默认分支和 PyPI 为准；Laya 的行为另外对照了 0.4.12 的源码。

1. **Laya**（[`NandhaKishorM/laya`](https://github.com/NandhaKishorM/laya) 0.4.12）
   - **许可**：仓库和权重都是 Apache-2.0，可以商用。
   - **`laya-multilingual`**：
     - 由 mmBERT-base（307M）加决策头组成，共 322M，其中词嵌入约 1.97 亿；
     - 配置里的长度是 `max_len` 1024、`head_max_len` 256 token；checkpoint 缺这两项时，代码才回退到 512、192。8192 要手动打开，约 4k token 以上准确率不稳定；
     - 实测过的语言是 51 种。
   - **长度与截断**：
     - 输入依次是 `[CLS] 说明 [SEP] [MASK] 选项… [SEP] state [SEP]`。候选挡位和 max、ultra 的限制都在前面的问题头里，由 `head_max_len` 保住；超长时截掉的是 state 的末尾，`laya-serve` 在响应的 `usage.truncated` 里报告。
     - OL-1018 用模型的 tokenizer 统计：4KB 的 state 约 1000 token，问题头 Claude 138、Codex 183 token，整条最长 1183 token。默认的 1024 截断了全部 4KB 样本，1536 能覆盖这批样本；但报错栈、路径、哈希这类工具输出的 token 更密，不能保证任意 4KB 都不截断。
     - 两个长度由 `laya-train --max-len --head-max-len` 写进产物的 `rl_agent_config.json`，`laya-serve` 加载 checkpoint 时沿用。请求体可以带 `max_len`、`head_max_len` 覆盖，上限是 `LAYA_MAX_TOKEN_BUDGET`（默认 8192）。
   - **`laya-train`**：
     - 只在一个设备上训练（CUDA、MPS 或 CPU）；
     - 默认底座是英文版 `convaiinnovations/laya`，必须显式指定 `--base convaiinnovations/laya-multilingual`；
     - 在 CUDA 上默认用 FP16 autocast、GradScaler 和梯度检查点，权重、梯度和 AdamW 状态都是 FP32；
     - `--dry-run` 只检查数据、不训练，冷缓存时仍会下载权重。
   - **训练数据**：每行 `{state, questions, gold | expected}`。`gold.<问题>.probabilities` 以选项值为键，会自动归一化；同时有 `gold` 和 `expected` 时以 `gold` 为准。
   - **温度校准**：
     - 训练前切出 min(400, 10%) 条，每种问题类型拟合一个温度；
     - `train_report.json` 有 ECE、Brier 的前后对比，没有分桶准确率。
   - **样本量与效果**：
     - 默认参数（4 个 epoch、有效 batch 64）取自它在 6,000 条决策上训练的 notebook。Laya 实测过约 1,100 条时决策头塌缩（[Laya #963](https://github.com/NandhaKishorM/laya/issues/963)），样本少时要加 epoch。
     - 0.766 对 0.727 是在它自己的合成数据集上测的；0.727 是第三方公布的 Jev 成绩，Laya 没有实测。
   - **训练时长**：单张 T4 完整微调英文版，11,514 条、4 个 epoch、`max_len` 512，约 48–54 分钟（[Laya #887](https://github.com/NandhaKishorM/laya/issues/887)）。
   - **官方服务 `laya-serve`**：
     - 基于 PyTorch，端口由 `LAYA_PORT` 指定（默认 8000）；兼容 `/v1/systemone`，有 `/health` 和 Bearer 鉴权（`LAYA_API_KEY`）。
     - OL-1018 用 §3 的请求体实测：响应能按 §3 解析，`choice` 在候选内。缺 state 或 JSON 不合法返回 400，问题不合法返回 422，请求体超过 2MiB 返回 413，鉴权错误返回 401。
     - 按语言自动路由到内置底座。微调模型必须用 `LAYA_EXTRA_MODELS` 注册：它只接受 `{名称: 来源}`，来源是 Hub repo id、本地 checkpoint 目录或 `[repo, subfolder]`，不能设长度。
     - 请求里的 `model` 决定用哪个 checkpoint：写注册名就用注册的模型；写 `laya-multilingual` 会指定到原始底座；不认识的普通名字（如 `jev-1.13-free`）当作"由路由自选"，按语言路由到内置底座；路径或未发布的 repo id 返回 422。
     - 有两个默认值不适合直接部署：`LAYA_HOST` 默认 `0.0.0.0`；`LAYA_MODELS` 为空时预载全部内置底座。
     - 4 核 CPU 上单题约 190ms（进程内、fp32，输入长度未注明）。
   - **在 GPU 上**（`laya/agent.py`）：
     - 计算能力低于 8 的卡固定用 FP16 autocast，`LAYA_CUDA_AMP` 只在计算能力 ≥ 8 时起作用；所以在 sm_75 上推理不会走 BF16，也不需要 `.half()`。
     - autocast 只改变计算精度，权重仍以 FP32 放在 GPU 上，约 1.2 GiB。
     - 加载时放不上 GPU（不可用或显存不足），这个模型就一直在 CPU 上跑，只打一条警告；推理时显存不足，这一个请求改在 CPU 上重试。
     - `/health` 报告实际设备（`device`）和推理时的 CPU 回退次数（`cpu_fallbacks`），不报告 dtype；设了 `LAYA_API_KEY` 时，不带 key 只能看到存活状态。
   - **响应**：
     - 没有顶层 `latency_ms`，§3 已按可缺失处理；
     - `confidence` 是归一化熵，与 Jev 的算法不同，数值不能和外部来源直接比较。
2. **EdgeJev**（[`yzfly/edgejev`](https://github.com/yzfly/edgejev)）：**已淘汰**（方案 A）。OL-1018 走通了"微调 → 导出 ONNX → 服务"，但它不适合作为平台的服务栈：
   - **构建链脆弱**：要钉死 `onnxscript` 0.2.7、`protobuf` 5.29.5 才能导出，换成 ONNXScript 0.5.7 配 torch 2.6、或 protobuf 7.36.2 都会失败；torch ≥ 2.6 缺 `onnxscript` 的修复 PR 一直没合入。
   - **服务缺少防护**：`edgejev serve` 忽略请求里的 `model`，任何名字都照常作答；不限制请求体大小（3MiB 也返回 200）和线程数；源码只捕获 `KeyboardInterrupt`，不处理 SIGTERM；不能热换模型。
   - **成熟度低**：只有 1 位作者，12 个提交都在 2026-09-20 到 21 日，之后没有更新；没有 release、测试和 CI；PyPI 最新为 0.3.2（Alpha），main 上的 0.4.0 没有发布。
   - 精度不是淘汰的原因：原版导出的 INT8 相对 FP32，概率的最大偏差在公开底座上是 0.0141、在微调产物上是 0.0014，12 个输入的 `choice` 全部一致；FP32 与 PyTorch 一致，训练时拟合的温度也带了过去。OL-1018 里 0.7283 的偏差和 6/12 的 `choice` 改变，来自另外做的 ORT `quant_pre_process` 诊断产物，那个产物已经排除。
3. **CPU 上的延迟**（OL-1018）
   - 原始需求的"4 核 CPU ≤ 50ms"来自 EdgeJev README 的 15.6ms、32.1ms，那是约 36 个 token 的短输入、进程内调用测的。
   - OL-1018 在 agent-main-01（Xeon Platinum 8259CL）上限定 4 核，经 HTTP 测原版 EdgeJev INT8（`max_len` 1536），每组串行、4 并发各 100 次。串行 P95：1KB 约 0.5–0.7 秒，2KB 约 0.9–1.3 秒，4KB 约 2.2–2.3 秒；4 并发时 P95 为 2.2–13 秒。`laya-serve` 在 CPU 上只做了诊断，4KB 单请求的中位数约 1.6 秒。
   - 那台主机不是独占的，内存多次触顶，这些数只能看量级，不能当作 SLA。量级已经说明：CPU 上做不到 50ms，4KB 的 state 还会超过单个来源 1.5 秒的超时。这是方案 A 改用 GPU 的原因。
4. **149 的 GPU**
   - **硬件**：RTX 2080 SUPER，8192 MiB，扣除驱动保留后可用 7783 MiB；Turing 架构，计算能力 7.5（sm_75）；驱动 580.65.06（OL-158）。
   - **精度**：这张卡上 `torch.cuda.is_bf16_supported()` 返回 True，但 BF16 是模拟的，要用 FP16。torch 2.10.0+cu128 支持这张卡，FP16 运算正常，这套环境在 149 的 `/data/kb-poc/asr/` 下（OL-159）。
   - **kb-worker**：149 上用这张卡的是知识库的 kb-worker（OL-174）。
     - 队列空时不占显存（4 MiB）；批处理时 GPU 步骤串行，峰值是 ASR 的 4346 MiB，对齐 2154 MiB，OCR 3200 MiB。
     - 它按独占显卡设计：开跑前检查要求没有其他 GPU 进程、可用显存 ≥ 4.5 GiB、MemAvailable ≥ 24 GiB，不满足就整批推迟；步骤之间的释放检查要求 NVML 上没有任何计算进程。
     - 显存有三层限制：代码内 ASR、对齐 5.6 GiB，OCR 3 GiB；调度进程发现超过 6 GiB 就终止子进程；主机看门狗发现高于基线 6 GiB 就杀掉容器。
5. **使用条款**
   - OpenCode Zen 文档、百炼 API 文档和 TypeSafe 网站条款，都没有明文允许或禁止用输出训练模型。
   - TypeSafe 文档里有用 Jev 的概率训练下游模型的示例。
6. **代码现状**
   - Jev 客户端（OL-1002）已经合入（PR #154），在 `server/internal/daemon/jev/`。
   - **Claude 的解析**：
     - 不读 `tool_result.is_error`（`claudeContentBlock`，`server/pkg/agent/claude.go`）；
     - `agent.Message` 没有错误标记、退出码和步序号；
     - 子智能体的工具事件混在主流里。

     OL-1000 证实：mod 侧 `session.messages()` 的 `toolResults[]` 带 `isError`。
   - **其他运行时**基本不报告工具是否出错。只有 ACP 和 Codex 的 MCP 调用在工具结果上带 `Message.Status`，而且 daemon 上报的 `TaskMessageData` 没有这个字段。
   - **运行失败原因**（`server/pkg/taskfailure`）几乎都属于平台、环境和供应商一类：离线、超时、配额、鉴权、限流、请求被拒等，不能说明挡位不够。
   - **记录器**：daemon 没有现成的 JSONL 记录器。目录和文件的做法可以参考 `server/internal/daemon/terminal_report_queue.go`：目录 0700、文件 0600、检查符号链接。
   - **Python 工具**：先例是 `tools/effort-tuner/`——只用标准库，测试和 fixture 放在同一目录，不在 CI 里。
   - **daemon 分布**：agent-ops-host-149、agent-main-01、agent-kimi-02 在 149 宿主机上（宿主机和 agent 容器）；agent-gcp-01、shendiqiu02 不在。

### 10.1 术语

新增的术语见 [`GLOSSARY.md`](../../GLOSSARY.md)：来源、外部来源、自部署来源，以及"样本与评测"一节；"决策引擎"改为由一个或多个按顺序尝试的来源组成的决策服务。代码中的名字并入 §1 的对照表。

OL-1013 描述前半部分的原始需求里，"通道""源"统一叫"来源"，"成败信号"叫"结果信号"，"低挡失败""高挡冗余"叫"挡位不足""挡位过高"，"Fail-Open""兜底"叫"回退"；"黄金评测集""Golden Fixtures"指判据评测的 fixture，用它们评测自部署来源叫"门禁评测"。

### 10.2 自部署来源

| 变量 | 含义 | 默认值 |
|---|---|---|
| `MULTICA_JEV_SELF_HOSTED_URL` | 完整端点，如 `http://127.0.0.1:8000/v1/systemone`；只接受 http/https | 无；缺失或不合法时跳过这个来源，只告警一次 |
| `MULTICA_JEV_SELF_HOSTED_MODEL` | 请求体里的 `model` | `self-hosted` |
| `MULTICA_JEV_SELF_HOSTED_API_KEY` | 设置后发 `Authorization: Bearer <key>`，否则不带鉴权头 | 无 |

- 在 `MULTICA_JEV_SOURCES` 里写 `self-hosted` 即启用，位置决定尝试顺序。
- 请求体、超时、切换、熔断、健康快照和消息元数据都与其他来源一致，不为它加特例；`source` 为 `self-hosted`。
- key 按 §3 的规则处理：不写日志、不序列化、不上报。URL 不进健康快照，也不进任何上报的结构，但可以出现在本地日志和错误信息里：`trySource` 用 `%w` 包住 `http.Client` 返回的 `*url.Error`，它自带请求地址（Go 已去掉其中的密码）；自部署服务连不上时，日志里有地址便于排查。这与现有来源的行为一致，不另做剥离。
- 跳过来源时，告警只写来源名称和原因，不带变量的值。
- `model` 的默认值不用 `laya-multilingual`：
  - 在 `laya-serve` 上，这个名字会指定到原始底座，正是"不拿底座裸跑"要避免的情况；
  - `laya-serve` 通过 `LAYA_EXTRA_MODELS` 把注册名映射到微调 checkpoint 目录，`MULTICA_JEV_SELF_HOSTED_MODEL` 要写注册名（注册名 `self-hosted` 与默认值一致时 daemon 不用另配）。`LAYA_EXTRA_MODELS` 只做名字到目录的映射，`max_len`、`head_max_len` 等长度写在 checkpoint 自己的配置里，daemon 不传。
- 运维规则：
  - 自部署来源通过门禁评测（§10.5）后，才能排在外部来源前面；
  - 判据文案改动后必须重跑门禁评测，不通过就把它从首位撤下。
- 界面上的来源名称显示为"自部署"（英文 Self-hosted），见 §9。

### 10.3 决策样本

**配置**

| 变量 | 含义 | 默认值 |
|---|---|---|
| `MULTICA_JEV_COLLECT_DIR` | 样本目录。为空时完全关闭：不建目录、不打开文件、不写盘 | 空 |
| `MULTICA_JEV_COLLECT_MAX_MB` | 本 daemon 在该目录下样本文件的总大小上限。超过后停止写入并告警一次，不删除旧文件 | `1024` |

**文件**

- 文件名为 `decisions-<daemon_id>-<UTC 日期 YYYYMMDD>.jsonl`（默认 profile），命名 profile 下为 `decisions-<daemon_id>-<profile>-<hash>-<UTC 日期 YYYYMMDD>.jsonl`（profile 名做字符清洗、截到 64 字符并附原名 sha256 前 8 个十六进制字符，防止清洗后同名）：按 UTC 日期换文件。daemon ID 是整机共用的，而 daemon 单实例锁按 profile 加，所以同机多 profile daemon 靠文件名里的 profile 段各写各的文件，互不交错；大小上限也按各 profile 的文件分别计算。
- 目录 0700、文件 0600，并检查目录不是符号链接。
- 写入是异步、尽力而为的：
  - 决策和运行路径只把记录放进有界队列，由单独的 goroutine 写盘；
  - 队列满、写入出错或超过上限时，丢弃记录并限频告警；
  - 不得阻塞、拖慢或中断运行。
- 每行一条 JSON，带 `v: 1`。
- 只记成功的决策，回退不记。任何来源的决策都记，并带上 `source`。

**决策记录**（`type: "decision"`）

| 字段 | 含义 |
|---|---|
| `id`（UUID）、`ts`（RFC3339，UTC）、`daemon_id` | — |
| `task_id`、`scope`（`run` 或 `step`）、`step`（运行级为 null，步级从 1 开始）、`provider`、`model` | 追踪信息，由调用方随请求交给采集器，不进请求体 |
| `state`、`questions` | 与发给来源的内容逐字节相同。state 是未脱敏的原文（§4），可能包含工具输出里的密钥：样本只留在本机、权限 0600（见下），不得提交到仓库或上传到公开位置 |
| `source`、`choice`、`confidence`、`probabilities`、`latency_ms` | 取自 `Decision`（§3） |

**结果记录**（`type: "outcome"`）

用 `decision_id` 关联决策记录。结果记录里只有工具名、枚举、布尔值和报错特征的哈希，没有工具输入、输出或报错原文。

- **运行级**（`scope: "run"`）：在最终结果确定时写一条，即 fresh-session 重试之后的结果。重试和 codex 的第二次尝试复用同一个决策（§5），所以每次运行只有一条决策和一条结果。服务器已取消、丢弃本次结果的运行不写结果记录：没有可配对的上报结果，这类运行只有一条决策记录。`status` 取值：`completed`、`blocked`、`cancelled` 取自最终 `TaskResult`；`failed` 表示运行没有产出 `TaskResult` 就失败（如 agent 启动失败、本地工作树 Finalize 失败）。写入发生在终止上报之前。

  | 字段 | 含义 |
  |---|---|
  | `status` | 运行的最终状态，即 daemon 上报的结果 |
  | `failure_reason` | 分类后的失败原因（`server/pkg/taskfailure`）；成功时为空 |
  | `tool_calls` | 本次运行的工具调用次数 |
  | `outcome_ok` | `status` 为 completed |

- **步级**（`scope: "step"`，只有 Claude）：每个写了决策记录的步写一条。字段都能确定时就写，通常是第 N+2 步的请求到达时；运行结束时（包括取消、超时，以及收到 `per_turn_effort_changed=false` 之后不再有请求），把还没写的都写出。

  | 字段 | 含义 |
  |---|---|
  | `tools` | 这一步主线程调用的工具名 |
  | `action_kind` | 没有工具调用为 `final_text`；只用了只读工具为 `read_only`；其余一律为 `edit_or_exec`，包括 Bash、Task 和 MCP 工具。只读工具常量清单为 Read、Grep、Glob、LS、WebFetch、WebSearch、NotebookRead，按名称精确匹配 |
  | `outcome_ok` | 这一步所有工具结果的 `is_error` 都为 false |
  | `error_sig` | 对 `NormalizedErrorFeature` 的结果做 SHA-256，取前 8 字节的十六进制字符串；没有报错、或报错文本里没有可归一化的特征时为空字符串 |
  | `prev_action_kind`、`prev_outcome_ok` | 上一步的同名值；没有上一步时为 null |
  | `next_outcome_ok` | 下一步的 `outcome_ok`；没有下一步时为 null |
  | `repeated_error_next` | 下一步报错，且特征与截至这一步最近一次报错的特征相同，即这一步没能消除这个报错；没有下一步时为 null（OL-1083 起报错文本不再有整段省略，特征要么可算、要么为空字符串，两侧都有确定值） |

  未收到原料而无法确定的字段显式写 null，不省略字段。已知没有工具调用时 `tools` 为 `[]`，未知时为 null。

**步级信号从哪来**

- 第 N+1 步的决策请求里，带着第 N 步的主线程工具列表（含 `is_error`）和报错文本（§6）。不另外解析 stream，避免同一件事有两套判断。
- daemon 按运行保存步级信号与报错特征的短哈希，特征归一化复用 `NormalizedErrorFeature`（§6）。`repeated_error_next` 独立保存截至当前步最近一次报错的特征，不使用 `ErrorFeatureTracker` 的连续计数：成功的编辑步骤不清空最近报错；报错文本不可归一化时特征为空字符串（OL-1083 起不再有省略的报错）。
- 回退的步不写决策记录，但它的请求带来的原料，仍用来补全前一步的结果。
- 最后一个有决策的步：如果已收到它的生效记录，之后主线程再没有工具调用，就记为 `final_text`、`outcome_ok = true`；子智能体工具调用不影响此判断。没有生效记录或工具结果未知时，确定不了的字段为 null。步级状态在 `runTask` 退出移除时统一收尾，因此取消路径也保留步级结果，不依赖运行级结果是否上报。

**样本的去向**：样本只留在 149 上，训练也在 149 本机进行（E1、方案 A），不再外传。不得提交到仓库，也不得上传到公开位置。

### 10.4 纠偏清洗

脚本放在 `tools/jev-distill/`，照 `tools/effort-tuner/` 的做法：只用 Python 3 标准库，测试和 fixture 放在同一目录。输入是采集到的样本、种子样本（`tools/jev-distill/seeds/*.jsonl`）和判据评测 fixture 的 JSON 导出（§4）。

- **目标分布从哪来**：
  - 以决策里的 `probabilities` 为教师分布，默认只用外部来源的决策；
  - `self-hosted` 的样本不作为训练目标，可以留作评估；
  - 没有结果记录的样本，照教师分布使用。
- **挡位顺序**：`none < minimal < low < medium < high < xhigh < max < ultra`。候选里有无法排序的值时，这条样本不纠偏。
- **只对步级样本纠偏。** 运行级样本照教师分布使用，因为运行失败几乎都是与挡位无关的原因（§10.0）。脚本保留一个默认关闭的开关。
- **挡位不足：上调一档。**
  - 条件：教师选的挡位不高于 medium，且满足其一：
    - `repeated_error_next == true`；
    - `tools` 里有改文件的工具（Edit、Write、MultiEdit、NotebookEdit），且 `next_outcome_ok == false`。
  - 做法：每个挡位的概率移到候选里高一档的挡位；高一档是 max 或 ultra 时留在原挡位。按 D4，这两档只留给"同一问题已经失败"之后的那一步，由教师和种子样本来教。
  - 这一步自己报错，不算挡位不足：跑测试发现失败，正是这一步该做的事。所以只看改完之后的下一步。
- **挡位过高：压回 medium。**
  - 条件：教师选的是 xhigh、max 或 ultra，`outcome_ok == true`，`prev_outcome_ok` 不为 false，且满足其一：
    - `action_kind == read_only`；
    - `action_kind == final_text`，且上一步是成功的 `edit_or_exec`，即收尾。
  - 做法：高于 medium 的概率全部移到 medium。
  - 只有文本、前面又没有成功的修改的步，可能是纯推理的回答，不压。
- **其余样本**：照教师分布使用。
- **去重**：键为 `sha256(state + questions 的规范 JSON)`，重复样本的目标分布取平均。
- **与评测隔离**：state 与判据评测 fixture 相同的样本一律剔除；种子样本与 fixture 重合时，脚本报错退出。
- **输出**：
  - `laya-train` 的 JSONL，每行 `{state, questions, gold}`，种子样本可以改用 `expected`；每个分布和为 1。
  - 按来源、范围、纠偏类别、剔除原因的统计。

### 10.5 训练与门禁

流水线也放在 `tools/jev-distill/`，各步可以单独运行：`preflight` → `prepare` → `train` → `parity` → `serve` → `gate` → `bench`。训练和服务都用原生 Laya（方案 A），不导出 ONNX。

- **在哪里跑**：训练、门禁评测和压测都在 149 本机的 GPU 上做，属于宿主机操作，按 E3 由运维专员执行（OL-1023、OL-1024）。流水线自己的冒烟测试在 CPU 上跑，不碰 149（OL-1021）。
- **依赖**：训练和服务各一份锁定版本的 requirements，以 OL-1018 记下的可用组合为基础（laya 0.4.12）；写明 149 上已有的 torch 2.10.0+cu128 环境（§10.0）能否复用。
- **预检（`preflight`）**：在 GPU 上训练或压测之前，沿用 kb-worker 开跑前检查的标准（§10.0）：kb-worker 没有 GPU 任务、可用显存够用、MemAvailable ≥ 24 GiB。只做只读检查；不满足就退出并写明原因，不强行开始。
- **训练窗口**：选 GPU 空闲的时段，避开 kb-worker 的批处理和 149 上的定时任务（参考 OL-158）。一轮全量微调估计约 1 小时，以 OL-1023 的实测为准。
- **底座**：`convaiinnovations/laya-multilingual`。
- **训练（`train`）**：
  - 使用 `--loss rlcd`，并显式传 `--max-len 1536 --head-max-len 256`；训练后核对产物 `rl_agent_config.json` 里的这两个值，不符就判失败；
  - 按 `task_id` 切出不参与训练的评测集，传给 `--eval`；
  - 固定随机种子；
  - 精度沿用 `laya-train` 在 CUDA 上的默认（§10.0），不启用 BF16；用小的 micro-batch 加梯度累积适配显存，两者都可以配置。
- **显存**：
  - 目标峰值 ≤ 5.5 GiB，这样训练时不用停 `laya-serve`。全量微调时，FP32 的权重、梯度和 AdamW 状态合计约 4.8 GiB（5.2GB），留给 CUDA 上下文和激活的只有约 0.7 GiB，可能放不下。
  - 实测超限时，在训练窗口内停掉 `laya-serve`（daemon 会回退到外部来源），把上限放宽到 7 GiB 后重训；训练结束后重新启动 `laya-serve`。
  - 上限用 `torch.cuda.set_per_process_memory_fraction` 和 NVML 看门狗落实，看门狗发现超限就终止训练，日志写明峰值。`laya-train` 是命令行工具，要包在能设这两样的 Python 入口里。
  - 训练进程对 kb-worker 来说是未知的 GPU 进程，kb-worker 的检查会推迟它的批处理；OL-1032 保留这条保护。
- **对照（`parity`）**：同一个 checkpoint，GPU FP16 与 CPU FP32 在评测集上比较，报告 `choice` 一致率和概率的最大偏差；一致率低于 99% 判失败。
- **服务（`serve`）**：按 §10.6 的配置起 `laya-serve`，用 `/health` 确认实际设备是 `cuda`，记下常驻显存。
- **门禁评测（`gate`）**：
  - 用部署时同样的地址和配置，通过判据评测命令（§4，`MULTICA_JEV_SOURCES=self-hosted`）跑 Claude、Codex 两组候选；
  - 全部 fixture 满足 §4 的四类预期才算通过，同时输出与外部来源结果的对比表。
- **压测（`bench`）**：
  - 按评测集真实的 state 长度分布，经 HTTP 测串行和 4 并发的 P50、P95；
  - 门槛是方案 A 的 P95 < 100ms（149 的 GPU、FP16），运行级和步级都适用；
  - 统计响应里 `usage.truncated` 为真的比例，不为 0 就调大 `--max-len` 重训。
- **产物**：
  - 模型目录按版本命名，如 `jev-laya-<日期>-<短哈希>`，附 `train_report.json`、对照报告、门禁报告、压测结果和 sha256 清单；
  - 模型和样本只留在 149，不进仓库、不公开发布：模型在运行摘要上训练过，可能记住其中的片段。

### 10.6 部署与切换

- **服务**：`laya-serve` 以 FP16 常驻 149 的 GPU，用 systemd 或容器管理。
  - 崩溃后自动重启，限制线程数和内存；
  - 只监听回环地址，或 149 上 agent 容器能访问的内网地址；不是回环地址时必须设 `LAYA_API_KEY`；
  - 日志不记录请求内容。
- **`laya-serve` 的配置**：
  - `LAYA_DEVICE=cuda`。sm_75 上固定用 FP16 autocast，不用设 `LAYA_CUDA_AMP`（§10.0）。
  - `LAYA_HOST` 必须显式设置，它默认是 `0.0.0.0`。
  - `LAYA_EXTRA_MODELS='{"self-hosted":"<current 指向的 checkpoint 目录>"}'`，注册名与 daemon 的默认 `model` 一致（§10.2）；`LAYA_MODELS=self-hosted`，不预载内置底座。
  - 请求不得落到内置底座上：`model` 写错时，`laya-serve` 会按语言路由到未微调的底座（§10.0）。所以服务用专用的 HF 缓存目录（`HF_HOME`，里面不放底座），并设 `HF_HUB_OFFLINE=1`，只让注册的本地目录能加载。149 上训练时底座会下载进默认缓存，服务不能共用这份缓存。
  - `LAYA_MAX_TOKEN_BUDGET` 设为训练用的 `max_len`（1536），不让请求体把长度改大。
- **与 kb-worker 共用 GPU**：
  - 常驻显存以实测为准，估计 1.5–2 GiB（§10.0：权重约 1.2 GiB，再加 CUDA 上下文）；加上 kb-worker 的峰值 4346 MiB，仍在可用的 7783 MiB 以内。
  - kb-worker 的开跑前检查和释放检查都要求 GPU 上没有其他进程，`laya-serve` 常驻后它的任务会一直推迟。OL-1032 在 kb 仓库修改这两项检查并调整显存上限，OL-1024 以它为前置。
  - 训练窗口内是否停掉 `laya-serve`，按 §10.5 的显存规则。
- **模型版本**：按版本放目录，用 `current` 指向在用的版本，并写好回滚步骤。
- **时机与执行**：按 E3，OL-1023（首次训练）和 OL-1024（部署）都是 149 上的宿主机操作，统一部署时由负责人指派运维专员执行。开启采集（OL-1022）随本期统一部署一起做；部署自部署来源要等首次训练通过门禁之后。
- **部署验证**（OL-1024）：
  - `/health` 报告的实际设备是 `cuda`，`cpu_fallbacks` 为 0；`/health` 不报告 dtype，所以用同一环境、同一 checkpoint 在 GPU 上加载一次，读 `Agent.dtype`，应为 float16；记下常驻显存。
  - `model` 写错时必须返回 4xx，证明请求落不到底座上。
  - 用部署后的地址和 daemon 相同的配置重跑 `gate` 和 `bench`：门禁须通过；kb-worker 空闲时 P95 < 100ms；kb-worker 跑批时再测一次，确认仍明显低于单个来源 1.5 秒的超时。
- **daemon**：
  - 149 宿主机及其上 agent 容器里的 daemon 改为 `MULTICA_JEV_SOURCES=self-hosted,opencode-free`，`MULTICA_JEV_SELF_HOSTED_MODEL` 保持默认；
  - `MULTICA_JEV_COLLECT_DIR` 保持开启：自部署来源的样本不作为训练目标，但可以用于以后的评估；
  - 不在 149 上的 daemon（agent-gcp-01、shendiqiu02）不在 OL-1013 范围内，要接入需另开 issue。
- **运维手册**：写进 `tools/jev-distill/DEPLOY.md`，包括部署、升级和回滚步骤，训练窗口内暂停 `laya-serve` 的做法，与 kb-worker 共用 GPU 的规则，以及判据文案改动后重跑门禁评测的规则。

### 10.7 对前文各节的改动

OL-1013 对 OL-992 各节加的要求已并入正文：

- §1：新增术语在代码中的名字；
- §3：来源表增加 `self-hosted`；
- §4 的判据评测：来源可配、机器可读的结果、fixture 的 JSON 导出（OL-1005）；
- §4 的 state：字段改为短的在前、长文本在后，4KB 按 UTF-8 字节计，避免截断时丢掉 D4 依赖的字段（OL-1005、OL-1010）；
- §6：决策请求带上一步的结构化信息，报错特征改在 daemon 侧计算（OL-1010）；
- §9：来源名称"自部署"，不认识的名称原样显示（OL-1008、OL-1009）。

## 未决事项

（无。原「deveco 的挡位目录」一项已由 OL-1007 调查并接入，结论记入 §0.3。）

## 分工

### OL-992

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
| OL-1034 | 按 OL-1000 的实测结论更新本文 | §0、§1、§6、§7、§9 |

### OL-1013

| 子任务 | 内容 | 对应章节 |
|---|---|---|
| OL-1016 | Jev 客户端新增自部署来源 | §3、§10.2 |
| OL-1017 | 决策样本采集器与运行级结果信号 | §10.3 |
| OL-1018 | 可行性验证：服务栈与真实 state 长度下的延迟（不合入代码） | §10.0、§10.5、§10.6 |
| OL-1019 | Claude 步级决策样本与结果信号 | §10.3 |
| OL-1020 | 纠偏清洗脚本与种子样本 | §10.4 |
| OL-1021 | 训练、门禁评测与压测流水线（原生 Laya） | §10.5 |
| OL-1022 | 开启样本采集并跟踪样本量 | §10.3 |
| OL-1023 | 在 149 的 GPU 上首次训练与门禁评测 | §10.5 |
| OL-1026 | GCP 训练机一次性设置指南（已取消，方案 A） | — |
| OL-1032 | kb-worker 与常驻的 `laya-serve` 共用 GPU（kb 仓库） | §10.6 |
| OL-1024 | 在 149 部署自部署来源并切换 | §10.2、§10.6 |
| OL-1025 | 术语表、ADR 0002 与本文 §10 | — |
| OL-1033 | 方案 A：本文与 ADR 0002 的修订 | — |
