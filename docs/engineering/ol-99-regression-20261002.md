# OL-99：v0.6.1 功能回归与构建核验

2026-10-02，承接 OL-98 合并后的批次 B。核对确认：旧版 CLI（0.5.3）修改带条件或自定义触发上限的 wakeup 规则时，会整条替换配置，这是上游 v0.6.1 的行为。按 Master 在本任务线程中的决定，fork 不加兼容代码，通过服务端部署当天统一升级五台 agent 机器来避开版本混用。本 PR 最终仅包含测试与文档，不改变产品行为。正式候选制品仍须等本 PR 审查合入 Fork main、SHA 和标签获批后生成；本次没有执行生产变更或与上游沟通。

## 源码与环境

- 仓库：`AstralSolipsism/multica`；基线 `9e346b4d7f510aa9039e93c4392f7d54ed1b0e0d`，即 OL-98 的 PR #56 合并结果。
- 唤醒行为保持基线：原 `296ea0347e03e451a5f63f33ab4269ea34448fda` 中的兼容代码及对应测试已由 `c51c5e6b716b86729447453f26d26b03144ec6a9` 单独撤回，保留其中的文档。旧 CLI 整条替换新规则的风险按 Master 决定通过统一升级处理。
- 浏览器测试更新：`0fc5bf30805859966ca5190ac82aaed5f6c21849`、`70eb845a13d08e20aa183378180f2fb2d926ac47`。后者仅修正测试对 ELK 端口的识别，未改产品代码。
- Linux `5.15.0-157-generic`，Go `1.26.6`，Node `24.21.0`，pnpm `10.28.2`，PostgreSQL `15.19`。本地独立数据库通过仓库环境脚本创建，迁移到当前 631 个 up 文件；未连接生产数据库。
- 浏览器连接本地真实 API/数据库；需要分配任务的用例只使用测试创建的假 agent/runtime，以队列记录断言行为，不执行真实 agent，也不向真实企业微信/飞书会话发消息。

## 回归结论

| 范围 | 结果与证据 |
| --- | --- |
| 旧客户端 wakeup 更新 | 旧版 CLI（0.5.3）不认识 `condition` / `max_fires`；修改带条件或自定义上限的规则时会整条替换配置，条件被移除、连续事件上限恢复默认 20。这是上游 v0.6.1 的行为，按 Master 决定不增加兼容层或临时拦截；发布当天统一升级所有 agent 机器。新版 `wakeup update` 同样是完整替换，须提供所有预期字段，不能把“已升级”理解成省略字段自动保留。 |
| 系统唤醒与旧 daemon | handler/service 测试覆盖 child-done 持久化、直接写入后的补扫、只触发一次、默认 20 次、连续事件限流、等待运行合并、取消与解除合并。带 `joined-wakeups-v1` 的 daemon 领取合并输入；旧 daemon 不领取这些输入，唤醒随后独立执行。见 `issue_wakeup_v2_test.go`、`issue_wakeup_join_test.go`、`issue_wakeup_safety_test.go`。 |
| DAG 与依赖 | 浏览器验证 LR/TB 布局、阶段分隔、真实依赖箭头、独立任务单独展开、返回后的视口，以及关系编辑、长标题、保存视图、方向切换端口、正常分配和取消。原 OL-44 E2E 仍断言已退役的执行许可，现按 `upstream-sync-20260926.md` 的明确决策更新；没有恢复依赖执行拦截。ELK 每条边有独立端口，测试现在校验对应端口，而非同节点的第一个端口。 |
| autopilot | 只读检查当前工作区两个 autopilot：任务进度跟踪没有触发器，上游同步使用定时触发/run-only；配置没有依赖旧父任务完成评论的事件规则。仅覆盖这两个平台配置及仓库调用点，不声称覆盖外部自建脚本。 |
| PR 合并设置与迁移 551 | `TestPRMergeStatusMigration` 对七种存量工作区数据实际执行 SQL 两遍：没有链接/仅有关闭关键词合并保留缺省（done）；普通合并、混合合并、已有链接但尚未合并、旧开关 false 写入 none，并给旧客户端回写 false；已有明确 in_review 保留。内部技能及中英文 squad 文档已改为新的工作区规则。当前线上旧版本尚未执行该迁移，读取设置未见 `pr_merge_status`；不能把测试数据库结果宣称为生产迁移结果。保留两个历史 551 文件，不改 ledger。 |
| Agent 历史分页 | 扫描 endpoint 和 API 调用：Web/Desktop 使用 `listAgentTasksPage` 与 infinite query；CLI 提供 `--limit` / `--before`。quota/runtime 页使用各自 usage/runtime 接口；未发现应修改的旧无界调用。`agent_tasks_pagination_test.go` 覆盖分页边界、跨页统计和私有 agent 访问隔离。移动端未运行完整构建/测试。 |
| 本地搜索 | 在 `FF_LOCAL_SEARCH_INDEX=on` 的本地真实环境，浏览器验证首次快照、服务端排序一致、远端变更、退出删除 IndexedDB、成员移除删除副本。新增容量测试让真实 manifest 响应报告 500 MiB + 1，确认不下载快照且调用服务端搜索；未实际分配 500 MiB 数据，未做容量性能压测。符合父任务“先验收再决定”的条件，未发现必须关闭该功能的回归；上线是否启用留在发布配置记录中，本次没有改线上开关。 |
| 插件 hook 与界面文档 | `plugin_agent_tools.go` 将 `-` 编码为 `__`，下划线保留；碰撞、命名空间、声明工具与发现路径已有测试通过。仓库没有找到需要改写的生产硬编码旧 hook 名。HTML 附件点击打开文档、预览 hook 及重组设置页的组件测试已覆盖；未发现额外定制入口修复。 |
| 企业微信/飞书与定制投递 | 集成包、handler/service 及独立 message-delivery 包通过 race 测试；企业微信重复不可读消息、发送失败释放去重、去重服务不可达，以及飞书授权/撤销、来源隔离、主动投递/收件箱/项目路由使用现有测试。保持 OL-98 的外部会话默认拒绝策略。没有真实租户消息联调或生产送达保证。 |

## 实际执行的检查

下表保留首轮检查记录，对应上文 `296ea0347` 至 `70eb845a1` 的源码；其中当时的兼容逻辑已经撤回，不能把首轮结果当作当前唤醒代码的复测结果。命令从仓库根目录运行；Go 使用 `GOTOOLCHAIN=go1.26.6`、`GOMAXPROCS=4`。有数据库的命令加载本地 `.env.worktree`。安装依赖使用 `pnpm install --frozen-lockfile`。

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

### 按 Master 决定撤回兼容代码后的复测

该轮测试源码为 `c51c5e6b716b86729447453f26d26b03144ec6a9`；截至 `85021b08c` 仅追加了报告更新。保留的三个 E2E、两份 squads 文档与复审前 `3526d1e65` 完全一致；技能文档仅恢复 `wakeup update` 原文，PR merge status 与 joined-wakeups-v1 段落保留。后续 CI 修复见下一节。

- 执行 `git diff origin/main...HEAD -- server/internal/handler/issue_wakeup.go server/internal/service/issue_wakeup.go server/cmd/multica/`，输出为空；`origin/main` 已从 Fork 刷新，仍为 `9e346b4d7`。兼容测试文件已删除，`git diff --check` 通过。
- 在不含运行任务 marker 的独立 worktree，加载本地 `DATABASE_URL`，先执行 `SELECT current_database(), count(*) FROM schema_migrations`，确认连接测试数据库且有 631 条记录。没有删除或修改任务 marker。
- 经 `scripts/go-test-with-agent-cli-guard.sh` 执行 `go -C server test -json -race -count=1 -p 1 -run '<精确测试名正则>' ./internal/handler ./internal/service ./cmd/multica`。首批选择三个包 `*wakeup*test.go` 中全部 94 个顶层测试，再按相同命令追加其他文件中带 Wakeup/ChildDone 的 20 个测试。JSON 逐项核对预期名称、run 和 pass 事件：handler **42/42**、service **67/67**、CLI **5/5**，共 **114 个顶层测试通过，0 失败、0 跳过**。额外两个通知用例配置了独立 Redis 7.0.15 实例（`REDIS_TEST_URL`），没有因 Redis 缺失跳过。命令的精确参数和预期测试名随本轮验证附件交付。
- Go 测试完成后启动恢复代码的本地 API，`/health` 确认 commit `c51c5e6b7`；执行 `pnpm exec playwright test e2e/issue-wakeups.spec.ts --reporter=json`，**2/2 通过、0 跳过、0 flaky**，用时约 139 秒。浏览器仍连接真实本地数据库。补充 Go 用例在关闭 API 后执行，避免后台 worker 干扰。
- 本轮未重跑其余前端测试和构建，首轮结果保留于上表；候选仍需从最终批准的源码重建。

### CI 文档长度修复

`85021b08c` 的 [CI run 37023753317](https://github.com/AstralSolipsism/multica/actions/runs/37023753317) 中，`backend-tests` 的唯一失败是 `TestBuiltinSkillsConformToTemplate/multica-platform`：`references/issues.md` 达到 519 行，超过现有 500 行上限；`backend` 汇总检查随之失败。本地定向执行相同测试复现了同一错误。

- 把 PR 关联、合并状态、交付约定和状态读取说明完整移到 `references/pull-requests.md`，更新 skill 路由、旧 skill 跳转及现有测试的文档位置。按测试的计数方式，`issues.md` 为 400 行，新文件为 131 行；没有放宽行数限制或删除契约断言。
- 原文逐行核对保留，PR merge status 与状态读取正文逐字节一致；`Default for code-changing issue work` 回到 PR linking 标题下，解决审阅者提出的层级问题。唤醒产品代码保持基线，三个 E2E 与 squads 文档未改。
- 经 CLI guard 执行 `GOTOOLCHAIN=go1.26.6 GOMAXPROCS=4 go -C server test -json -race -count=1 -run '^(TestBuiltin|TestPlatformSkill|TestLegacyRedirect)' ./internal/service`，8 个顶层测试及 25 个子测试全部通过，0 失败、0 跳过。这些测试直接检查内置 skill，不需要数据库；没有把数据库不可用导致的跳过算作成功。
- Master 已授权修复 CI 后合入并完成本任务。最终 CI 与合并 SHA 记录在任务收尾评论；正式候选制品、部署及五台机器升级仍按下文发布安排执行，不能把任务收尾等同于已发布。

## 构建与版本来源

下表是首轮源码的历史开发构建，包含随后撤回的兼容逻辑，不代表复审后 HEAD，也不能进入升级 feed。候选必须从最终获批的 SHA 重新完整构建，不能复用这些产物。

| 组件 | 本次核验 | 正式候选应满足 |
| --- | --- | --- |
| Linux amd64 server / migrate / CLI（含 daemon） | `make build`；执行三个版本命令，均为 `dev-70eb845a13d0`，完整 SHA `70eb845a13d08e20aa183378180f2fb2d926ac47`、Go 1.26.6。 | 相同的 `0.6.1-labrastro.N`、完整已批准 SHA；CLI/daemon 一同升级。 |
| Web | `STANDALONE=true NEXT_PUBLIC_APP_VERSION=0.6.1-dev-ol99 pnpm --filter @multica/web build` 成功，源码为 `70eb845a13d08e20aa183378180f2fb2d926ac47`。额外校验 BUILD_ID 为本次构建生成、standalone 入口存在、客户端 chunk 包含精确版本字面量。 | `NEXT_PUBLIC_APP_VERSION` 与候选标签一致，独立核验 standalone 客户端 bundle。 |
| Desktop Linux x64 | `pnpm --filter @multica/desktop package --linux --x64 --dir --publish never` 成功；ASAR 与内嵌 CLI 均报告 `0.5.3-labrastro.9-67-g0fc5bf308`，这是 development 路径由最近 Fork tag 派生的 describe 版本，源码含 v0.6.1 及随后撤回的兼容逻辑。内嵌 CLI 执行版本验证通过。 | package extraMetadata、Web、内嵌 CLI 与候选标签统一。不能拿这个 describe 包作为 v0.6.1 发布包。 |
| Windows、Linux arm64、镜像与完整安装器 | 未生成真实制品，未运行原生 Desktop 安装/升级烟测；不能由上述契约 fixture 推定通过。 | 按 `.github/RELEASING.md` 的完整构建图在相应 runner 生成、校验并汇总。 |

CLI 的 `server/internal/cli/update.go`、daemon 自动更新和 runtime 更新共用 `https://multica.outlune.com/downloads`。Desktop 实际打包的 `app-update.yml` 指向 `https://multica.outlune.com/downloads/desktop`；CLI 引导也指向内部源。更新比较、拒绝 dev/dirty 版本、校验和及来源测试通过。未把客户端切向 upstream GitHub Releases，也未改 `latest.json` 或 Desktop feed。

## 交付边界与后续

1. 审查本次测试与文档 PR 并合入 Fork main。本 PR 不包含产品代码、schema 或数据转换改动，不与 `multica-ai/multica` 沟通或向其提交 issue/PR。
2. 重新获取 Fork tags，以最新序列确定 `v0.6.1-labrastro.N`（首轮扫描的下一建议是 `.1`，不是保留或已创建的标签）。`.github/RELEASING.md` 要求源码是 “one reviewed commit contained in the freshly fetched fork main”，并明确标签创建需要单独授权。不能将尚未合入的 HEAD 冒充已审查候选来源。
3. 授权 SHA/标签确定后执行完整候选构建，保存各平台 manifest/校验和及升级烟测；在隔离环境记录实际目标工作区的 551 迁移结果。正式迁移前备份，失败时按发布回滚流程恢复；不通过改写 migration ledger 回滚。
4. 服务端部署完的当天，按 Master 已确定的安排，将 agent-main-01、agent-kimi-02、agent-gcp-01、agent-ops-host-149、DESKTOP-FUTDPFH 的 multica 升级到同一个候选版本。先用 `multica runtime list` 对照机器名取得运行时 ID，再逐台执行 `multica runtime update <运行时ID> --target-version <候选版本> --wait`，记录每台结果。容器中的机器须同时更新镜像，避免重建后退回旧版。全部升级完后再次执行 `multica runtime list`，核对所有在线运行时版本一致；若有失败，先修复升级再让该机器继续处理任务。DESKTOP-FUTDPFH 在本次决策时离线，开机后先升级、验证版本，再使用。过渡期避免旧 CLI 修改带新字段的规则；不以自托管环境默认自动更新替代逐台验收。
5. 发布窗口及实际本地搜索开关仍由 Master 决定。真实企业微信/飞书联调、生产数据迁移、支持新 PIDFD 能力的 runner 验证、原生 Windows/Desktop 安装与 feed 激活均不在本次已验证结果之内。本轮只修改发布步骤，没有执行这些机器的升级。
