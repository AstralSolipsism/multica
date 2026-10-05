# Labrastro frontend API modules

OL-130 continues the [skill API extraction](labrastro-skill-packages.md#upstream-touchpoints).
The starting main revision is `7173798b8`; the upstream comparison baseline
is `2ea01ae4e`. This is a client refactor: routes, request bodies, headers,
workspace/cache ownership, response defaults and write-confirmation rules stay
the same.

## Module inventory

All paths below are relative to `packages/core/api/` unless noted otherwise.

| Module | Public methods / responsibility |
| --- | --- |
| `labrastro-message-delivery-api.ts` | 25 methods: automation route CRUD, enable/test, approvals/revocation, delivery list/detail/retry; personal/team catalog, route CRUD, enable/test, approvals/revocation and delivery list/detail/retry |
| `labrastro-lark-api.ts` | 6 methods: `setLarkConversation`, target capabilities, chat pages, message anchors, private-chat candidates and confirmation |
| `labrastro-dependency-api.ts` | 4 methods: issue graph, dependency read, compound create/update; also `dependencyErrorDetails` and its public type |
| `labrastro-quota-api.ts` | `getGlmQuota` |
| `labrastro-skill-api.ts` | The existing 16 skill/package/folder/placement methods |
| `labrastro-api.ts` | One mount for all five modules after the upstream class definition |
| `labrastro-api-helpers.ts` | Upstream transport bridge, collision-checked installation and shared response policies |
| `labrastro-api-error.ts` | The unchanged `ApiError` class, shared without a runtime import of `client.ts` |
| `labrastro-message-delivery-schemas.ts` | Message response schemas, inferred response types and existing fallbacks |
| `labrastro-quota-schemas.ts` | GLM, plan-quota, host metrics and shallow runtime-list schemas |
| `../lark/schema.ts` | Existing fork Lark schemas, now also the source of inferred response types |
| `dependency-schemas.ts`, `issue-graph-schemas.ts` | Existing fork dependency/graph contracts; no schema changes |

The 36 newly extracted methods keep their original names on `ApiClient`.
Module augmentation derives the public interface from the implementation objects;
there is no second handwritten method-signature list. The skill module uses
the same pattern. `clientFetch` indexes the upstream private fetch signature,
so a transport rename or signature change becomes a type error. Authentication,
CSRF handling and workspace headers still run through that transport.

Before installing any method in a module, the shared installer checks every
name with `name in target.prototype`. Own and inherited collisions, including
repeated installation, throw without overwriting anything or partly installing
that module. Descriptors match class methods: non-enumerable, writable and
configurable. An upstream addition with a compatible signature still trips
this runtime guard.

`ApiError` moved without changing its constructor, fields or identity across
exports. It remains available from both `@multica/core/api` and
`@multica/core/api/client`. Keeping its implementation independent of the
client prevents a cycle when a fork module is imported before `client.ts`;
the regression suite exercises all five module-first import orders.

## Response and type contracts

`parseRequiredResponse` follows upstream `parseSearchIndexResponse`: use
`parseWithFallback` for schema validation/logging, then reject an unreadable
result. It emits `ApiError` with `body.code = response_unreadable` and status
0. Configuration/consent reads cannot become a verified empty configuration.
The dependency writes and batch-update result keep their existing shape-only
validation and now expose this code instead of English UI sentences.

`parseConfirmedWrite` is OL-118's existing helper extracted from the client.
Malformed shapes or failed operation evidence emit `response_unconfirmed`.
Message writes still require the returned route/delivery/approval ID;
revocations still require `revoked === true`. Lark writes retain their
schema-only confirmation contract: a validated `conversation: null` is a
legitimate result, including revocation. There is no automatic write retry.

Other policies remain separate: delivery history retains its existing empty
list/unknown-detail fallbacks; graph/dependency reads and skill responses
retain null; malformed runtime host metrics degrade per row; malformed GLM
windows are dropped individually. Runtime plan quota still uses its existing
per-window sanitizer. No schema validator/default changed during extraction.

Message and Lark response types use `z.infer` (nested event/sender types use
indexed access into those inferred types). The old `types/message-delivery*.ts`
and `types/lark.ts` exports remain available, with response definitions
re-exported from the schemas. Request-only interfaces remain handwritten:
they describe different payloads, not mirrors of response schemas. Inferred
output types include defaults actually supplied by parsing, such as
`requested_by: null`; test fixtures must represent those parsed outputs.

Views own localized failure copy. Lark discovery maps unreadable responses to
the existing picker translation; private-chat and conversation authorization
map unreadable/unconfirmed codes into the fork `lark` namespace in all five
locales. Dependency views already fall back through `clientErrorMessage` to
the fork `dependencies` namespace, which cannot expose a status-0 diagnostic.
The existing bounded discovery-read retry policy is preserved for the new
coded error class. No upstream locale file is modified.

## Upstream touchpoints

| File | Retained hook and reason |
| --- | --- |
| `packages/core/api/client.ts` | Imports and calls the aggregate installer; imports/re-exports the unchanged `ApiError` identity and re-exports dependency error helpers. Only three upstream method bodies retain fork changes, listed below. |
| `packages/core/api/client.ts` — `batchUpdateIssues` | Keeps the established public name and richer batch result type; parses authoritative totals and optional per-item dependency/dispatch diagnostics. |
| `packages/core/api/client.ts` — `listRuntimes` | Keeps the public name and upstream workspace header logic; parses host metrics per row with the same shallow fallback. |
| `packages/core/api/client.ts` — `listLarkInstallations` | Keeps the public name; preserves unreadable conversation grants and rejects malformed configuration responses. |
| `packages/core/api/schemas.ts` | Re-exports message/quota/skill schemas. The pre-existing `IssueSchema.dispatch` and `SkillSchema.diagnostics` extensions and their imports remain: these fields extend upstream entities and are not standalone schemas. |
| `packages/core/types/lark.ts` | Re-exports schema-inferred installation/list and fork discovery/conversation types; device-flow response interfaces remain unchanged. |
| `packages/views/settings/components/lark-conversation-form.tsx` | Uses the fork `lark` copy for unconfirmed authorization responses; drafts and mutation ownership are unchanged. |

The three methods stay in place because upstream callers already use their
names. Renaming them would require sweeping callers and could leave some
paths without boundary validation. They are never overwritten by installation.
`setLarkConversation` is a new fork method relative to `2ea01ae4e` and moves
with the other five Lark methods.

The comparison command is:

```sh
git diff 2ea01ae4e --numstat -- packages/core/api/client.ts packages/core/api/schemas.ts
```

After extraction, the client has 14 added and 21 deleted lines (the deletions
include moving `ApiError` unchanged); schemas has 7 added lines. Of the latter,
2 are the new message/quota re-exports and 5 are the retained skill/dispatch
hooks. Neither upstream file contains standalone fork method/schema blocks.

## Verification

Canonical boundary matrices remain in the existing core suites beside the
client, including message delivery/contracts, Lark discovery/conversations,
dependency/graph, quota/runtime and skill-package suites. The new helper suite
covers collisions, descriptors, module import order and shared parser policy.
Lark query tests cover retry preservation; views tests cover error localization
and retaining an unconfirmed draft/dialog.

Run the complete core/views suites, the root typecheck, and frontend lint:

```sh
pnpm --filter @multica/core test
pnpm --filter @multica/views test
pnpm typecheck
pnpm lint
git diff --check
```

No backend, database or API wire format changes are included.
