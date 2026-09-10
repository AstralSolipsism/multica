# Context Map

Labrastro（Multica 私有品牌分支）——AI 原生任务管理平台：人与 AI 智能体在同一工作区内协作，智能体作为一等成员拥有议题、评论、变更状态。本图从代码、数据库模式与文档事实还原，各上下文的通用语言见对应 `CONTEXT.md`。

## Contexts

- [Identity & Workspace](./docs/domain/identity-workspace/CONTEXT.md)：平台账号、工作区与成员身份，一切资源的租户边界与访问门槛
- [Issue Tracking](./docs/domain/issue-tracking/CONTEXT.md)：议题、状态目录、评论、依赖与自定义字段——日常工作的基本单元
- [Agent Execution](./docs/domain/agent-execution/CONTEXT.md)：Run（智能体一次执行的完整生命周期：派发、认领、重试、恢复、归因）
- [Agents & Skills](./docs/domain/agents-skills/CONTEXT.md)：智能体配置（身份、指令、模型、技能、访问范围）
- [Runtime Fleet](./docs/domain/runtime-fleet/CONTEXT.md)：实际执行 Run 的计算机集群（daemon 宿主进程 + runtime）
- [Chat & Inbox](./docs/domain/chat-inbox/CONTEXT.md)：不依附议题的一对一对话，以及成员通知收件箱
- [Autopilot](./docs/domain/autopilot/CONTEXT.md)：按时间表或外部事件自动触发 Run 的自动化
- [Squads](./docs/domain/squads/CONTEXT.md)：由智能体队长领导的 agent+人 协作编队
- [Projects & Files](./docs/domain/projects-files/CONTEXT.md)：目标容器与项目文件版本化
- [Plugins](./docs/domain/plugins/CONTEXT.md)：沙箱化扩展能力的安装、授权与钩子
- [Integrations & Channels](./docs/domain/integrations-channels/CONTEXT.md)：GitHub/通用 VCS 关联，以及 IM 渠道机器人与消息投递
- [Entitlement & Seats](./docs/domain/entitlement-seats/CONTEXT.md)：云侧权益门限与席位记账（策略来自外部计费服务）

## Relationships

- **Identity & Workspace → 所有上下文**：成员资格控制访问；`X-Workspace-ID` 选择工作区，几乎每条查询都按 `workspace_id` 过滤（代码事实：`CLAUDE.md` 258、`server/internal/service/issue.go:325-327`）
- **Issue Tracking → Agent Execution**：指派智能体/小队、或状态离开 backlog 类别时触发 Run（`server/internal/service/issue_trigger.go:94`）；Run 完成后以 `progress_update` 评论回写、失败回滚 `in_progress`→`todo`（用户文档 `apps/docs/content/docs/issues.mdx:57-64`）
- **Agent Execution → Agents & Skills**：Run 以某个 Agent 身份执行，简报携带其技能包（`server/internal/service/task.go:6654,6705`）
- **Agent Execution → Runtime Fleet**：Run 由 Runtime 认领执行；daemon 是每台机器上的宿主进程（`server/internal/handler/daemon.go:3379,1702`）
- **Chat & Inbox → Agent Execution**：Chat 每条消息触发一个 Run；Inbox 消费议题/评论/Run/Autopilot 事件生成通知（`server/cmd/server/notification_listeners.go`）
- **Autopilot → Issue Tracking / Agent Execution**：`create_issue` 模式先建议题再触发 Run；run 状态从议题/Run 事件回读同步（`server/internal/service/autopilot.go:1083,1161`）
- **Squads → Agent Execution**：议题指派 squad 时由 leader 认领并协调，leader 通过 mention 分派（`server/internal/service/task.go:1363`）
- **Integrations & Channels → Issue Tracking**：PR 与议题关联（含 close intent 联动状态）；渠道入站消息触发 Run/Chat（`server/internal/service/plugin_event_bridge.go` 之外，见 channel 相关 listener）
- **Plugins → 所有上下文**：经事件桥订阅 issue/comment/task 事件；plugin 发表的评论不触发 Run（`packages/plugin-sdk/README.md:15-66`）
- **Entitlement & Seats → Identity & Workspace / Autopilot**：`issue_count`、`autopilot_runs` 门限限制创建行为；席位变更经 outbox 异步记账（`server/internal/entitlement/README.md:15-50`）
- **Projects & Files → Issue Tracking / Agent Execution**：议题至多属于一个 Project；本地目录资源决定 Run 的 `in_place`/`worktree` 执行方式（用户文档 `apps/docs/content/docs/project-resources.mdx:63-97`）

## Notes

- 术语基线遵循 `apps/docs/content/docs/developers/conventions.mdx`（"the contract"）：用户可见的执行记录叫 **Run**，`task`/`task_id` 仅为 API/DB 内部标识。
- 上游产品文档自称 Multica；本分支的 Labrastro 专属子系统（消息投递等）在各自上下文中注明。
