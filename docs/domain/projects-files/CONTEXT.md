# Projects & Files

Project 是组织相关议题、绑定资源的目标容器（进度 = (done+cancelled)÷all）；Project File 是项目内文件的版本化内容，支持 Run 的评审操作闭环。

## Language

**Project**:
组织相关议题于一个目标之下、可绑定资源的容器；负责人可为人或智能体；状态 planned/in_progress/paused/completed/cancelled。
_Avoid_: folder, repo（repo 是外部代码库资源）

**Resource**:
Project 绑定的资源：GitHub 仓库或本机 Local Directory。
_Avoid_: asset, attachment

**Local Directory**:
本机项目目录执行资源；执行方式分 `in_place`（串行，Run 挂起等待路径锁）与 `worktree`（并行，分支 `agent/<agent>/<issue>`）。
_Avoid_: workdir（Run 的工作目录是其结果，不是资源本身）

**Project File**:
项目内文件，按路径唯一，指向当前版本。
_Avoid_: document, blob

**Version**:
Project File 的不可变内容版本（sha256 + 作者 + operation 关联）。
_Avoid_: revision（`revision` 已用于议题乐观锁字段）

**Operation**:
对 Project File 的一次变更操作（actor 为成员或 Run），结果与完成时间成对出现。
_Avoid_: mutation

## Notes

- 议题至多属于一个 Project；Project 进度由议题状态推导。
- Run 可对 project file 发起 review 类操作，构成人机协作的代码评审闭环。
