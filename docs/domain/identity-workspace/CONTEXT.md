# Identity & Workspace

平台账号与工作区：团队（人和智能体）协作的自包含边界。工作区是所有业务对象的租户根，成员资格是一切访问控制的前提。

## Language

**Workspace**:
团队与智能体协作的自包含范围；成员、议题、项目、智能体、技能、运行历史都归属一个工作区。
_Avoid_: organization, team, tenant

**Member**:
用户在某个工作区内的成员身份，附带角色；同一用户在不同工作区是不同成员。
_Avoid_: participant, teammate

**User**:
平台级账号（全局唯一邮箱），跨工作区共享。
_Avoid_: account

**Role**:
成员在工作区中的角色：`owner` / `admin` / `member`；仅 `owner` 可转移所有权。
_Avoid_: permission（权限是授权动作，不是角色）

**Invitation**:
向特定邮箱发出的加入工作区邀请，有 pending/accepted/declined/expired 状态。
_Avoid_: invite（动词混用）

**Share Link**:
凭码加入工作区的共享链接，可限次数与有效期，与 Invitation 并列的两种加入路径。
_Avoid_: invite link

**Personal Access Token**:
用户签发的长期 API 凭证（前缀 `mul_`），可撤销、有过期时间。
_Avoid_: API key

## Notes

- 保留 slug：`server/internal/handler/reserved_slugs.json`（单字根路由如 `/login`、`/inbox`）。
- 工作区有人类可读议题编号前缀（如 `MUL`）与递增计数器，与议题上下文共享 Identifier 概念。
