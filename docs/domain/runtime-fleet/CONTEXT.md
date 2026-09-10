# Runtime Fleet

执行侧：Run 实际运行的地方。daemon 是每台计算机上一个的宿主进程；runtime 是「一台计算机 × 一个 AI 编程工具」在工作区内的注册实例。智能体是身份，runtime 是计算机。

## Language

**Runtime**:
实际执行 Run 的计算环境：一台已连接计算机 + 其上一种 AI 编程工具，按（工作区, daemon, provider）唯一注册，有心跳与在线状态。
_Avoid_: worker, executor, environment

**Daemon**:
每台计算机上运行一个的后台宿主进程，管理该机全部 runtime，通过配对会话注册，持有任务级临时凭证。
_Avoid_: agent（语义陷阱）, service, host

**Runtime Profile**:
工作区级自定义后端工具定义（协议族 + 启动参数），用于接入目录外工具。
_Avoid_: template, preset

**Provider**:
runtime 使用的 AI 编程工具族（claude、codex、kimi、opencode 等 25 个协议族）。
_Avoid_: model（model 是 LLM 型号）, CLI（实现细节）

**Heartbeat**:
runtime 周期活性上报；静默超时（约 150s）即被判离线。
_Avoid_: ping

**Cloud Node**:
云端托管的运行时节点（`mcn_` 凭证），与本地 daemon 并列的托管形态。
_Avoid_: cloud agent

**Visibility（运行时可见性）**:
runtime 的 `private / public`（注意与智能体的 `workspace / private` 是两条不同词汇轴）。
_Avoid_: access

## Notes

- 容量：daemon ≤20 并发 Run、agent ≤6，实际取 min。
- 清扫器（sweeper）负责把失活 runtime 判离线、孤儿 Run 回收、过期排队 Run 判失败。
