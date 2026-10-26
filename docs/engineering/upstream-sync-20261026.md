# v0.7.0 integration

OL-1119 merges the released upstream history into Labrastro main. This delivery
is a code integration PR; release publication, native installation, production
migrations and deployment remain separate work.

| Source | Commit |
| --- | --- |
| Fork baseline / first merge parent | `8b557555c4cfc38a4ce88078db88d85edae63c97` |
| Released `v0.7.0^{}` / second merge parent | `dbdbb299164347586e2650bb67684a490726a798` |
| Merge base, `v0.6.5` | `654b8ca954034f8181eb6bbb4fc298dede760156` |

The tag annotation is `db6e38c32bdbdd3fd1c98210414c458362df16d1`.
The release contributes 52 commits. The integration uses `git merge --no-ff`,
with no rebasing or post-release upstream commits. Forty text conflicts and
one modify/delete conflict (`custom.css`) are resolved in the same merge.
The exact resulting commit and detached retained-E2E checkout are recorded in
the PR and issue handoff to avoid a self-referential commit ID here.

## Approved conflict decisions

1. Runtimes uses the upstream toolbar, search/status filters, add menu and
   Machines/Cloud services grid. Qoder connection, rows, detail page, agent
   picker, backend storage and routes remain. The 1920px container, GLM card,
   machine quota chips and CPU/memory bars remain; the latter two have matching
   header and Qoder placeholder columns at the wide container breakpoint.
   Ordinary details retain inline host metrics. Coming-soon commercial rows
   are removed, and desktop download links use the internal download source.
   `RuntimeListSchema` still validates quota/adaptive fields and now validates
   `shared_with`, including an empty fallback for absent or malformed values.
2. Hidden status columns move into Display alongside the existing Cost toggle.
   No independent HiddenColumnsPanel remains. `Default` continues to include
   unclaimed custom statuses: a backend regression creates `backlog_2`, reads
   Default twice and verifies it remains. A shared UI regression toggles that
   custom column independently of Cost. No workspace-specific status is
   hardcoded into global defaults. View overflow uses upstream's
   `reserve(fitCount)` callback with the OL-45 stability assertions retained.
3. Create-more retains status, assignee, parent and stage in a batch while
   clearing `blockedByIds` and the stored dependency draft after each create.
   Closing an untouched continuation restores the ordinary default draft.
4. Go is 1.27.3 in `go.mod`, Docker, CI, candidate setup and release jobs;
   Web Docker uses Node 22.23.4-alpine. Desktop is 0.7.0 / Electron ^44.9.3,
   still Labrastro with app-builder-bin 5.0.0-alpha.12 and candidate scripts.
   `mac-update-floor.cjs` and beforePack keep macOS 13.0.0 / Darwin 22.0.0
   distinct. OL-1117's workspaces-root flow and three confirmations remain.
5. Squad wakeups combine current active leader/SquadID with the pending-slot
   guard and frozen authority fields. A real-database regression uses distinct
   rule creator and external grantor, then ticks twice: exactly one leader run
   retains originator, accountable human, delegation source and conversation
   root. Daemon execution combines explicit skill directories/chat references,
   worktree branch/base prompt, delivery repair and adaptive tool-call sampling.
   Claim paths retain RequiredOwnerID; reruns retain both retired-session and
   unsafe-resume handling; message metadata and quota/adaptation stores remain.

The ordinary agent inspector keeps adaptive thinking and model-level callbacks;
Qoder keeps its dedicated configuration and the new conversation starters/chat
preview. Agent/skill folder actions coexist with deferred tooltips. Inbox
WithoutTipAnchors, localized detail controls and the Feishu QR dialog remain.
No Discord card or deleted Web custom.css is restored. Auxiliary-model defaults
remain `gpt-5.6-luna`.

## Security and automatically merged behavior

- Machine/task credentials cannot mint reusable CLI/PAT credentials or manage
  the owner's PAT. The real-router credential regression now expects 403 for
  both ordinary and external task tokens, 200 for a member, and continued
  ordinary task read access. The old ordinary-task minting assertion would
  have reversed the explicitly approved upstream security fix.
- Every task-token workspace selector is checked before header normalization,
  including duplicate selectors and malformed queries. Attachment tests retain
  indistinguishable 404 responses for foreign/missing objects with a valid
  selector and an untouched warm membership cache. Conflicting selectors now
  return 403 even for a local attachment; valid local downloads still work.
  External metadata reads remain denied by the conversation policy.
- Daemon HTTP/WS, registration and claims validate the runtime owner. Legacy
  unbound remote-MCP tokens use the upstream unique in-flight task-token
  evidence path; there is no current-owner backfill or permissive fallback.
- The fork quota-push endpoint also uses `requireDaemonRuntimeAuthorized`:
  exact daemon identity, current owner and live Qoder connection authorization
  are checked before writes. Regressions reject mismatched owners, unbound
  legacy tokens and case-mismatched daemon IDs with 404; an authorized unbound
  Qoder credential works until connection revocation, then returns 403. Denied
  pushes preserve the stored snapshot and publish no telemetry event. The
  owner PAT/JWT branch is unchanged.
- Daemon feature fixtures now use the actual runtime daemon/owner binding.
  Arbitrary fixture daemon IDs must not bypass the new gate for quota, usage,
  metadata or plugin access. The task-selector mock includes the persisted
  first-party task read required by the fork authorization middleware.
- Member sharing is preserved in API schemas, queries and revoke cleanup.
  Shared use does not grant machine administration. Workspace deletion cleans
  both Labrastro data and Qoder connection/token rows; member revoke keeps
  the fork lifecycle stop and upstream sharing revocation.
- Member delegation telemetry records human actions only, stays disabled with
  DO_NOT_TRACK, and never changes execution authority. Qoder's issue-only
  capability validation does not authorize chat or local-directory work.
- Worktree repair, Kiro terminal-session handling, OpenCode clock/terminal
  fixes and Cursor network retry stay at the released upstream implementation.
  Fork quota/adaptation and explicit-skill regressions remain in the same suites.

## External-conversation route review

Compared with the fork baseline, all 23 decoded request inventories below are
unchanged. The allowlist is unchanged: 60 allowed, 427 denied user-auth routes
(the baseline has 419 denied; eight Qoder connection/configuration routes are
new and denied). No Qoder configuration, credential, sharing or workflow editing
route was admitted. The actual router and field inventory tests cover the full
registered surface.

Every row still accepts actor identity only from authenticated context and
validates object membership in the task's workspace. New explicit selector
validation applies before these handlers. Every dispatch revalidates the live
grant and persisted ancestry; a runtime owner, rule creator or stale task cannot
replace the frozen human grantor. Descendant, retry, wakeup, delayed-dispatch,
revocation, absent-evidence and invocation denial regressions remain active.

Evidence H = complete handler suite; R = complete real-router suite; C = comment
reconciliation/steering tests; W = workflow/dependency/wakeup service tests.
These are local results; expert acceptance is recorded against the final PR head.

| Method / route | Handler and dependencies | Request/default/validation comparison | Side effects and authority / evidence |
| --- | --- | --- | --- |
| `POST /api/issues/query` | `QueryIssues` / query helpers | Filter map, defaults and workspace validation unchanged | Read only; H/R |
| `POST /api/issues` | `CreateIssue` / `IssueService.Create` / dispatch | All create fields unchanged; parent, project, stage, dependency, attachment and invocation validation retained | Same issue/dependency/attachment writes; Qoder issue assignment uses the same frozen grantor/root. Human-only delegation telemetry is opt-in; H/R/W |
| `POST /api/issues/with-dependencies` | `CreateIssueWithDependencies` / atomic create | Same fields, required dependency version and override checks | Same atomic issue/edge writes and authorized dispatch; H/R/W |
| `PUT /api/issues/{id}` | `UpdateIssue` / workflow / dispatch | Same update fields and false-default handoff flags; external `stop_previous_assignee_runs` field still rejected | Same revision and DAG transaction gates; generated handoff preserves grantor/root; H/R/W |
| `PATCH /api/issues/{id}/with-dependencies` | `UpdateIssueWithDependencies` / dependency transaction | Same update/dependency fields and cancellation-field denial | Same atomic issue/edge effects and partial-rejection behavior; H/R/W |
| `POST /api/issues/{id}/comments` | `CreateComment` / mentions / supplements / reconciliation | Content, parent, type, attachment, steering and suppression fields unchanged | Kiro supplements and Qoder issue dispatch retain invocation, authorship and task ancestry gates. Coalesced human delegation may add an opt-in telemetry mark; external agents do not become human actors; H/R/C |
| `PUT /api/comments/{commentId}` | `UpdateComment` / edit reconciliation | Same revision, merge-base, content, attachment and suppression fields | External conversations still edit only their own agent's comments; grantor-admin rights cannot substitute for authorship. Reconciliation and cancellation checks unchanged; H/R/C |
| `DELETE /api/comments/{commentId}` | `DeleteComment` | Bodyless; same lookup and authorship/admin checks | Same deletion scope, activity and task invalidation; H/R |
| `DELETE /api/comments/{commentId}/keep-replies` | `DeleteComment`, keep-replies mode | Bodyless; same workspace and author checks | Same reply-preserving deletion; H/R |
| `POST /api/comments/{commentId}/resolve` | `ResolveComment` | Bodyless; same issue/workspace validation | Same thread resolution and event; H/R |
| `DELETE /api/comments/{commentId}/resolve` | `UnresolveComment` | Bodyless; same validation | Same resolution removal/event; H/R |
| `POST /api/comments/{commentId}/reactions` | `AddCommentReaction` | Same emoji field/validation | Same actor-scoped reaction and wakeup provenance; H/R |
| `DELETE /api/comments/{commentId}/reactions` | `RemoveCommentReaction` | Same emoji field/validation | Same actor-scoped removal; H/R |
| `POST /api/issues/{id}/reactions` | `AddIssueReaction` | Same emoji and membership checks | Same actor-scoped write; H/R |
| `DELETE /api/issues/{id}/reactions` | `RemoveIssueReaction` | Same emoji and membership checks | Same actor-scoped deletion; H/R |
| `POST /api/issues/{id}/labels` | `AttachLabel` | Same `label_id`, issue/label workspace checks | Same association/revision/event, no label-catalog editing; H/R |
| `DELETE /api/issues/{id}/labels/{labelId}` | `DetachLabel` | Bodyless; same scoped lookups | Same association deletion/revision/event; H/R |
| `PUT /api/issues/{id}/metadata/{key}` | `SetIssueMetadataKey` | Same JSON value, key/size/count validation | Same scoped metadata write and no-op handling; H/R |
| `DELETE /api/issues/{id}/metadata/{key}` | `DeleteIssueMetadataKey` | Bodyless; same key validation | Same deletion/no-op handling; H/R |
| `PUT /api/issues/{id}/properties/{propertyId}` | `SetIssueProperty` | Same JSON value and typed-definition validation | Same issue-scoped property mutation; no definition editing; H/R |
| `DELETE /api/issues/{id}/properties/{propertyId}` | `DeleteIssueProperty` | Bodyless; same property/workspace checks | Same scoped value deletion; H/R |
| `POST /api/upload-file` | `UploadFile` | Same multipart file and issue/comment/task/chat-session IDs and limits | Same target ownership, storage/reference writes and wakeup ancestry; all explicit workspace selectors must match the task token before upload; H/R |
| `DELETE /api/attachments/{id}` | `DeleteAttachment` | Bodyless; same uploader/grantor-admin validation | Same storage/reference deletion; H/R |

No new scheduling/configuration input was added to these routes. The new
member-delegation ledger is a telemetry side effect after an authorized human
action, not a new principal. Squad wakeup leader flags are determined from the
current issue/squad at dispatch while attribution still comes from the captured
external event. `TestExternalConversationSquadWakeupKeepsGrantorAndLeader`
exercises their combination and duplicate-tick behavior.

## Migration identities and execution order

All sixteen incoming files are byte-identical to released upstream originals:

| Full filename | SHA-256 |
| --- | --- |
| `585_issue_workflow_owner.down.sql` | `6a0b45fb6f50aa1efb031b268ac4d55a27d059764d71cc85e6f840bc5e65ef50` |
| `585_issue_workflow_owner.up.sql` | `a3d55d6d6c9e558f26cf2d712a6c27cc21925642dc05dd46362e61c00c0f7f80` |
| `586_cloud_agent_connection.down.sql` | `bc984405b3d9f33912d6c9b7c76b37bc1e0bd85384eca83cdd2c1cc18a72528b` |
| `586_cloud_agent_connection.up.sql` | `5ae9a57abd74e71ee3ebea3c0008d23117387da2e497f3794c07b641a11dc864` |
| `587_cloud_agent_connection_provider_index.down.sql` | `a90996fd42262dc2b53ce117b7f3053101c10ea1df1b17045f345f1d42bcd911` |
| `587_cloud_agent_connection_provider_index.up.sql` | `459f1e8bf49da7cdb207dd56d26a8b5d00a925b53b249a6bd2c226660929243d` |
| `588_daemon_token_owner.down.sql` | `cb3aceb3597bd9ddc4b37dd2fb84e464f05859d91e3b050889411e0c3ce6a8a3` |
| `588_daemon_token_owner.up.sql` | `882987679e07a230b3a0e01a65e74091ae38b05326a046f667a5c426e5479574` |
| `589_member_delegation_day.down.sql` | `28ba30ec1e977a8801e59f07b607539260a1159e52022764de423fc7b6ddbedc` |
| `589_member_delegation_day.up.sql` | `372fe027366def7ef5aed662318906863a875db93221aeebb9c22373f0cfd90d` |
| `590_member_delegation_day_unique_index.down.sql` | `796284c0b771d15a66a1cf9eaa85fb4dd29234438a397b06e82a3c1df149f6f3` |
| `590_member_delegation_day_unique_index.up.sql` | `bd1be60a44954ab7b9cc295b23876c74ce3ad74128b471115c0896064e7d63e6` |
| `591_member_delegation_day_primary_key.down.sql` | `abbfd61f010e5f8f48c6adb462cf0841b89c420af571491e007100d30ba9179b` |
| `591_member_delegation_day_primary_key.up.sql` | `6d1167e90cc1a18eef9e35fb6c6d27e7f33af98edba64e364ed62ccbe79d6c68` |
| `592_runtime_shared_with.down.sql` | `4a51f9b223eceb0a802301d9c1feb8c8f10256f230c3a1b096026b08f39b5c87` |
| `592_runtime_shared_with.up.sql` | `27b2cb4c263299709eacce5f79f77a609ee099b0366b2753bb489c162374b61c` |

Every SQL file present in the fork baseline, including 9001–9034, is unchanged.
The full comparison of shared migration identities leaves exactly two inherited
exceptions; their result blobs equal the fork baseline:

| Full filename | Upstream blob | Fork baseline/result blob |
| --- | --- | --- |
| `467_autopilot_trigger_creator_from_autopilot.down.sql` | `1c32fd2368ae0ae78e2bf5dc8886b780cbed69eb` | `ee35bfe58e35fccdeee0e32d4ae077fac5136c15` |
| `467_autopilot_trigger_creator_from_autopilot.up.sql` | `40a3888825985738469996a1596110ae62038ac6` | `9d9719921186f406855115c4a5a7e73b9c377896` |

As in OL-110 T14, upstream 467 infers a legacy trigger principal from its
autopilot creator. The shipped fork deliberately does no backfill; unresolved
triggers fail closed until explicitly recreated. Its down restores comments,
not principal data. Existing installations never rerun these identities. This
merge does not rewrite either file or infer new authority for historical rows.

The latest upstream definition of `capture_issue_wakeup` is still in 579,
followed by fork overrides 9009 and 9028. Incoming 585–592 do not redefine it. The migration inventory test remains
unchanged and verifies the complete definition inventory; no new fork repair
migration is needed. Concurrent index handling/cleanup for 587 and 590 remains
in the production runner, including the subsequent 591 primary-key attachment.

Disposable PostgreSQL 15.19 databases use the production Go 1.27.3 runner:

| Path | Starting ledger | Execution order | Final ledger |
| --- | --- | --- | --- |
| Fresh install | Empty | All upstream full stems in lexical order, including 585–592, then 9001–9034 | 693 |
| Existing main upgrade | 685 from the exact fork baseline, already through 9034 | 585–592 after the recorded fork migrations | 693 |
| Upgrade rollback and reapply | 685 baseline → 693 | Only incoming 592→585 down, preserving the existing ledger; then 585→592 up | 685 → 693 |

The roundtrip asserts no invalid indexes, retained conversation provenance in
`capture_issue_wakeup` and an empty-array default for runtime sharing. This is
an isolated schema exercise, not a production backup/restore plan: downgrading
removes new cloud connection/sharing/telemetry data. No live data was sampled.

## Formatting, build and verification

- The ten Go exceptions are still the exact unformatted upstream blobs at
  `dbdbb299164347586e2650bb67684a490726a798`. Only the source-commit comment
  changes; no path/hash is added or widened. Both gofmt guard scripts pass.
- sqlc v1.31.1 regenerated runtime sharing/quota, task message metadata and all
  new query code. A second generation is byte-identical.
- Locale overlays are updated per key in all five languages for new upstream
  copy. Qoder bridge errors/prompts and embedded runtime instructions use
  Labrastro; stable CLI/protocol identifiers remain unchanged. Brand guards
  are not relaxed. Frontend and backend brand checks both run.
- Validation includes root typecheck/lint, every frontend package suite,
  Mobile typecheck/lint/tests, Desktop build and Go race suites. Desktop tests
  cover workspaces-root confirmations and macOS update-floor metadata.
- Host validation uses Node 24.21.0, pnpm 10.28.2, Go 1.27.3 and Git 2.50.1.
  Container Node 22.23.4 remains the pinned shipping baseline. Host Git 2.39
  cannot run the required merge-tree worktree tests, so the validation uses a
  separate Git installation without changing project tool contracts.
- The adaptive-thinking OpenCode fixture drains stdin before emitting events
  and exiting, matching the CLI protocol. This removes its prompt-write race
  under upstream v2 terminal detection without weakening the production
  broken-pipe failure check. The complete injection-channel suite passes 40
  consecutive runs with race detection; focused quota/heartbeat regressions
  also pass against the disposable PostgreSQL database. Full handler, daemon
  and middleware packages and the OpenCode agent tests pass with race
  detection. Revision-specific logs are attached to the PR's review follow-up.
- The host kernel is 5.15. Exactly four existing Cursor process-tree tests need
  Linux 6.9 pidfd flags; they pass with race detection in a disposable Linux
  6.12.107 QEMU guest. All remaining agent tests run with race detection on the
  host. No source skip or weaker process ownership check is introduced.
- The retained E2E runner executes onboarding-smoke, dag-task-lines and
  issue-dependencies in a clean detached checkout at the delivered head. Exact
  SHA, outcomes and report artifact accompany the PR/issue handoff. The runner
  builds the production Web app and backend against a disposable local DB.
- CI/release changes retain the fork candidate pipeline and CI aggregates.
  Two sequential expert reviews and successful `CI required` on the final head
  remain merge gates. Reviewers merge; no publication or deployment is performed.
  Chromium Web tests, Desktop build/unit tests and metadata checks do not claim
  native macOS installation or mobile simulator validation.
