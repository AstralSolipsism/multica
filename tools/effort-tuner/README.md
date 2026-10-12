# effort-tuner

Codex 推理强度（effort/thinking level）自动调档脚本。从 codexradar.com 抓各模型各档位的
benchmark 分数，把在管 agent 统一到"并列最高分里最便宜"的档位，并把换档、异常、整体降智
提醒汇总成一条评论发到跟踪 issue。规则来自 OL-252，实现对应 OL-259。

只依赖 Python 3 标准库；`multica` CLI 需在 PATH 里且已登录。已在 agent-kimi-02 上确认
python3 3.11.2 可用。

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

## 运行时长与调用方式（在 agent-kimi-02 / Hermes 上实测）

整轮抓取受硬预算约束：默认 600 秒（环境变量 `EFFORT_TUNER_BUDGET_S` 可覆盖），binding 和
每个分数请求的超时都被剩余预算封顶，所以抓取阶段的总耗时不会明显超过预算。请求逐个发、
单个超时最多 130 秒、失败的档等其他档都完成后重试一次（binding 也重试一次）。codexradar.com
冷缓存时单个请求可能挂约 2 分钟后返回 Cloudflare 524，属预期。

2026-10-12 在 agent-kimi-02 的 Hermes 会话里用 terminal 工具实测：

- **前台命令超时上限 600 秒**：请求 `timeout=601` 会被工具拒绝（提示超过 600s cap），自动转为
  后台跟踪进程执行；后台进程**没有命令超时**，实测 `sleep 610` 完整跑完、退出码 0。
- 因此推荐两种调用方式：
  1. **后台运行（推荐，冷缓存也安全）**：terminal 工具 `background=true`（配 notify）执行脚本，
     完成后取结果。脚本最坏耗时 ≈ `EFFORT_TUNER_BUDGET_S` + 少量处理时间，600 秒预算也兜得住。
  2. **前台运行**：把 `EFFORT_TUNER_BUDGET_S` 调小（如 `EFFORT_TUNER_BUDGET_S=300`），让最坏
     耗时落在 600 秒上限以内。
- autopilot 触发的运行同样经 Hermes 的 terminal 工具，适用同一结论；不要依赖"autopilot 不设
  命令超时"的说法。

注意：脚本发的是跟踪 issue 的顶层评论（不带 `--parent`）。如果这一轮运行本身是由 OL-252 上的
评论触发的，服务端会返回 409 拒绝发评论；由 autopilot 或定时唤醒触发的运行不受影响。

## 规则摘要

1. **在管 agent**：`multica runtime list` 里 provider 为 `codex` 的 runtime 上的 agent，
   去掉已归档的。先应用排除名单（第 2 条），再查模型：model 为空的（daemon 会丢掉档位设置）、
   model 不在档位表里的，跳过并报异常。
2. **排除名单**：跟踪 issue 描述中的 ` ```effort-tuner-exclude ` 围栏代码块，每行一个
   agent ID，`#` 后为注释，空行忽略。名单里的 agent 完全静默跳过（包括模型检查，不再报异常）。
   代码块缺失或某行不是合法 UUID 时，这一轮不改任何配置，并把该异常写进评论。
3. **档位表**（codex-cli 0.160.1 `codex debug models`）：
   - gpt-6-astra / gpt-6.1-sol / gpt-6-sol / gpt-5.6-sol / gpt-5.6-terra：low..ultra 六档
   - gpt-6-luna / gpt-5.6-luna：low..max 五档
4. **抓取**：binding（`/data/radar-bench-binding.json`，失败重试一次，仍失败则本轮不改任何
   agent 并报异常）+ 每档分数（`/api/radar-bench-score?...&selection=user-selected-v1`，
   缺 selection 会 428）。只抓在管 agent 用到的模型；User-Agent 为 `labrastro-effort-tuner/1`。
   脚本档位表和网站 `model_efforts` 对不上时，只在两边都有的档里挑，并报异常。网站返回的档名
   只接受 `^[a-z0-9._-]+$` 形式，其余按"对不上"处理，避免第三方字符串进评论。
5. **选档**（按模型）：候选 = 两边都有 + 抓到 + score 非 null + coverage ≥ 56；候选中
   最高分 S，`score ≥ S − 5` 算并列，取并列里最便宜的（low < medium < high < xhigh <
   max < ultra）。候选各档及 binding 的 `benchmark`/`task_set_sha256` 必须一致，否则该
   模型不改并报异常（异常里写明该模型本轮未改哪些 agent）。无候选则该模型本轮不动。
   返回格式不对（score 不是数字、coverage 不是整数等）同样阻断该模型。
6. **写入**：agent 当前档在档位表里时，该档本轮必须抓到，否则这个 agent（连同同模型的
   所有在管 agent）本轮不动并报异常；当前档为空或不在表里则不做此检查。目标档 ≠ 当前档
   时执行 `multica agent update <id> --thinking-level <档>` 并 `agent get` 读回校验。
   **单个 agent 写入失败或回读不一致只记异常，不中断整轮**：已改成功的照常列进评论，
   后面的 agent 继续处理。同模型的在管 agent 统一同一档。
7. **整体降智**：各档 history 里 coverage ≥ 56 的点按 UTC 日取各档最高分，在**以今天为终点
   的最近 7 个 UTC 日**（`[今天-6, 今天]`）里取峰值；S 比峰值低 ≥ 10 分时在评论里提醒
   "整体降智，换档没用，要不要换模型由 Master 决定"。数据停更时窗口照旧以今天为终点，
   7 天以前的历史不参与。脚本不换模型。
8. **评论**：每轮最多一条，换档/异常/降智合并；什么都没发生就不发。不 @ 任何人，不去重、
   不记状态。通过 `multica issue comment add <issue> --content-file <文件>` 发送。异常部分
   写明这一轮因此没改哪些 agent。

## 参数常量

都定义在 `effort_tuner.py` 顶部：`TIE_RANGE=5`、`COVERAGE_MIN=56`、
`DEGRADE_THRESHOLD=10`、`HISTORY_WINDOW_DAYS=7`、`FETCH_BUDGET_S=600`（环境变量
`EFFORT_TUNER_BUDGET_S` 可覆盖）。

## 测试

```sh
python3 tools/effort-tuner/test_effort_tuner.py   # 或 python3 -m pytest tools/effort-tuner/test_effort_tuner.py
```

不访问网络；`fixtures/` 是 2026-10-11 从 codexradar.com 抓的原始响应（gpt-6-astra 缺
low 档，gpt-6.1-sol 只有 low 档）。除了纯函数测试，还有用假 multica / 假 HTTP 的端到端
轮次测试（dry-run 不写不发、写入失败继续、回读不一致继续、名单非法不抓不改、评论经
`--content-file` 发出等）。

## 文件

- `effort_tuner.py` — 脚本本体
- `test_effort_tuner.py` — 单元测试（48 个，离线）
- `fixtures/` — codexradar.com 原始响应（测试固定数据）
