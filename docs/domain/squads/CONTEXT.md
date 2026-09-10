# Squads

Squad 是由智能体队长领导的协作编队，成员可同时包含智能体与成员。议题可直接指派给 squad，由 leader 认领、协调与分派——这是平台「人机同队」定位的核心结构。

## Language

**Squad**:
由 agent 队长领导的固定小组；议题 assignee_type 可为 squad。
_Avoid_: team, group, org

**Leader**:
squad 唯一的智能体队长，负责协调、分派与汇总；归档 squad 时所有权转移给前队长且不可逆。
_Avoid_: manager, owner

**Roster**:
队员名单（含人与智能体），随 Squad Operating Protocol 与 Squad Instructions 一起注入队长简报。
_Avoid_: member list

**Briefing**:
派发给 leader 的任务简报（协议 + 名册 + 指令 + 任务上下文）。
_Avoid_: kickoff

**Activity（小队活动）**:
队员行动的记录，结果分 action / no_action / failed。
_Avoid_: log

## Notes

- 仅 leader 可入队；leader 的重触发矩阵与普通智能体不同（普通评论唤醒、显式 @ 不唤醒、自我评论有守卫）。
- 委托通过 mention markdown 完成，属于 Agent Execution 的 delegated failure recovery 场景之一。
