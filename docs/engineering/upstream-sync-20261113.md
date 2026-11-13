# Upstream v0.8.2 sync — 2026-11-13 (OL-1342 / OL-1349)

The starting release line is `0.8.1-labrastro.1`. This is the consolidated record for Stages 1–3 on
`sync/v0.8.2-ol-1342`, targeting **AstralSolipsism/multica:main**.
It supersedes the temporary Stage 1 handoff. The upgrade combines the v0.8.2
feature set, eleven subsequent upstream patches, and retained fork behavior.
Deployment and release publication are outside this change.

## Ancestry and review boundaries

| Boundary | Full SHA |
| --- | --- |
| Fork base / M1 first parent | `821d811f9a368e3709bec2ea467336d785ba57e0` |
| Upstream v0.8.2 / M1 second parent | `b7f8efcaae6c5f3273c0038252b5d10c81b41068` |
| Two-parent merge M1 | `3d213215f4e18f9dc22d2dd75ee67083bc1c44fb` |
| Stage 1 initial adaptation | `24526ccad99c9fdfde66dfd7b48afff2ec881cda` |
| Stage 1 handoff | `c689feeee22648fdb06b91b1bbdc6a37c62fc36b` |
| Stage 1 security review corrections / final | `6fc753d0cb1f5d66c61fe4706d2c6dd099978a39` |
| Stage 2 integration / implementation candidate | `ae0b267feb03d39b4ee07f6979be8739e76bd884` |

`git show --format=%P --no-patch M1` confirms the two parents above.
History has not been rebased or rewritten. The final delivery commit adds this
archive; its full SHA is recorded in the OL-1349 handoff and PR. Runtime changes,
if any are required by Stage 3 validation, are identified below separately.

### Post-tag patches

| PR | Source SHA | Branch SHA |
| --- | --- | --- |
| #10173 | `f4dc21c2babe5eea9140c8c2b19f3be4ebc04622` | `16e1337913188886400319a55c03ec1e2c35320f` |
| #10282 | `e692d03e234ffa3c1f63e6eef1b368532f1cdab3` | `fb86d8b17a45a096b78ad9b4c4fb2f1e5ac6c5cb` |
| #10274 | `e17f76553eed99fc0f8446119523de679ecb4b84` | `086f77a6d4b0083a2a0e7889d0c65aad0362c137` |
| #10297 | `31f27f16a4235636bf8283dc2e3717343fb304f7` | `1a4e5feb5ecdda48c872d41c92ade9ed7a29f818` |
| #10298 | `d31322dd87daddfb226fe41c2ba6550880fa2969` | `2c88f8a686878110f312af06a8bf6f5f707693b3` |
| #10312 | `61f84be54164eddcca013fac1bc87e63c0c8ea57` | `8006c6c7a6619e75229ba7b89cfcd19f5d28df91` |
| #10317 | `018107609d5f00a3be6b86d38e3babe2e0e164a1` | `f549f6059196f8ce7d9661dad5c96982bf11a60c` |
| #10320 | `6ccbdd178ac7dcaf970acfc9a3836be2ca864c49` | `490e1c917cc2c69c90cebcd3f0485e55a7c89aed` |
| #10327 | `984c2145a0ed41c06cfe35d1885411d27370660d` | `83f51a84b0ded8b4d75db9b16ebf2d915b20550b` |
| #10329 | `c3a9d8fd1e460f9cf79be7160f19cd1a12624332` | `9cb66530694eccd78959100c838c0e034277145e` |
| #10333 | `9abc71ae9aa72c8e5acee84462677506568d1082` | `6c3adf03eeb0083ef895d3555da9431c2a8190e2` |

#10274 is an intentional empty cherry-pick: the fork already contained the
patch. `antigravityStepTerminal`, `SkillInvocation`, and both legacy resumed EOF
exit 0/1 recovery cases remain; the fallback has no
`opts.ResumeSessionID == ""` restriction. #10173 and #10298 were taken together:
the temporary `/deliverables` endpoint is removed and inventory uses attachments.
`e2e/fixtures.ts` retains `deleteIssueView` and adds the optional comment parent;
realtime synchronization retains fork plugs and the upstream task refresh.

Stage 1 was reviewed by Gemini and Claude. Stage 2 was reviewed by Codex and
Claude. Those intermediate reviews do not replace the final high-risk PR's two
sequential approvals from different model families on the final head.

## Migration identity and execution order

All forty incoming SQL files (twenty up/down pairs) match v0.8.2 exactly.
All 1,320 upstream migration files remain present; only the retained 467 pair
differs in content.
The source column is `git rev-parse <v0.8.2>:server/migrations/<filename>`;
the fork column is `git hash-object --no-filters` on the candidate file.

| Full filename | Upstream blob | Fork blob |
| --- | --- | --- |
| `617_connected_apps.down.sql` | `c624d41f86f41db8b46685286c560a92bfb44df3` | `c624d41f86f41db8b46685286c560a92bfb44df3` |
| `617_connected_apps.up.sql` | `f7a7473e34249ccdbd6dbc01ca9ffe4647201e70` | `f7a7473e34249ccdbd6dbc01ca9ffe4647201e70` |
| `618_workspace_composio_connection_account_idx.down.sql` | `bf01da295e22defdd76733e83a32d351cb60061f` | `bf01da295e22defdd76733e83a32d351cb60061f` |
| `618_workspace_composio_connection_account_idx.up.sql` | `419d5a356513266ddbf3b0fea9cc9a0792c2ab60` | `419d5a356513266ddbf3b0fea9cc9a0792c2ab60` |
| `619_workspace_composio_connection_status_idx.down.sql` | `2e4f097cbf340510876683685d82b702a040cc55` | `2e4f097cbf340510876683685d82b702a040cc55` |
| `619_workspace_composio_connection_status_idx.up.sql` | `eacfe88ff6c4add4c01de8c49c7068d4fb93ebd6` | `eacfe88ff6c4add4c01de8c49c7068d4fb93ebd6` |
| `620_agent_app_agent_toolkit_idx.down.sql` | `9736874013d351afd13105b1a92cd4dea2347edd` | `9736874013d351afd13105b1a92cd4dea2347edd` |
| `620_agent_app_agent_toolkit_idx.up.sql` | `ed21259f6189bc20f2c50a39c7d25fa6f30a5491` | `ed21259f6189bc20f2c50a39c7d25fa6f30a5491` |
| `621_agent_app_workspace_toolkit_idx.down.sql` | `575b5105c58c5448cab2768865ac62c25957fa00` | `575b5105c58c5448cab2768865ac62c25957fa00` |
| `621_agent_app_workspace_toolkit_idx.up.sql` | `d0a38bf07634a1c679115d219ad4c4f5836f842f` | `d0a38bf07634a1c679115d219ad4c4f5836f842f` |
| `622_app_action_rule_scope_idx.down.sql` | `1d38aecff652cc9d471be5089e273062c90aece8` | `1d38aecff652cc9d471be5089e273062c90aece8` |
| `622_app_action_rule_scope_idx.up.sql` | `fa8f4982184db6e4adba7629eb7d68ea720c7b90` | `fa8f4982184db6e4adba7629eb7d68ea720c7b90` |
| `623_app_action_request_issue_idx.down.sql` | `389196c6c0d95e908f6582dabee5d01c0bf3eed0` | `389196c6c0d95e908f6582dabee5d01c0bf3eed0` |
| `623_app_action_request_issue_idx.up.sql` | `f2c771fa6bc4584349c0891bf30215dd3abfcd25` | `f2c771fa6bc4584349c0891bf30215dd3abfcd25` |
| `624_app_action_request_pending_idx.down.sql` | `5a1bf61fd49675f09381b21d76761c9cd7158bf5` | `5a1bf61fd49675f09381b21d76761c9cd7158bf5` |
| `624_app_action_request_pending_idx.up.sql` | `8b81200393c8b477c898a6ee2be749bb0b22476b` | `8b81200393c8b477c898a6ee2be749bb0b22476b` |
| `625_app_tool_call_workspace_idx.down.sql` | `d5690bef0979ca8a989983082733d0bc3e506044` | `d5690bef0979ca8a989983082733d0bc3e506044` |
| `625_app_tool_call_workspace_idx.up.sql` | `05290754a602a4e4d13b77d779e9f53c0f40e7dc` | `05290754a602a4e4d13b77d779e9f53c0f40e7dc` |
| `626_app_action_request_task_idx.down.sql` | `315866b6ff4f1ee794367fc78f765446398690b7` | `315866b6ff4f1ee794367fc78f765446398690b7` |
| `626_app_action_request_task_idx.up.sql` | `61c3ac16e821f72d54da2602a73a282a9a751f16` | `61c3ac16e821f72d54da2602a73a282a9a751f16` |
| `627_app_tool_call_issue_idx.down.sql` | `c708794fd74c099506ac7957c28779677ec68743` | `c708794fd74c099506ac7957c28779677ec68743` |
| `627_app_tool_call_issue_idx.up.sql` | `8db02a87163a8197c2298ca787d9dc1b14f861b9` | `8db02a87163a8197c2298ca787d9dc1b14f861b9` |
| `628_app_action_request_chat_idx.down.sql` | `8304a9784dbc3167183b7e37ee0eed64917e0413` | `8304a9784dbc3167183b7e37ee0eed64917e0413` |
| `628_app_action_request_chat_idx.up.sql` | `ae4e200cabb2feecf9b73fba1470998040b550d5` | `ae4e200cabb2feecf9b73fba1470998040b550d5` |
| `629_user_star_prompt.down.sql` | `c7ad74fcb58dc81a7f691950eadbf3bffa78a43d` | `c7ad74fcb58dc81a7f691950eadbf3bffa78a43d` |
| `629_user_star_prompt.up.sql` | `dbc639adea90c299b02932005e67f6f0ab22afb3` | `dbc639adea90c299b02932005e67f6f0ab22afb3` |
| `630_project_visibility.down.sql` | `92c0004580301ab79488126fc08716211243ba0f` | `92c0004580301ab79488126fc08716211243ba0f` |
| `630_project_visibility.up.sql` | `a552ad343ceab5f35ee43d7da2056c6ae0d05667` | `a552ad343ceab5f35ee43d7da2056c6ae0d05667` |
| `631_project_member.down.sql` | `952693f1f7755f52f4ad8eabced377e9fc35fb18` | `952693f1f7755f52f4ad8eabced377e9fc35fb18` |
| `631_project_member.up.sql` | `3c7cb99955ce12de3d6a7ae67f9a58104022e095` | `3c7cb99955ce12de3d6a7ae67f9a58104022e095` |
| `632_project_member_user_idx.down.sql` | `af3b47b972f29f5ac4db4b347abaa484ab7428bc` | `af3b47b972f29f5ac4db4b347abaa484ab7428bc` |
| `632_project_member_user_idx.up.sql` | `125c6cb5cd8eb6e92f3d67bf35fc9012337a44cc` | `125c6cb5cd8eb6e92f3d67bf35fc9012337a44cc` |
| `633_issue_environment.down.sql` | `a63358790b30835b0ddc62ec05730b0f814fc25c` | `a63358790b30835b0ddc62ec05730b0f814fc25c` |
| `633_issue_environment.up.sql` | `9a50c4e1cd0273736d515e4e787364859b42b535` | `9a50c4e1cd0273736d515e4e787364859b42b535` |
| `634_issue_environment_task_key_idx.down.sql` | `f1faee3264fc39cc6c253f24915750cc4cebcd54` | `f1faee3264fc39cc6c253f24915750cc4cebcd54` |
| `634_issue_environment_task_key_idx.up.sql` | `49244247c002f639711ee9fbbc373444399b1214` | `49244247c002f639711ee9fbbc373444399b1214` |
| `635_issue_environment_issue_idx.down.sql` | `0bd8f1852ee68ce3c22a50f2d3e4537135abce80` | `0bd8f1852ee68ce3c22a50f2d3e4537135abce80` |
| `635_issue_environment_issue_idx.up.sql` | `bb7b71112fac0d2dee9dcb8900972bbbf35fa6f1` | `bb7b71112fac0d2dee9dcb8900972bbbf35fa6f1` |
| `636_site_counter.down.sql` | `bc8e995bf416a5cb2f60ef1240b7e617f2f8f5ce` | `bc8e995bf416a5cb2f60ef1240b7e617f2f8f5ce` |
| `636_site_counter.up.sql` | `ca3657d2c59aed5664365d06798fea56233d48b4` | `ca3657d2c59aed5664365d06798fea56233d48b4` |

### Historical overrides retained

Comparing common upstream migration paths finds only the existing 467 pair
modified. Neither direction changed from the fork base. This preserves OL-49
and the OL-110 T14 reconciliation recorded in earlier syncs: migration 449's
publisher backfill remains, but 467 never infers execution authority from the
autopilot creator. Unresolved triggers remain denied until explicitly recreated
by an authorized member. Both directions alter comments only. Existing installed
ledgers do not rerun 467; fresh installs and upgrades retain the same policy.

| Full filename | Upstream blob | Fork base = candidate blob |
| --- | --- | --- |
| `467_autopilot_trigger_creator_from_autopilot.up.sql` | `40a3888825985738469996a1596110ae62038ac6` | `9d9719921186f406855115c4a5a7e73b9c377896` |
| `467_autopilot_trigger_creator_from_autopilot.down.sql` | `1c32fd2368ae0ae78e2bf5dc8886b780cbed69eb` | `ee35bfe58e35fccdeee0e32d4ae077fac5136c15` |

The `capture_issue_wakeup` inventory is unchanged: upstream
`518_wakeup_event_capture.up.sql`, `520_collaboration_wakeup_events.up.sql`,
`523_wakeup_registration_source.up.sql`, `530_wakeup_bounded_capture.up.sql`,
`532_wakeup_actor_capture.up.sql`, `579_wakeup_skip_handed_to_agent.up.sql`;
fork `9009_labrastro_wakeup_conversation_provenance.up.sql`,
`9028_labrastro_wakeup_skip_handed_to_agent.up.sql`, and
`9066_labrastro_retire_conversation_provenance.up.sql`.
The final function in 9066 equals 579 byte for byte.
`TestLabrastroWakeupCaptureMigrationInventory` and
`TestLabrastroWakeupCaptureMatchesUpstream` pass. The DB-backed
`TestLabrastroWakeupCaptureMigrationOrders/fresh` and `/upgrade` also pass.
No new override is needed.

### Fresh install, installed upgrade, rollback

Stage 3 used a new UTF-8 PostgreSQL **17.11** cluster with pgvector **0.8.7**,
bound only to `127.0.0.1:15432`, with task-owned data/socket directories.
No shared or production database was accessed. This host cannot create container
namespaces (`podman info`: `cannot clone: Operation not permitted`; Docker has
no running daemon). These results are from an independent native PG17 service,
not a container. The container-specific acceptance difference remains explicit.

- **Fresh:** current production migration runner, empty `sync_fresh`, all
  001–636 and 9001–9075 files plus released historical compatibility stems.
- **Upgrade:** fork-base runner and migration directory at `821d811f9`, empty
  `sync_upgrade`, 001–616 and 9001–9075 plus historical stems; then current runner
  and directory apply only the twenty new 617–636 entries. Old entries stay applied.
- Each final ledger contains **773 entries**; the base contains **753**. The
  extra entries are preserved historical full-stem migrations, not new versions.
- PostgreSQL 17 `pg_dump --schema-only --no-owner --no-privileges` output matches
  exactly after removing only the randomized `\restrict` / `\unrestrict` lines.
  No column, constraint, function, index, extension or comment is normalized away.
- Both paths have **zero** `pg_index.indisvalid = false` rows.
- A clone of the upgraded database applies all twenty new down files in reverse
  order through the production runner, then all twenty up files. The same schema
  hash and zero invalid indexes result. The rollback directory contains only the
  new file pairs so released 9xxx migrations are not inadvertently rolled back.

Normalized schema SHA-256 (all three paths):
`2d62bb796774287d606d8ae3c1e464eb0a47bd304dddf2464eb3769cbca8e233`.
Evidence includes raw/normalized dumps, execution logs, `schema-audit.json`, and
the reproduction script. An early overlapping audit invocation was rejected by
the migration advisory lock; the final comparison and rollback were rerun
sequentially to completion. No migration or application change was made for it.

## Go formatting exceptions

All twelve manifest entries are byte-identical to their reviewed upstream source
and still need gofmt there. `daemon_auth_test.go` uses #10333; the others use
v0.8.2. Compared with the fork base, the new upstream `issue_environment.go`
exception is added and the daemon-auth identity is updated. No fork edit is
exempted and no guard was weakened. The script regression and formatting gate pass.

| Path | Source commit | Blob |
| --- | --- | --- |
| `server/internal/auth/cloud_pat_test.go` | `b7f8efcaae6c5f3273c0038252b5d10c81b41068` | `f90234704257dffc4ed7345d9f9f4273d5215fdb` |
| `server/internal/auth/membership_cache_test.go` | `b7f8efcaae6c5f3273c0038252b5d10c81b41068` | `ad7d259dec1d351b8482db2a81ef9e1a942c9fde` |
| `server/internal/handler/comment_agent_steer_test.go` | `b7f8efcaae6c5f3273c0038252b5d10c81b41068` | `d18353b021e0a9f24d906c9d2776802adca1b322` |
| `server/internal/handler/issue_environment.go` | `b7f8efcaae6c5f3273c0038252b5d10c81b41068` | `e463e663177b76ec735148b5e2ce8a9bf5aee64c` |
| `server/internal/integrations/lark/markdown_detect.go` | `b7f8efcaae6c5f3273c0038252b5d10c81b41068` | `fa16c63ab8b87beda8104898b29b06a96e7d340d` |
| `server/internal/integrations/lark/registration_test.go` | `b7f8efcaae6c5f3273c0038252b5d10c81b41068` | `1b6a3136b98605d1148422be5a518f3b6479edc7` |
| `server/internal/integrations/lark/ws_chunk_assembler.go` | `b7f8efcaae6c5f3273c0038252b5d10c81b41068` | `f028826a565d6312232ac4642b865731c40db2bd` |
| `server/internal/integrations/lark/ws_chunk_assembler_test.go` | `b7f8efcaae6c5f3273c0038252b5d10c81b41068` | `ac5ab5e9f87d68db7dbf13445285e2cf9bb03d90` |
| `server/internal/integrations/lark/ws_frame_test.go` | `b7f8efcaae6c5f3273c0038252b5d10c81b41068` | `31e8b12d48ef29d696024552dede3a9c3931fd65` |
| `server/internal/integrations/telegram/outbound.go` | `b7f8efcaae6c5f3273c0038252b5d10c81b41068` | `00ec25c99287b284ca0b85f14015884c486f9f5b` |
| `server/internal/middleware/daemon_auth_test.go` | `9abc71ae9aa72c8e5acee84462677506568d1082` | `f2574a29d596239b2131b16d0f9c61b4ca49a1bd` |
| `server/pkg/featureflag/eval_context_test.go` | `b7f8efcaae6c5f3273c0038252b5d10c81b41068` | `620746cb12de71098d96282a23dc0c6331677b8f` |

## Engineering insertion ledger

Measured using `git diff -U0 12f8f3f31111564e5e1b9aac3f7f916e8bba4039 HEAD -- <file>`.
Only added lines bearing engineering/baseline identifiers count, excluding the
unrelated YSK documentation reference and `tabStorage?.setBaseline`. Each call
plug and its fork-owned symbol remain present. Raw diffs and matched lines are
included in the evidence. Server: **7 files / 11 lines**; frontend: **15 / 43**;
total **22 / 54**, with no widened insertion or budget change.

| File | Actual | Budget |
| --- | ---: | ---: |
| `packages/views/projects/components/project-detail.tsx` | 2 | 2 |
| `packages/views/layout/panels/work-tree.tsx` | 2 | 2 |
| `packages/core/realtime/use-realtime-sync.ts` | 4 | 4 |
| `packages/core/types/events.ts` | 8 | 8 |
| `packages/core/projects/queries.ts` | 4 | 4 |
| `packages/core/projects/mutations.ts` | 2 | 2 |
| `packages/core/api/index.ts` | 1 | 1 |
| `apps/desktop/src/renderer/src/App.tsx` | 5 | 5 |
| `apps/desktop/src/renderer/src/stores/tab-store.ts` | 4 | 4 |
| `apps/desktop/src/renderer/src/routes.tsx` | 4 | 4 |
| `packages/core/paths/paths.ts` | 2 | 2 |
| `packages/views/projects/components/index.ts` | 1 | 1 |
| `packages/views/i18n/resources-types.ts` | 2 | 2 |
| `packages/core/diagnostics/diagnostic-context.ts` | 1 | 1 |
| `server/cmd/server/router.go` | 1 | 1 |
| `server/cmd/multica/main.go` | 1 | 1 |
| `server/cmd/multica/cmd_project.go` | 2 | 2 |
| `server/internal/handler/project_resource.go` | 1 | 1 |
| `server/internal/handler/project.go` | 2 | 2 |
| `server/internal/service/issue.go` | 3 | 3 |
| `server/internal/handler/workspace.go` | 1 | 1 |
| `packages/core/package.json` | 1 | 1 |

The wiki-root query key stays outside the broad project invalidation prefix;
`packages/core/projects/queries.test.ts` retains the key-shape guard. The
OL-1298 decision to keep engineering in fork core remains unchanged; the four
plugin-service prerequisites in the checklist are not met by this sync.

## Conflict decisions and retained functionality

With the `labrastro-brand` merge driver retaining nineteen brand assets,
re-running `git merge-tree --write-tree` against the two recorded parents yields
**88 initial conflict paths**: 29 server/root/tooling and 59 frontend/desktop/docs.
The later #10173 conflict in `issue-detail.tsx` is additional, not an 89th initial
path. Stage 2 reconciles all sixty frontend targets: fifty-five changed, five
confirmed as-is (desktop test setup; Web custom.css, globals.css and text-contrast
test; deleted features-section.tsx). This distinction supersedes early 58/30 and
297-file estimates.

### Server and retained behavior

- Dependency reads and write-response projections resolve hidden projects;
  cycle witnesses crossing hidden issues omit their paths. DAG matching,
  context expansion, parent references and edge projections use the same policy.
- The issue loader preserves its caller's not-found response for hidden projects,
  including graph focus and dependency endpoints.
- Engineering, baseline wiki and passage-comment realtime events reach project
  members and workspace managers only. Their HTTP routes use the existing
  project-resource visibility gate. Tip-chat creation/reopening checks the
  locked source issue's project before creating a chat.
- The fork's grouped inbox query includes upstream filter projections and
  hidden-project filtering; deterministic `created_at, id` ordering remains.
- StarPrompt is fixed off at the server: claims are rejected, click requests
  do not mutate bookkeeping, and user responses exhaust the display allowance
  for installed clients. Migration 629 and storage fields remain unchanged.
- Local `/uploads/*` serving stays removed. Media's legacy upload fixture now
  asserts an authenticated attachment download URL in its delivered Markdown.
- CLI dependency envelopes, scope/offset/include-closed and PR auto-completion
  coexist. Comment attachments upload unbound and are bound by comment creation.
- Qoder's bridge is byte-identical to the fork parent, already including the
  single-repository token, credential preflight fallback and per-resource refresh.
  Host metrics, quota probes, OMP and Codex probe throttling remain present.
- CI retains its Ubuntu 24.04 pins, `CI required`, retained E2E and formatting/
  branding gates while adding the upstream catalog and tooling checks.

The fork entry points below now reuse `projectaccess` at discovery, mutation
and delivery time, including jobs queued before access was revoked.

| Review item | Correction and core regression |
| --- | --- |
| Media inputs (#1) | Creation returns the same 404 for hidden and missing issue/comment attachments. Claim and transfer recheck the caller and runtime owner, plus the original task's human/agent owner for task-token jobs; membership removal or moving the input issue into a private project prevents token issuance/download. Runtime sharing does not grant project access. |
| YSK and side chats (#2) | Nested `tip.issue_id` events use the private-project audience; active lists filter hidden projects and state writes reject hidden tips before remembering topics. Opening, listing, reading and claiming side chats recheck creator/agent-owner access to both the saved chat project and the live source issue project. Revoked chats expose neither previews nor hidden model context/resume pointers. |
| Message delivery (#3) | Workspace-wide activity/comment routes exclude private projects; explicitly scoped routes remain eligible. Inbox candidates, decisions and retries recheck recipient access. Autopilot route saves, decisions and sends check the authorizer and personal recipient. Queued sends check their frozen recipient even after the route changes. Tests use a fake sender and assert no additional external call after revocation. |
| Workspace issue usage (#4) | SQL filters hidden projects before returning per-issue usage. Tests retain public/projectless usage for ordinary members and private usage for project members/managers. |
| Dependency replacement (#5) | Full-list replacements preserve existing hidden prerequisite edges and their canonical IDs; an explicit hidden reference still returns 404. An authorized member can remove the edge. The HTTP regression checks `has_restricted_blockers` and response redaction after visible edits. |


### Stage 2 integration

The frontend, desktop, core types/queries, UI primitives, package manifests,
lockfile and seven documentation files use the three-way result rather than
whole-file restoration. `issue-detail.tsx` restores `submitHtmlComment`,
`fillHtmlCommentDraft`, comment navigation and fork landing while retaining
bounded history and the attachment inventory. The integration also corrects
comment double landing/token replay, resolved-root expansion, cross-issue desktop
mementos and side-chat retry session retention.

Russian is wired into all **37 namespaces**, including the seven fork-owned
namespaces `dependencies`, `dag`, `lark`, `quota`, `agent-config`, `fork-ui`,
`engineering`. The eighth brand overlay and explicit new-key overrides in all
eight languages keep Labrastro/Mizuki branding and Russian plural parity.
Catalog dependencies and frozen installation pass without relaxing brand guards.

| Intersection | Final decision and regression evidence |
| --- | --- |
| Private projects × fork modules | Dependencies redact hidden objects and preserve hidden prerequisite edges on visible replacement; DAG scope/focus/cycle paths, engineering HTTP/WS, YSK/side-chat lifecycle, media input/claim/download, message decisions/retries and per-issue usage all apply project visibility. Stage 1 review-correction tests cover membership revocation and moving a source into a private project, including dual task-token principals and frozen delivery recipients. |
| GitHub Star | Keep migration 629 schema. Server `starPromptEnabled = false` denies claims and avoids writes, including installed clients. Neither Web nor Desktop mounts `StarPrompt`; Help retains the internal download/What's New/Feishu experience. |
| Local uploads | No `/uploads/*` server route or Web proxy rewrite. Attachments, previews, media, wiki and rich content use authenticated downloads or signed URLs. Legacy URL parsing remains available for old Markdown. |
| Russian × marketing | All 37 ru namespaces and eight brand overlays pass parity/branding tests. The fork-owned policy gates `/blog`, `/careers`, `/customers`, `/press`, `/pricing`, `/product`, `/security`, `/solutions` and language landing paths, keeping `/`, `/download`, `/privacy`, `/licensing` and language-named workspace compatibility. Upstream marketing implementations stay behind gates. |

Onboarding still skips role/source/use-case questionnaires and cloud promotion;
Feishu community and internal downloads remain. Web declaration/declarationMap
remain false per the retained Fumadocs type-identity constraint. Licenses,
attribution and technical/protocol names retain their identities. The retired
external-session route inventory script is not run (OL-1274).

### Initial conflict paths (all 88)

```text
.github/actions/frontend-quality/action.yml
.github/workflows/ci.yml
apps/desktop/package.json
apps/desktop/scripts/package.mjs
apps/desktop/src/main/runtime-config-loader.test.ts
apps/desktop/src/preload/index.d.ts
apps/desktop/src/renderer/src/components/desktop-layout.test.tsx
apps/desktop/src/renderer/src/components/desktop-layout.workspace-gate.test.tsx
apps/desktop/src/renderer/src/components/issue-window.tsx
apps/desktop/src/renderer/src/platform/workspace-window-bridge.tsx
apps/desktop/test/setup.ts
apps/docs/content/docs/cli.fr.mdx
apps/docs/content/docs/cli.ja.mdx
apps/docs/content/docs/cli.ko.mdx
apps/docs/content/docs/cli.mdx
apps/docs/content/docs/cli.zh-Hant.mdx
apps/docs/content/docs/cli.zh.mdx
apps/docs/content/docs/developers/contributing.zh-Hant.mdx
apps/web/app/(landing)/download/download-client.tsx
apps/web/app/(landing)/download/page.tsx
apps/web/app/(landing)/layout.tsx
apps/web/app/(landing)/page.tsx
apps/web/app/custom.css
apps/web/app/globals.css
apps/web/app/sitemap.ts
apps/web/app/text-contrast.test.ts
apps/web/features/landing/components/features-section.tsx
apps/web/next.config.test.ts
packages/core/inbox/queries.ts
packages/core/issues/mutations.test.tsx
packages/core/issues/mutations.ts
packages/core/issues/queries.ts
packages/core/package.json
packages/core/projects/queries.ts
packages/core/realtime/use-realtime-sync-ws-instance.test.tsx
packages/core/types/events.ts
packages/ui/components/common/multica-graphics.tsx
packages/ui/components/common/submit-button.tsx
packages/ui/components/ui/dropdown-menu.tsx
packages/ui/package.json
packages/views/agents/create/builder-conversation.tsx
packages/views/autopilots/components/autopilot-detail-page.tsx
packages/views/chat/chat-page.tsx
packages/views/chat/components/chat-window.tsx
packages/views/issues/components/comment-composers.test.tsx
packages/views/issues/components/comment-input.tsx
packages/views/issues/components/issue-detail-route.test.tsx
packages/views/issues/components/issue-detail.test.tsx
packages/views/issues/components/reply-input.tsx
packages/views/layout/dashboard-layout.tsx
packages/views/layout/help-launcher.test.tsx
packages/views/layout/help-launcher.tsx
packages/views/layout/panels/sidebar-tree.tsx
packages/views/layout/panels/team-panel.tsx
packages/views/layout/panels/views-section.tsx
packages/views/layout/panels/work-panel.tsx
packages/views/layout/panels/work-tree.tsx
packages/views/package.json
packages/views/rich-content/rich-content.tsx
packages/views/skills/components/create-skill-dialog.test.tsx
packages/views/skills/components/create-skill-dialog.tsx
pnpm-lock.yaml
pnpm-workspace.yaml
scripts/brand/generate.mjs
scripts/brand/sync.mjs
scripts/dev-env.sh
scripts/dev-env.test.sh
server/cmd/multica/cmd_agent.go
server/cmd/multica/cmd_auth_test.go
server/cmd/multica/cmd_issue.go
server/cmd/multica/cmd_issue_test.go
server/cmd/server/router.go
server/internal/daemon/daemon.go
server/internal/daemon/health.go
server/internal/handler/agent.go
server/internal/handler/file_test.go
server/internal/handler/inbox.go
server/internal/handler/issue.go
server/internal/handler/project.go
server/internal/handler/search_candidate_parity_test.go
server/internal/handler/search_open_comments_test.go
server/internal/handler/search_test.go
server/internal/handler/workspace_delete_manifest_test.go
server/internal/qoderruntime/bridge.go
server/internal/service/builtin_skills/multica-platform/references/issues.md
server/pkg/db/generated/inbox.sql.go
server/pkg/db/generated/models.go
server/pkg/db/queries/inbox.sql
```

The additional patch conflict/fusion target is
`packages/views/issues/components/issue-detail.tsx`.

## Stage 3 validation results

Environment: Go **1.27.3**, Git **2.47.3** (with HTTPS transport), Node
**24.21.0**, pnpm **10.28.2**, PostgreSQL **17.11 / UTF8**, Chromium via Playwright
**1.58.2**, host kernel **5.15.0-157-generic**. Database-backed Go tests received
an explicit task-local `DATABASE_URL`; the repository's agent-CLI guard remained
enabled. No real-agent integration smoke ran.

| Gate | Result |
| --- | --- |
| `GOFLAGS=-p=1 bash scripts/test-go.sh --race` and supplemental groups | All **109 packages accounted for**. **108 pass or have no test files** after the environment/time-budget reruns below. `pkg/agent` retains only the four accepted Cursor kernel failures. The full command is **not all green on this host**. |
| Branding + migrations `go test ... -count=1` with PG17 | PASS, including both required wakeup tests and fresh/upgrade function-order integration cases; no DB test substitution by missing `DATABASE_URL`. |
| `go vet ./...` | PASS |
| `check-gofmt.test.sh`, `check-gofmt.sh` | PASS, including recheck with the Go 1.27.3 formatter |
| Dependency catalog / frozen `pnpm install` / brand sync | PASS |
| `pnpm typecheck` | PASS, 9/9 non-Mobile tasks |
| `pnpm lint` | PASS, zero errors; existing warnings remain |
| `pnpm test:brand` | PASS, including all eight effective locale overlays |
| Root `pnpm test` | Initial run failed on a Desktop 5-second timeout and cancelled the remaining Views task. All package coverage was then collected as below; the failed attempt remains in the evidence. |
| Views CI shards | **364 files / 5,098 tests** in shard 1; **364 / 4,810** in the final shard 2 rerun. **9,908 tests pass**. |
| Desktop | **88 files / 1,036 tests pass** in a standalone full run |
| Other root suites | Core **3,971 pass / 1 pre-existing skip**; UI **467 pass / 1 pre-existing skip**; Web **490 pass**; Docs **30 pass**; YSK **20 pass** |
| Mobile typecheck / lint / test | PASS, **44 files / 342 tests**, plus `ios-run.test.sh` assertions |
| Retained runner regression / CI-scope Node tests | PASS |
| `bash scripts/test-retained-e2e.sh` | Production Go/Web build, all migrations and all four retained suites: **24/24 pass, zero failures/skips/retries** |
| Supplemental production-browser smoke | **8/8 pass**: `/pricing`, `/blog`, `/zh` noindex 404; `/download` HTTP 200; main/Help without GitHub Star links; all five themes; private-project access dialog; removed `/uploads/*` route |
| `git diff --check` | PASS |

The runtime implementation tested above is `ae0b267feb03d39b4ee07f6979be8739e76bd884`.
The final archive commit changes documentation only. The final-head retained-E2E
run, exact delivery SHA, PR URL and full report artifact are recorded together in
the OL-1349 handoff. Local raw source-tree evidence is pinned by SHA-256
`48f62dc9161cf22a55f6125e84a22e751808ddf8c7350121b1398560223aef89` (the
`git ls-tree -r` listing for apps, packages, server, scripts, .github, dependency
manifests and the retained Playwright config). No test assertion or timeout was
changed to obtain these results.

### Failed attempts and resolved environment issues

- The first tool-local Git build lacked `git-remote-https`; two repocache CA
  tests therefore failed before reaching certificate validation. Rebuilding Git
  2.47.3 with its HTTPS transport and rerunning the complete repocache and
  execenv packages under race passes (18.750s and 26.786s respectively).
- Execenv's upstream OpenClaw shared-budget test took 616ms against its 600ms
  assertion during the first loaded run. The unchanged complete package passes
  at `-parallel 2`, including its original time assertion.
- Two mock-Claude launch tests reached their existing deadlines in the full
  agent run. The complete `^TestClaude` group passes at `-parallel 1` (11.003s).
- Desktop's wrapper-chain test initially exceeded 5 seconds; the complete
  standalone Desktop suite at two workers passes all 1,036 tests.
- The first Views shard 2 run passed 4,809 tests and timed out once in the
  unchanged upstream date-picker test. A complete shard 2 rerun at three workers
  passes all 4,810. Shard 1 used two workers. These are runner concurrency
  settings only; no timeout, assertion, skip or source edit was made.
- The supplemental screenshot harness initially searched for a Labrastro
  heading on `/download`; the actual retained heading is `Download`. The
  harness was corrected to assert that heading and the internal-channel copy;
  product code and the retained E2E suite were unchanged.

### Accepted kernel limitation

The remaining failures are exactly:

- `TestCaptureCursorBackgroundLateDescendant`
- `TestCaptureCursorBackgroundProcessReapsLeaderExitedGroup`
- `TestCaptureCursorBackgroundSurvivesRootExitDuringCapture`
- `TestCursorBackgroundLifecycle` (`budget`, `multiple`, `finish`, `cancel`)

The Linux 5.15 host returns `EINVAL` for the Linux 6.9+
`PIDFD_SIGNAL_PROCESS_GROUP` behavior. The following blobs are identical in
the fork base, v0.8.2 and final runtime candidate; no fallback or skip was added.

| File | Same blob in all three trees |
| --- | --- |
| `server/pkg/agent/cursor_background_process_linux.go` | `ee65aa58c4ad4cc31ed3d5d5f42fb563240fa374` |
| `server/pkg/agent/cursor_background_process_unix_test.go` | `226ee7bd98d04bdd3f95f8b80c92c24e1e6de96a` |
| `server/pkg/agent/cursor_background_late_child_test.go` | `586eaff266a304b56062f0c36fb1bc377dc5c288` |
| `server/pkg/agent/cursor_liveness_test.go` | `1ebc0e6690853bea90a3ac9931b8d0af857d9a34` |

The author does not claim a completely green Go run on Linux 5.15. Final
review/CI on a supported kernel must retain these tests. The task explicitly
permits reporting this host limitation after byte-identity verification.

### Environment acceptance and artifacts

The literal container requirement is **not satisfied** on this host: the PG17
service is isolated by a new cluster and task-owned paths, but is native.
Acceptance of that substitution, or rerunning against a disposable PG17
container, is required before treating Stage 3 as fully accepted. This is
separate from the explicitly allowed Cursor kernel exception.

The issue evidence archive includes all initial/final test logs, 40 migration
blob identities, twelve formatting identities, insertion diffs and matched
lines, all 88 conflicts, schema dumps, migration logs, package coverage JSON,
Playwright HTML reports, audit/smoke scripts and screenshots. E2E used no root
or Web dotenv overrides, no existing account, no production database and no
daemon/real agent. Playwright owned and stopped both application processes.
Native Desktop/Mobile packaging and device rendering were not exercised.
The internal download page rendered normally; fetching/installing a release
artifact or verifying live release-feed availability was outside this test.


### Prior-phase evidence retained

The Stage 1 handoff covered all 109 Go packages across its regular, agent and
message-delivery runs. Its initial SQL_ASCII fixture caused three Chinese-text
groups (`TestLabrastroTipChatMaterialIsBoundedAndScoped`,
`TestLabrastroYSKSingleAndBatchClaims`,
`TestLabrastroYSKReportsValidateDeduplicateAndOverturn`) to fail; all passed on
the replacement UTF-8 PG17 database without a source change. Git 2.39.5 could
not exercise the upstream `merge-tree --merge-base` cases; Git 2.47.3 passed
the complete execenv race package. Its four Cursor groups hit the same Linux
5.15 pidfd restriction described below; the Stage 1 reviewer separately
reported the complete agent package passing on Linux 6.17.

Stage 1's security correction rerun used PG17 with `-race -count=1`:
handler 321.073s, cmd/server 31.836s, messagedelivery 173.234s, service 77.492s,
projectaccess 1.033s, issuedependency 9.976s. It additionally passed `go vet`,
two repeated `make sqlc` generations without differences, formatting and brand
checks, dev-environment/retained-runner shell regressions, and CI-scope,
image-budget, PR-screenshot and brand-sync Node tests. The YSK query-cost guard
retained its custom/generic-plan bound for 10,000 and 100,000 historical tips.

Stage 2 reported frozen dependency installation, 9/9 typecheck tasks, lint,
brand tests, Web production build, Views two-shard 9,908 tests, Desktop 1,036
tests and Mobile 342 tests plus the iOS wrapper assertions. Its unsharded
local Views run encountered 5-second timeouts; it did not increase the timeout
or weaken assertions. Native Mobile simulation/packaging was not verified.
These historical results provide handoff context; Stage 3's independent results
above and the final-head review gates remain authoritative.

## Final review guide and delivery gate

Repository-setting inspection on 2026-11-13 found no enforcement for `main`:
the branch-protection endpoint returned `404 Branch not protected`,
`rules/branches/main` returned `[]`, and the repository ruleset list was empty.
An administrator must apply the existing `ci-gates.md` contract: require a PR
with zero GitHub approvals, require `CI required` and an up-to-date branch,
enforce for administrators/bypass roles, and disallow direct pushes, force pushes
and deletion. Workspace expert reviews remain mandatory despite zero GitHub
approvals. This audit did not change repository administration settings.

- **Server/security:** `24526ccad` and `6fc753d0c`; compare fork HTTP, realtime,
  dependency projection, media/task-token ownership and message send-time access
  gates with the six private-project upstream patches. The high-risk boundary is
  queued work after membership removal, not only the initial list request.
- **Database:** unchanged 617–636 source blobs, retained 467 pair and wakeup
  definition chain; inspect both schema paths and rollback evidence above.
- **Frontend/Desktop:** `ae0b267fe`; compare sixty targets against M1's first
  parent and post-tag patches. Review comments, navigation, locale/brand overlays,
  theme variables, private-project controls and marketing/Star mount gates.
- **CI/root tooling:** `.github/workflows/ci.yml` preserves Ubuntu 24.04,
  `CI required`, backend-format and retained E2E scopes; catalog checks are added.
  The final PR must satisfy `CI required` and branch protection described in
  `ci-gates.md`, including both validated aggregates. Remote CI is left to the
  PR checks; it is not polled by the author.
- **Archive:** this document incorporates Stage 1 ancestry, conflicts,
  decisions, security corrections and validation history plus Stage 2 outcomes.
  The temporary Stage 1 file is removed after consolidation.

Two sequential expert reviews from different model families must approve the
final PR head before the second reviewer merges. The author does not merge,
deploy, publish releases or activate a live feed.
