# Integrations & Channels

与外部世界的两面：Integrations 把外部代码平台（GitHub、通用 VCS）的 PR 关联进议题；Channels 把 IM 机器人（Slack/Lark/Telegram/WeCom/DingTalk）作为智能体的对话前端，并把自动化结果投递到群/话题。消息投递路由与投递记录是 Labrastro 分支专属子系统。

## Language

**Integration**:
与外部系统（GitHub App 或通用 VCS 实例）建立的连接；凭证加密存储。
_Avoid_: connector

**Pull Request**:
关联到议题的 PR（GitHub 或通用 VCS），状态 open/closed/merged/draft；带 reference_only 与 close_intent 语义。
_Avoid_: MR（gitlab 俗称，模型层统一为 Pull Request）

**Close Intent**:
PR 上「合并后关闭议题」的意图标记；系统代写状态变更仅此一种外部来源。
_Avoid_: auto-close

**Channel**:
IM 渠道机器人（Slack/Lark/Telegram/WeCom/DingTalk），每个 Bot 绑定一个智能体；入站消息可触发 Run 或 Chat。
_Avoid_: bot（bot 是实现）, bridge

**Binding**:
渠道账号与成员的绑定关系（决定 @ 与回复路由落到谁）。
_Avoid_: link, connection（connection 是 VCS 词汇）

**Message Route（Labrastro）**:
自动化结果到 IM 目标（成员/群/话题）的投递路由；目标三选一形状强约束，带版本 revision。
_Avoid_: rule

**Delivery（Labrastro）**:
按路由发出的一次消息投递记录；内容/目标在决策时刻冻结快照；状态含 uncertain（渠道不确认）与 suppressed。
_Avoid_: message（Message 是 Chat 词汇）

## Notes

- 渠道入站消息带 dedup 与认领令牌（claim token）防重；绑定令牌 TTL ≤15 分钟（schema 级 CHECK）。
- DingTalk/WeCom/Telegram 渠道为社区维护。
- Labrastro 消息投递：dedup_key = run:<run_id>:<installation_id>:<target_key>，来源 run_only/create_issue/test_send。
