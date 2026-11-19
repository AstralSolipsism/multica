# effort-tuner

Codex 推理强度（effort/thinking level）自动调档脚本。从 codexradar.com 的新版四题静态数据源
`intelligence-trends.json` 取各模型各档位最近一个有效批次的分数，把在管 agent 统一到"并列
最高分里最便宜"的档位，并把换档、异常、整体降智提醒汇总成一条评论发到跟踪 issue。规则来自
[OL-252](https://multica.outlune.com/issues/OL-252)，实现对应 OL-259，数据源迁移对应 OL-1463。

只依赖 Python 3 标准库；`multica` CLI 需可用且已登录（脚本优先使用环境变量
`MULTICA_CLI_PATH`，未设置时回退到 PATH 里的 `multica`）。

## 用法（在仓库根目录执行）

```sh
python3 tools/effort-tuner/effort_tuner.py --tracking-issue OL-252            # 正式执行：改 agent + 发评论
python3 tools/effort-tuner/effort_tuner.py --tracking-issue OL-252 --dry-run  # 只抓数据、计算、打印，不改不发
```

- `--tracking-issue`：父 issue 的 key 或 ID。脚本从它的描述里读排除名单，评论也发到这里。
  评论文件 `effort-tuner-comment.md` 写在**当前工作目录**（发送后自动删除）。
- `--dry-run`：照常抓数据和计算并打印结果，但不改任何 agent、不发评论。开发和验证只用这个模式。
- 退出码：正常结束（无论这一轮有没有改动、有没有异常）为 0；脚本自身出错为非 0。
- 正式执行也会在 stdout 打印每个换档和最终评论正文，便于和 OL-252 上的实际评论比对。

## 数据源与运行时长

每轮只发**一次 GET** `https://codexradar.com/data/intelligence-trends.json`
（User-Agent `labrastro-effort-tuner/1`），失败重试一次。整轮抓取受硬预算约束：默认 600 秒
（环境变量 `EFFORT_TUNER_BUDGET_S` 可覆盖），单次请求超时被剩余预算封顶（最多 130 秒），
所以抓取阶段的总耗时不会明显超过预算。数据源是一次性静态 JSON，不存在旧接口那种逐档轮询和
Cloudflare 524 冷缓存问题。

正常处理时间远小于 1 秒；旧版在 Hermes terminal 工具上的前台 600 秒上限说明不再需要，但
autopilot 若仍经同样的工具执行，保留原有调用方式即可。

注意：脚本发的是跟踪 issue 的顶层评论（不带 `--parent`）。如果这一轮运行本身是由 OL-252 上的
评论触发的，服务端会返回 409 拒绝发评论；由 autopilot 或定时唤醒触发的运行不受影响。

## 规则摘要

1. **在管 agent**：`multica runtime list` 里 provider 为 `codex` 的 runtime 上的 agent，
   去掉已归档的。先应用排除名单（第 2 条），再查模型：model 为空的（daemon 会丢掉档位设置）、
   model 不在档位表里的，跳过并报异常。
2. **排除名单**：跟踪 issue 描述中的 ` ```effort-tuner-exclude ` 围栏代码块，每行一个
   agent ID，`#` 后为注释，空行忽略。名单里的 agent 完全静默跳过（包括模型检查，不再报异常）。
   代码块缺失或某行不是合法 UUID 时，这一轮不改任何配置，并把该异常写进评论（异常带行号；
   该行内容同样经 `safe()` 白名单化，从界面复制的提及链接不会原样回显）。
3. **档位表**（codex-cli `codex debug models`，2026-11 补充 GPT-6.2）：
   - gpt-6-astra / gpt-6.1-sol / gpt-6.1-terra / gpt-6.2-sol / gpt-6.2-astra /
     gpt-6-sol / gpt-5.6-sol / gpt-5.6-terra：low..ultra 六档
   - gpt-6-luna / gpt-5.6-luna：low..max 五档
4. **按模型定位最新批次（损坏即阻断，绝不回退）**：网站每轮不一定重测所有型号（例如
   2026-11-19 轮只测 6.1/6.2 系列，没有 gpt-6-astra）。只使用 `batches[]`；
   `legacy_batches` 是旧接口的历史视图，不参与选档与降智比较。数据源顶层 `schema` 必须为
   `intelligence-trends/1`、`score_max` 必须为 150、`batches` 必须是对象列表，否则整轮不改
   任何 agent 并报异常。对每个在管模型，把包含它 `points` 的批次按 `completed_at`
   **解析成 UTC 时间戳后倒序**（网站混用 `+00:00` / `+08:00` 偏移，不能按字符串排序）取最新
   批次：若该模型的任一相关批次时间戳无法解析，或最新批次 `score_max` 不是 150（排除
   `bool`），该模型本轮报异常、不动，**不会静默回退到旧批次**。批次里
   `model_efforts[model]` 与脚本档位表不一致时，只在两边都有的档里挑，并报异常。所有来自网站
   的值（档名、benchmark、批次日期等）进评论前一律经 `safe()` 白名单化（只放行
   `[A-Za-z0-9._:-]{1,80}`，其余显示为"\<非法值，已省略\>"）。
5. **新鲜度**：某模型最新有效批次的 `completed_at` 距当前时间超过 72 小时，视为数据过期：
   该模型的 agent 本轮不动并报异常。阈值是脚本顶部常量 `FRESHNESS_HOURS`。
6. **选档（即时分选，不做均线平滑）**：直接使用该模型最新有效批次的各候选档分数。候选 =
   两边都有 + 该档有分数；`S` 为候选最高分，`score >= S − 5` 算并列，取并列里最便宜的
   （low < medium < high < xhigh < max < ultra）。`score` 为 `null` 的档不参与候选；
   `bool`、非数字、`NaN` / `Inf` 属于格式错误，同一批次内重复的 `(model, effort)` 点同样
   属于格式错误，该模型本轮不改并报异常（异常只写类型名，不回显原始值）。无候选则该模型
   本轮不动。
7. **写入**：agent 当前档在档位表里时，该档在最新有效批次里必须有分数，否则这个 agent
   （连同同模型的所有在管 agent）本轮不动并报异常；当前档为空或不在表里则不做此检查。
   目标档 ≠ 当前档时执行 `multica agent update <id> --thinking-level <档>` 并
   `agent get` 读回校验。**单个 agent 写入失败或回读不一致只记异常，不中断整轮**：已改成功的
   照常列进评论，后面的 agent 继续处理。同模型的在管 agent 统一同一档。
8. **整体降智**：在最新批次的 `compatibility_key`（必须是**非空字符串**）下，取**同一模型、
   同一 key** 的历史批次，每个 UTC 日取当天各档最高分，在**以今天为终点的最近 7 个 UTC 日**
   （`[今天-6, 今天]`）里取峰值；S 比峰值低 ≥ 10 分时提醒"整体降智，换档没用，要不要换模型
   由 Master 决定"。历史批次中 `score_max` 不是 150（含 `bool`）或 `compatibility_key` 不是
   非空字符串的直接跳过；不同 key（裁判模型或题面规则变更）的批次不参与比较，避免误报。
   脚本不换模型。
9. **评论**：每轮最多一条，换档/异常/降智合并；什么都没发生就不发。换档评论里写明各档分数
   和该模型所用批次的 UTC 日期。不 @ 任何人，不去重、不记状态。通过
   `multica issue comment add <issue> --content-file <文件>` 发送。异常部分写明这一轮因此
   没改哪些 agent。

## 参数常量

都定义在 `effort_tuner.py` 顶部：`TIE_RANGE=5`、`FRESHNESS_HOURS=72`、
`DEGRADE_THRESHOLD=10`、`HISTORY_WINDOW_DAYS=7`、`FETCH_BUDGET_S=600`（环境变量
`EFFORT_TUNER_BUDGET_S` 可覆盖）、`TRENDS_URL`、`TRENDS_SCHEMA`、`SCORE_MAX`。

## 测试

```sh
python3 tools/effort-tuner/test_effort_tuner.py   # 或 python3 -m pytest tools/effort-tuner/test_effort_tuner.py
```

不访问网络，86 个用例约 0.2 秒跑完。`fixtures/intelligence-trends.json` 是新版数据源的
精简样例（含 `+00:00` / `+08:00` 混合偏移、最新批次缺 gpt-6-astra、不同 compatibility_key
的批次、以及 GPT-6.2 两个型号）。覆盖：排除名单解析与注入、在管 agent 过滤、时间戳归一化、
按 UTC 倒序选批次、损坏批次阻断而非回退、档位表与网站不一致、并列选档边界、null / bool /
NaN / Inf / 非数字分数、重复 `(model, effort)` 点、新鲜度阈值、同 compatibility_key 的
7 天峰值与窗口边界（含历史批次的 `score_max` / key 类型过滤）、抓取重试与
schema/score_max/`batches` 结构校验、`MULTICA_CLI_PATH` 优先级，以及用假 multica / 假 HTTP
的端到端轮次测试（dry-run 不写不发、写入失败继续、回读不一致继续、名单非法不抓不改、
评论经 `--content-file` 发出、提及注入不生效等）。

## 文件

- `effort_tuner.py` — 脚本本体
- `test_effort_tuner.py` — 单元测试（86 个，离线）
- `fixtures/intelligence-trends.json` — codexradar.com 新版数据源的精简样例
