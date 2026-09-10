# Plugins

Plugin 是以沙箱 iframe 中运行的脚本扩展产品能力的方式：用户经 Settings 安装并授予能力范围，平台经 Hook 把事件分发给 plugin。Plugin 发表的评论以用户身份发出，且不触发智能体 Run。

## Language

**Plugin**:
可安装的能力扩展包，由一个或多个 surface 组成；经安装记录（Installation）按工作区启用。
_Avoid_: extension, app

**Surface**:
plugin 呈现的一个界面脚本（运行于沙箱 iframe，受 CSP 约束）。
_Avoid_: view（View 已被保存视图占用）

**Manifest**:
plugin 的能力与权限声明（安装时展示并授权）。
_Avoid_: config

**Scope**:
用户授予 plugin 的能力范围（决定其可调用哪些平台能力）。
_Avoid_: permission（permission 属于成员/智能体授权词汇）

**Hook**:
plugin 订阅平台事件并被回调调用的挂接点。
_Avoid_: webhook（webhook 是 Autopilot 的入站触发器）

**Installation**:
工作区安装某 plugin 的记录（版本、授权范围、配置、启停）。
_Avoid_: setup

**Package**:
plugin 的分发单元（包 + 版本 + 文件，sha256 校验）。
_Avoid_: bundle（bundle 是运行时技能包词汇）

## Notes

- 密钥（secret）独立存表加密存储，任何读路径不可达。
- 调用有熔断（breaker）与超时，结果状态 ok/failed/timeout/refused；错误不回传响应体。
