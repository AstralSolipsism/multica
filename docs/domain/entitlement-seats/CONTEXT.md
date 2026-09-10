# Entitlement & Seats

商业约束上下文：云侧权益策略（Entitlement）门限限制工作区创建行为，席位（Seat）按 outbox 可靠记账。策略与计费主体在本仓库之外（multica-cloud），本上下文只消费其决策。

## Language

**Entitlement**:
云侧权益策略：门（gate）如 `issue_count`、`autopilot_runs`，动作 off/observe/enforce；策略短 TTL 缓存，失效降级为 observe → off（fail-open 降级方向）。
_Avoid_: quota（Quota 是 Autopilot 的运行额度）, limit

**Seat**:
工作区付费席位；邀请预留、加入消耗、成员释放，全程经 outbox 异步记账。
_Avoid_: license

**Outbox**:
席位变更的可靠异步执行记录（action + 必填字段的 schema 级 CHECK + 租约/死信）。
_Avoid_: queue（通用机制词）

**Quota**:
Autopilot 周期窗口内的运行额度与预留（reserved/consumed/released），超限时首拒发通知。
_Avoid_: entitlement（策略）, limit

**Billing**:
计费与订阅由外部 multica-cloud 服务持有；本仓库仅代理其 schema，不设计费聚合。
_Avoid_: payment（本上下文无支付事实）

## Notes

- `issue_count` 门按 `issue` 表行数计数（删除即释放容量），而非工作区计数器。
- 本上下文是支撑域（supporting domain）：其规则完全外置，仓库内只有消费与记账。
