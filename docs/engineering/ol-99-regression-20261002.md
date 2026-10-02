# OL-99：v0.6.1 功能回归与构建核验

2026-10-02，承接 OL-98 合并后的批次 B。功能回归发现并修复旧客户端更新 wakeup 时丢失 v2 条件和触发上限的问题。正式候选制品尚未生成：修复需要先审查并合入 Fork main，再按发布契约确定 SHA 和授权标签。本次没有变更生产配置、执行生产迁移、发布 Release 或激活下载源。

## 源码与环境

- 仓库：`AstralSolipsism/multica`；基线 `9e346b4d7f510aa9039e93c4392f7d54ed1b0e0d`，即 OL-98 的 PR #56 合并结果。
- 行为修复：`296ea0347e03e451a5f63f33ab4269ea34448fda`。
- 浏览器测试更新：`0fc5bf30805859966ca5190ac82aaed5f6c21849`、`70eb845a13d08e20aa183378180f2fb2d926ac47`。后者仅修正测试对 ELK 端口的识别，未改产品代码。
- Linux `5.15.0-157-generic`，Go `1.26.6`，Node `24.21.0`，pnpm `10.28.2`，PostgreSQL `15.19`。本地独立数据库通过仓库环境脚本创建，迁移到当前 631 个 up 文件；未连接生产数据库。
- 浏览器连接本地真实 API/数据库；需要分配任务的用例只使用测试创建的假 agent/runtime，以队列记录断言行为，不执行真实 agent，也不向真实企业微信/飞书会话发消息。

## 回归结论

| 范围 | 结果与证据 |
| --- | --- |
| 旧客户端 wakeup 更新 | 修复前新增 HTTP 用例复现：省略 `condition` / `max_fires` 的 PUT 清除了条件并把上限 5 改为 20。现在在订阅锁内继承省略字段，也保留历史 NULL/无上限；显式 null/0 仍能清除条件/恢复默认上限。见 `server/internal/handler/issue_wakeup_compat_test.go`。服务内部控制字段不允许从 JSON 注入。CLI 显式发送条件清除和 `--max-fires 0`，避免与省略语义混淆。 |
| 系统唤醒与旧 daemon | handler/service 测试覆盖 child-done 持久化、直接写入后的补扫、只触发一次、默认 20 次、连续事件限流、等待运行合并、取消与解除合并。带 `joined-wakeups-v1` 的 daemon 领取合并输入；旧 daemon 不领取这些输入，唤醒随后独立执行。见 `issue_wakeup_v2_test.go`、`issue_wakeup_join_test.go`、`issue_wakeup_safety_test.go`。 |
| DAG 与依赖 | 浏览器验证 LR/TB 布局、阶段分隔、真实依赖箭头、独立任务单独展开、返回后的视口，以及关系编辑、长标题、保存视图、方向切换端口、正常分配和取消。原 OL-44 E2E 仍断言已退役的执行许可，现按 `upstream-sync-20260926.md` 的明确决策更新；没有恢复依赖执行拦截。ELK 每条边有独立端口，测试现在校验对应端口，而非同节点的第一个端口。 |
| autopilot | 只读检查当前工作区两个 autopilot：任务进度跟踪没有触发器，上游同步使用定时触发/run-only；配置没有依赖旧父任务完成评论的事件规则。仅覆盖这两个平台配置及仓库调用点，不声称覆盖外部自建脚本。 |
| PR 合并设置与迁移 551 | `TestPRMergeStatusMigration` 对七种存量工作区数据实际执行 SQL 两遍：没有链接/仅有关闭关键词合并保留缺省（done）；普通合并、混合合并、已有链接但尚未合并、旧开关 false 写入 none，并给旧客户端回写 false；已有明确 in_review 保留。内部技能及中英文 squad 文档已改为新的工作区规则。当前线上旧版本尚未执行该迁移，读取设置未见 `pr_merge_status`；不能把测试数据库结果宣称为生产迁移结果。保留两个历史 551 文件，不改 ledger。 |
| Agent 历史分页 | 扫描 endpoint 和 API 调用：Web/Desktop 使用 `listAgentTasksPage` 与 infinite query；CLI 提供 `--limit` / `--before`。quota/runtime 页使用各自 usage/runtime 接口；未发现应修改的旧无界调用。`agent_tasks_pagination_test.go` 覆盖分页边界、跨页统计和私有 agent 访问隔离。移动端未运行完整构建/测试。 |
| 本地搜索 | 在 `FF_LOCAL_SEARCH_INDEX=on` 的本地真实环境，浏览器验证首次快照、服务端排序一致、远端变更、退出删除 IndexedDB、成员移除删除副本。新增容量测试让真实 manifest 响应报告 500 MiB + 1，确认不下载快照且调用服务端搜索；未实际分配 500 MiB 数据，未做容量性能压测。符合父任务“先验收再决定”的条件，未发现必须关闭该功能的回归；上线是否启用留在发布配置记录中，本次没有改线上开关。 |
| 插件 hook 与界面文档 | `plugin_agent_tools.go` 将 `-` 编码为 `__`，下划线保留；碰撞、命名空间、声明工具与发现路径已有测试通过。仓库没有找到需要改写的生产硬编码旧 hook 名。HTML 附件点击打开文档、预览 hook 及重组设置页的组件测试已覆盖；未发现额外定制入口修复。 |
| 企业微信/飞书与定制投递 | 集成包、handler/service 及独立 message-delivery 包通过 race 测试；企业微信重复不可读消息、发送失败释放去重、去重服务不可达，以及飞书授权/撤销、来源隔离、主动投递/收件箱/项目路由使用现有测试。保持 OL-98 的外部会话默认拒绝策略。没有真实租户消息联调或生产送达保证。 |

## 实际执行的检查

命令从仓库根目录运行；Go 使用 `GOTOOLCHAIN=go1.26.6`、`GOMAXPROCS=4`。有数据库的命令加载本地 `.env.worktree`。安装依赖使用 `pnpm install --frozen-lockfile`。

| 命令/范围 | 结果 |
| --- | --- |
| `pnpm test` | 6 个 suite 全部重新执行，9,802 tests 通过：core 2,402、views 6,342、desktop 724、web 272、docs 16、ui-lab 46。 |
| `pnpm typecheck` / `pnpm lint` | 10/10、7/7 通过。类型检查有缓存命中；不称为全部无缓存。 |
| `GOFLAGS=-count=1 tini -s -- bash scripts/test-go.sh --race --only regular` | handler/service、integrations、migration 等包通过；CLI 受运行目录父级 task marker 影响，daemon 一个轮询计时断言失败。随后把相同源码复制到不含该 marker 的独立 worktree，以 `go test -race -count=1 -p 1 ./cmd/multica ./internal/daemon` 复测，两包分别 18.158s / 17.153s 通过。没有删除任务安全 marker 或弱化认证。 |
| `go test -race -count=1 -p 1 ./internal/messagedelivery/...`（经 CLI guard） | 64.734s 通过。第一次与本地 API 同库并行导致全局 scan cursor/worker 干扰；关闭 API 后独立执行成功。 |
| `GOFLAGS=-count=1 tini -s -- bash scripts/test-go.sh --race --only agent` | 未全绿：仅四组已有 Cursor background 测试失败（LateDescendant、ReapsLeaderExitedGroup、SurvivesRootExit、Lifecycle），与 5.15 内核不支持所需 PIDFD 行为一致。未删除或跳过这些断言，不把此轮算作通过。 |
| `pnpm exec playwright test e2e/local-search.spec.ts e2e/dag-task-lines.spec.ts e2e/issue-dependencies.spec.ts e2e/issue-wakeups.spec.ts e2e/onboarding-smoke.spec.ts --reporter=line --timeout=120000` | 初次 14/20。更新陈旧依赖测试、ELK 端口断言及首次详情路由编译等待后，按文件/失败用例定向复测；20 个目标用例均通过：搜索 4、DAG 2、依赖 6、wakeup 2、首次使用与去营销 6。没有声称跑过仓库完整 E2E。 |
| `node --test scripts/check-release.test.mjs scripts/build-candidate-web.test.mjs scripts/local-images.test.mjs` | 33/33 通过；安装 Docker CLI / Compose 仅用于配置展开，没有启动 Docker daemon。 |
| `python3 scripts/candidate.test.py` | Python 3.12.15、GoReleaser 2.14.0、QEMU 下通过。使用临时仓库/合成镜像与安装器验证候选聚合、缺件/篡改/身份不一致拒绝；不是实际候选包验收。 |

## 构建与版本来源

本次构建使用仓库的 development 路径，不绕过候选 preflight。开发版本不能进入升级 feed。

| 组件 | 本次核验 | 正式候选应满足 |
| --- | --- | --- |
| Linux amd64 server / migrate / CLI（含 daemon） | `make build`；执行三个版本命令，均为 `dev-70eb845a13d0`，完整 SHA `70eb845a13d08e20aa183378180f2fb2d926ac47`、Go 1.26.6。 | 相同的 `0.6.1-labrastro.N`、完整已批准 SHA；CLI/daemon 一同升级。 |
| Web | `STANDALONE=true NEXT_PUBLIC_APP_VERSION=0.6.1-dev-ol99 pnpm --filter @multica/web build` 成功，源码为 `70eb845a13d08e20aa183378180f2fb2d926ac47`。额外校验 BUILD_ID 为本次构建生成、standalone 入口存在、客户端 chunk 包含精确版本字面量。 | `NEXT_PUBLIC_APP_VERSION` 与候选标签一致，独立核验 standalone 客户端 bundle。 |
| Desktop Linux x64 | `pnpm --filter @multica/desktop package --linux --x64 --dir --publish never` 成功；ASAR 与内嵌 CLI 均报告 `0.5.3-labrastro.9-67-g0fc5bf308`，这是 development 路径由最近 Fork tag 派生的 describe 版本，源码含 v0.6.1 与修复。内嵌 CLI 执行版本验证通过。 | package extraMetadata、Web、内嵌 CLI 与候选标签统一。不能拿这个 describe 包作为 v0.6.1 发布包。 |
| Windows、Linux arm64、镜像与完整安装器 | 未生成真实制品，未运行原生 Desktop 安装/升级烟测；不能由上述契约 fixture 推定通过。 | 按 `.github/RELEASING.md` 的完整构建图在相应 runner 生成、校验并汇总。 |

CLI 的 `server/internal/cli/update.go`、daemon 自动更新和 runtime 更新共用 `https://multica.outlune.com/downloads`。Desktop 实际打包的 `app-update.yml` 指向 `https://multica.outlune.com/downloads/desktop`；CLI 引导也指向内部源。更新比较、拒绝 dev/dirty 版本、校验和及来源测试通过。未把客户端切向 upstream GitHub Releases，也未改 `latest.json` 或 Desktop feed。

## 交付边界与后续

1. 审查本次修复 PR 并合入 Fork main。代码回滚可 revert 本次独立提交，不涉及新 schema 或数据转换。
2. 重新获取 Fork tags，以最新序列确定 `v0.6.1-labrastro.N`（本轮扫描的下一建议是 `.1`，不是保留或已创建的标签）。`.github/RELEASING.md` 要求源码是 “one reviewed commit contained in the freshly fetched fork main”，并明确标签创建需要单独授权。不能将尚未合入的修复 HEAD 冒充已审查候选来源。
3. 授权 SHA/标签确定后执行完整候选构建，保存各平台 manifest/校验和及升级烟测；在隔离环境记录实际目标工作区的 551 迁移结果。正式迁移前备份，失败时按发布回滚流程恢复；不通过改写 migration ledger 回滚。
4. Master 决定发布窗口、实际本地搜索开关及生产升级。真实企业微信/飞书联调、生产数据迁移、支持新 PIDFD 能力的 runner 验证、原生 Windows/Desktop 安装与 feed 激活均不在本次已验证结果之内。
