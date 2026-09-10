# Chat & Inbox

Chat 是不依附议题的一对一智能体对话（每条消息触发一个 Run，完全私密）；Inbox 是成员的通知中心——智能体不使用收件箱。两者共享 mention、订阅与通知语义。

## Language

**Chat**:
成员与单个智能体的一对一对话，独立于议题存在；不隶属于 project，可被归档、置顶。
_Avoid_: DM, channel（channel 是 IM 渠道）

**Message**:
Chat 中的一条对话消息（user/assistant 角色），可携带附件与 quick action。
_Avoid_: comment（comment 依附议题）

**Inbox Item**:
收件箱中的一条通知（24 种类型，如 task_completed、mentioned、quick_create_done），分 action_required / attention / info 三级严重度。
_Avoid_: alert, feed item

**Subscriber**:
订阅某议题通知的成员/智能体，订阅带原因（creator/assignee/commenter/mentioned/manual/autopilot）。
_Avoid_: follower, watcher

**Mention**:
以 @ 引用成员或智能体；引用智能体即触发其 Run（受路由规则约束：回复谁唤醒谁）。
_Avoid_: tag

**Notification Preference**:
按通知组（assignments/status_changes/comments/mentions 等）的 all/muted 偏好，按工作区保存。
_Avoid_: settings（过宽）

**Activity**:
工作区级活动流水，成员/智能体/系统均可为行为者。
_Avoid_: log

## Notes

- 路由规则：回复智能体的评论 → 唤醒该智能体；讨论参与者 → 该智能体；顶层评论 → 负责人；约 5 分钟兜底延迟 Run。
- `/note` 与 `@all` 抑制触发；`@all` 只通知成员。
- Chat 内消息按会话串行（positional queue），取消有明确的 finalize 事件。
