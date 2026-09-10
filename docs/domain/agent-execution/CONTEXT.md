# Agent Execution

Run 是智能体的一次具体执行记录，也是本平台的核心运转闭环：触发 → 排队 → 认领 → 执行 → 回写/重试/恢复。每个触发来源（指派、@提及、chat、autopilot、quick create）都产生 Run；一个议题可产生多个 Run，Run 完成不代表议题完成。

## Language

**Run**:
智能体的一次具体执行记录。用户可见术语为 Run；API/DB 内部标识为 `task`（`task_id`）。一条 Run 永不等于一个议题。
_Avoid_: task（用户面）, job, execution

**Trigger**:
引发 Run 的动作来源：指派/状态变更、@提及回复路由、chat 消息、autopilot 派发、quick create。
_Avoid_: event（Trigger 是因果，event 是通知）

**Claim**:
运行时从队列原子认领一条排队中的 Run；同一（议题, 智能体）至多一条待执行 Run。
_Avoid_: lease, acquire

**Retry**:
失败后按原因分类与预算自动创建的接续 Run（如 runtime 离线 2 次、provider 网络 3 次）；与手动 Rerun 区分。
_Avoid_: rerun, replay

**Rerun**:
人手动发起的重新运行，强制全新会话。
_Avoid_: retry

**Attribution**:
把 Run 归责到一名可问责人类的解析结果（瀑布：direct_human → channel_integration → delegation → …），失败时 fail-closed。
_Avoid_: blame, owner

**Failure Reason**:
Run 失败的分类码（平台码如 `runtime_offline`、`queued_expired`、`timeout`；工具侧 `agent_error.*` 细化族）。
_Avoid_: error message（展示文本，不是分类）

**Coalescing**:
多条连续评论合并进入同一条待派发 Run 的机制。
_Avoid_: batching

## Notes

- 生命周期：`queued → dispatched → running → completed / failed / cancelled`，另有 `waiting_local_directory`（本地目录路径锁挂起）与延迟派发（`fire_at`）。
- 认领-响应恢复：心跳超时内的认领丢失会被找回并优先还给原运行时。
- 委托失败恢复：被委托（A2A/提及）的 Run 终态失败时，向协调者议题投递一条持久系统评论（`covered/replayed/exhausted` 三结局，最多 3 次派发尝试）。
- 终态写入与恢复结算必须在同一事务提交。
