# effort-tuner

Codex 推理强度（effort/thinking level）自动调档脚本。从 codexradar.com 抓各模型各档位的
benchmark 分数，把在管 agent 统一到"并列最高分里最便宜"的档位，并把换档、异常、整体降智
提醒汇总成一条评论发到跟踪 issue。规则来自 OL-252，实现对应 OL-259。

只依赖 Python 3 标准库；`multica` CLI 需在 PATH 里且已登录。

## 用法

```sh
python3 effort_tuner.py --tracking-issue OL-252            # 正式执行：改 agent + 发评论
python3 effort_tuner.py --tracking-issue OL-252 --dry-run  # 只抓数据、计算、打印，不改不发
```

- `--tracking-issue`：父 issue 的 key 或 ID。脚本从它的描述里读排除名单，评论也发到这里。
- `--dry-run`：照常抓数据和计算并打印结果，但不改任何 agent、不发评论。开发和验证只用这个模式。
- 退出码：正常结束（无论这一轮有没有改动）为 0；脚本自身出错为非 0。

### 运行时长与调用方式

整轮抓取有 10 分钟硬预算（默认 600 秒，可用环境变量 `EFFORT_TUNER_BUDGET_S` 覆盖）：
请求逐个发、单个超时 130 秒、失败的档等其他档都完成后重试一次。codexradar.com 冷缓存时
单个请求可能挂约 2 分钟后返回 Cloudflare 524，属预期；同一轮里重试或下一轮通常就正常。

实测（agent-kimi-02，2026-10-12）：`python3 --version` 为 3.11.2；完整 dry-run 一轮
见 OL-259 的验证记录。若调度方的命令超时低于 10 分钟，需要把超时调到 ≥ 15 分钟，或改用
不设命令超时的方式调用（例如脱离会话的 cron / autopilot，而不是交互 shell 的前台等待）。

## 规则摘要

1. **在管 agent**：`multica runtime list` 里 provider 为 `codex` 的 runtime 上的 agent，
   去掉已归档的、model 为空的（daemon 会丢掉档位设置）、model 不在档位表里的。后两类
   跳过并报异常。
2. **排除名单**：跟踪 issue 描述中的 ` ```effort-tuner-exclude ` 围栏代码块，每行一个
   agent ID，`#` 后为注释，空行忽略。代码块缺失或某行不是合法 UUID 时，这一轮不改任何
   配置，并把该异常写进评论。
3. **档位表**（codex-cli 0.160.1 `codex debug models`）：
   - gpt-6-astra / gpt-6.1-sol / gpt-6-sol / gpt-5.6-sol / gpt-5.6-terra：low..ultra 六档
   - gpt-6-luna / gpt-5.6-luna：low..max 五档
4. **抓取**：binding（`/data/radar-bench-binding.json`）+ 每档分数（`/api/radar-bench-score?...&selection=user-selected-v1`，
   缺 selection 会 428）。只抓在管 agent 用到的模型；User-Agent 为 `labrastro-effort-tuner/1`。
   脚本档位表和网站 `model_efforts` 对不上时，只在两边都有的档里挑，并报异常。
5. **选档**（按模型）：候选 = 两边都有 + 抓到 + score 非 null + coverage ≥ 56；候选中
   最高分 S，`score ≥ S − 5` 算并列，取并列里最便宜的（low < medium < high < xhigh <
   max < ultra）。候选各档及 binding 的 `benchmark`/`task_set_sha256` 必须一致，否则该
   模型不改并报异常。无候选则该模型本轮不动。
6. **写入**：agent 当前档在档位表里时，该档本轮必须抓到，否则这个 agent（连同同模型的
   所有在管 agent）本轮不动并报异常；当前档为空或不在表里则不做此检查。目标档 ≠ 当前档
   时执行 `multica agent update <id> --thinking-level <档>` 并 `agent get` 读回校验，读回
   不一致报非 0 退出。同模型的在管 agent 统一同一档。
7. **整体降智**：各档 history 里 coverage ≥ 56 的点按 UTC 日取各档最高分，最近 7 天取
   峰值；S 比峰值低 ≥ 10 分时在评论里提醒"整体降智，换档没用，要不要换模型由 Master 决定"。
   脚本不换模型。
8. **评论**：每轮最多一条，换档/异常/降智合并；什么都没发生就不发。不 @ 任何人，不去重、
   不记状态。通过 `multica issue comment add <issue> --content-file <文件>` 发送。

## 参数常量

都定义在 `effort_tuner.py` 顶部：`TIE_RANGE=5`、`COVERAGE_MIN=56`、
`DEGRADE_THRESHOLD=10`、`HISTORY_WINDOW_DAYS=7`。

## 测试

```sh
python3 test_effort_tuner.py   # 或 python3 -m pytest test_effort_tuner.py
```

不访问网络；`fixtures/` 是 2026-10-11 从 codexradar.com 抓的原始响应（gpt-6-astra 缺
low 档，gpt-6.1-sol 只有 low 档）。

## 文件

- `effort_tuner.py` — 脚本本体
- `test_effort_tuner.py` — 单元测试
- `fixtures/` — codexradar.com 原始响应（测试固定数据）
