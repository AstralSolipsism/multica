# Autopilot

按时间表（cron）或外部事件（webhook/api）自动触发 Run 的自动化。Autopilot 持有 Runbook（指令）、负责人（智能体或 squad）与触发器；每次执行产生一条 Autopilot Run。

## Language

**Autopilot**:
自动触发智能体执行的配置实体；状态 active/paused/archived，删除即归档。
_Avoid_: workflow, pipeline, cron job, automation（中文界面用「自动化」，但模型层术语保持 Autopilot）

**Runbook**:
Autopilot 持有的指令（上下文 + 要求），在每次触发时注入。
_Avoid_: instructions（与智能体 Instruction 冲突）, playbook

**Trigger**:
三种触发器：schedule（cron + 时区）、webhook（验签入站）、api（外部调用）。
_Avoid_: source（source 是 Run 的来源字段）

**Autopilot Run**:
Autopilot 的一次执行记录；状态 pending/issue_created/running/skipped/completed/failed，来源 schedule/manual/webhook/api。
_Avoid_: execution

**Execution Mode**:
`create_issue`（先建议题再触发）/ `run_only`（只执行）；决定 Run 的完成判据。
_Avoid_: mode

**Concurrency Policy**:
新触发与进行中 Run 冲突时的策略：skip / queue / replace。
_Avoid_: strategy

**Rule Version**:
发布时刻的只读规则快照（append-only），系统行为（如自动暂停）也记录版本。
_Avoid_: revision, snapshot

**Webhook Delivery**:
入站 webhook 的接收、验签与准入记录（accepted/skipped/ignored/duplicate）。
_Avoid_: event log

## Notes

- 完成判据按模式分离：create_issue 看议题有效类别（done/in_review → completed；cancelled/blocked → failed）；run_only 看 Run 终态。
- 失败率监控：7 天内 ≥50 次运行且失败率 ≥90% 自动暂停。
- 配额：周期窗口内的运行配额与预留（reserved/consumed/released），超限发 first_rejection_per_period 通知。
