# Issue Tracking

议题是日常工作的基本单元：一件要完成的工作，以及围绕它积累的描述、讨论、状态与历史。本上下文覆盖议题聚合、状态目录、评论线程、依赖图、标签、自定义字段、保存视图与置顶。

## Language

**Issue**:
要完成的一件工作，含描述、讨论、状态与历史；可指派给成员、智能体或 squad；至多属于一个 project。
_Avoid_: task, ticket, card, story

**Identifier**:
议题的人类可读编号（如 `MUL-123`），由工作区前缀 + 递增序号组成。
_Avoid_: key（`key` 保留给状态句柄）, number

**Status**:
议题当前所处的工作流节点。内置 7 个，工作区可定义自定义状态（以 key 寻址）。
_Avoid_: state, stage

**Category（状态类别）**:
七个行为等价类：`backlog / todo / in_progress / in_review / done / blocked / cancelled`。自定义状态必须归属一个类别并完整继承其行为；创建后不可改。看板列 = 类别。状态流转无固定矩阵，行为钩子按有效类别生效。
_Avoid_: group, bucket

**Priority**:
`urgent / high / medium / low / none`。
_Avoid_: severity

**Stage**:
同级子议题之间的屏障分组（阶段门槛），1 起始整数；父议题跨 stage 推进。
_Avoid_: phase, sprint, milestone

**Comment**:
议题下的讨论条目，类型为 comment / status_change / progress_update / system；作者可为成员、智能体或系统。
_Avoid_: note, post

**Thread**:
由 parent_id 组织的评论回复串，可整体标记已解决/未解决。
_Avoid_: chain

**Dependency**:
议题间前置关系，规范方向为 `blocked_by`（另有 `blocks` 冗余视图、`related` 惰性）；仅 `done` 类别可满足前置；全图校验环与祖先冲突。
_Avoid_: link, relation

**Label**:
可复用的归类标记，可贴到议题/智能体/技能。
_Avoid_: tag

**Property**:
工作区自定义字段定义（text/number/select/multi_select/date/checkbox/url），值存于议题。
_Avoid_: attribute

**View**:
保存的议题过滤视图（范围：workspace/my/project），私有或工作区共享。
_Avoid_: filter（View 是已保存物，filter 是即时条件）

**Pin**:
置顶项，对象类型为 issue / project / view。
_Avoid_: favorite, star

## Notes

- 去重守卫：同（工作区, 项目, 父议题, 规范化标题）存在未终结议题时拒绝创建。
- 系统代写状态变更仅两种：Run 失败回滚 `in_progress`→`todo`；带 close intent 的 PR 合并 → `done`。
- `backlog` 是停车场：移入不触发 Run，移出才触发。
