# Agents & Skills

智能体是工作区内的 AI 协作者——一份可复用配置（名称、指令、模型、技能、访问范围、运行时绑定），被触发时才执行，不是常驻进程。技能描述一类工作如何做，与定义智能体是谁的指令相对。

## Language

**Agent**:
工作区内的 AI 协作者配置；可作为议题负责人（一等成员），拥有状态（idle/working/blocked/error/offline）、并发上限与归档生命周期。
_Avoid_: bot, assistant, worker

**Instruction**:
定义智能体身份与行为准则的系统提示（"who"），区别于 Skill 的 "how"。
_Avoid_: prompt（通用词）, persona

**Skill**:
描述一类工作如何做的可复用能力包：主文件 `SKILL.md` + 支撑文件；可被智能体启用/停用，可来自 plugin。
_Avoid_: tool, plugin

**Access**:
智能体的可被调用范围：仅我 / 整个工作区 / 特定人（内部模型 `permission_mode` + 调用目标白名单）。
_Avoid_: permission（容易与成员权限混淆）

**Invocation**:
对智能体的一次触发许可判定；私有智能体的拒绝理由一律泛化为 `invocation_not_allowed`，不泄露其存在。
_Avoid_: call

**System Agent**:
平台内置智能体（如 `system_key: "mika"`），承担引导/助理职能。
_Avoid_: builtin bot

**Status（智能体状态）**:
服务端状态机 `idle / working / blocked / error / offline`，由在跑 Run 对账得出；客户端另有派生的在线性/负载词汇，不属于服务端模型。
_Avoid_: presence（客户端派生概念）

## Notes

- 就绪度三态：`AgentAvailable` / `AgentWaitable`（运行时离线仍可排队）/ `AgentBlocked`（归档、无运行时、不可执行）。
- 归档是软删除（`archived_at`），squad 队长被归档时 squad 所有权转移给前队长且不可逆。
- 智能体与 runtime 的关系：智能体是身份，runtime 是计算机（见 Runtime Fleet）。
