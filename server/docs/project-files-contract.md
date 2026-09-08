# Project files API v1 (OL-33)

Integration baseline: product main `2893af49e`. The OL-20 prototype
`af95fc65946a5d46b764d5d68809e2320e5cc7a6` supplies behavioral regressions;
its grant table, standalone module and storage-in-transaction implementation
are not integrated. This document is the backend handoff for OL-34/35/36/37.

## Identity and scope

All routes below require the existing authenticated API and workspace membership
middleware. Base: `/api/projects/{project_uuid}/files`. Human requests select the
workspace with `X-Workspace-ID` or the existing workspace selector. Runtime
requests use their server-minted `mat_` token. Never send author fields.

The service takes typed identity from authentication middleware, checks current
membership, and derives a run's project from its issue (or chat session for a
chat run). A live run requires a non-archived agent, an unexpired task token and
`running`/`dispatched` status without `completed_at`. No-project runs, a changed
project association, ended runs, removed membership and revoked/expired
credentials are rejected. Final commit repeats these checks under locks. A
member's valid workspace membership grants access to that workspace's projects;
this feature does not create private-project ACLs.

Idempotency scope: `(workspace, project, actor_type, actor_id, key)`. Member actor
IDs are user IDs; run actor IDs are task IDs. Author attribution is separately
`member/user_id` or `agent/agent_id` plus `source_task_id`. A different run, even
of the same agent, cannot query or replay the first run's private operation
ledger. Authorized members can still read shared file and candidate content.

## Endpoints

| Method and suffix | Input | Successful response |
| --- | --- | --- |
| `GET /capabilities` | none | `{enabled:true,api_version:1,read_only:false,max_file_bytes:67108864,max_page_size:200}` |
| `GET` | `prefix`, `after`, `limit` (optional) | `{files:[metadata],next_cursor?:string}` |
| `GET /content` | required `path`; optional integer `revision` | Authorized binary stream and version headers |
| `PUT /content` | required `path`; raw body and headers below | `200 SAVED` or `409 CONFLICT` result |
| `GET /candidates` | required `path`; optional `after`, `limit` | Same page envelope; unresolved candidate metadata |
| `GET /candidates/{candidate_uuid}/content` | no body | Authorized candidate stream; also readable after resolution |
| `POST /candidates/{candidate_uuid}/adopt` | `Idempotency-Key`; JSON `{path,expected_revision}` | `200 SAVED` or `409 CONFLICT` result |
| `GET /operations/{key}` | no body | `200 {state:"COMPLETED",operation_id,result}` or `202 {state:"PENDING",operation_id}` |

Paths are case-sensitive UTF-8 relative logical paths, not OS paths. Maximum
1024 bytes, 255 bytes per segment. Absolute paths, backslashes, controls, empty
segments, `.` and `..` are rejected without silent normalization. Prefixes are
literal (`%` and `_` are not wildcards); `docs/` lists that subtree, while `docs`
also matches `docs-old`. A file cannot occupy another file's ancestor or
descendant path. Directory mutation is outside this delivery.

Pages default to 50 and reject limits outside 1–200. Pass the returned
`next_cursor` as `after`, with the same prefix/path. File cursors are paths in
bytewise order; candidate cursors are UUIDs. Stop when the cursor is absent.
Pages are current reads, not a stable snapshot across concurrent changes; refresh
the first page to discover new entries sorted before a cursor. No listing reads
object contents. File metadata includes `file_id`, `path`, `revision`,
`base_revision`, `version_id`, `size_bytes`, `sha256`, `content_type`,
`author_type`, `author_id`, optional `source_task_id`/`candidate_id`, `updated_at`.
Candidate `revision` is 0: it has not become a current revision. Use the content
headers to bind a downloaded working copy to the exact version read.

## Save and replay

Required save headers:

- `Idempotency-Key`: 1–128 ASCII letters, digits, `.`, `_`, `:`, `-`; UUID recommended.
- `X-Base-Revision`: the revision actually read before editing; 0 creates a new path.
- `X-Content-SHA256`: lowercase hex SHA-256 of the complete body.
- Known HTTP `Content-Length`: use a sized reader; chunked/unknown-length uploads are rejected.
- `Content-Type`: defaults to `application/octet-stream`; include it consistently on retries.

The binding includes operation kind, path, base/expected revision, content digest,
size, content type and candidate ID where applicable. Reusing a key for any
different binding yields `OPERATION_KEY_REUSED`, in both save/adopt directions.
The service verifies supplied bytes even on a successful replay, so claiming a
known digest does not bypass content validation. New requests cannot skip a
previous conflict by silently substituting the latest revision.

Example save (placeholders; API clients should send the same headers):

```http
PUT /api/projects/{project_uuid}/files/content?path=facts.md
Authorization: Bearer {credential}
X-Workspace-ID: {workspace_uuid}
Idempotency-Key: save-facts-1
X-Base-Revision: 0
X-Content-SHA256: 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
Content-Type: text/plain
Content-Length: 5

hello
```

```json
{"operation_id":"save-facts-1","status":"SAVED","file_id":"{uuid}","path":"facts.md","base_revision":0,"revision":1,"version_id":"{uuid}","replayed":false}
```

Another save based on revision 0 keeps the current revision and preserves bytes:

```json
{"operation_id":"save-facts-2","status":"CONFLICT","file_id":"{uuid}","path":"facts.md","base_revision":0,"revision":1,"version_id":"{candidate_version_uuid}","candidate_id":"{uuid}","conflict_current":1,"replayed":false}
```

On conflict, `version_id` identifies the preserved candidate content;
`revision`/`conflict_current` are the current revision observed at that commit.
Adopt using the revision observed when deciding to adopt, with a fresh operation
key. A stale decision is also durably recorded as CONFLICT without consuming
the candidate. The same original conflict is replayed even after the head moves
or someone else adopts the candidate.

All SAVED results, including the first successful adoption and its replay, omit
`candidate_id` and `conflict_current`. The adoption binding keeps candidate ID
internally. Apart from `replayed`, every result field is identical across the
initial response, request retries and operation lookup. Never infer success from
HTTP 2xx alone: `202 PENDING` is not a save confirmation. Unknown future statuses
must not be treated as SAVED. Shared response schemas live in
`packages/core/api/project-file-schemas.ts`; malformed save/adopt responses parse
as null instead of an invented success.

## Streaming reads

Downloads expose `X-File-ID`, `X-Revision`, `X-Base-Revision`, `X-Version-ID`,
`X-Content-SHA256` and, for candidates, `X-Candidate-ID`. Capture `X-Revision` with
the working copy and reuse it as `X-Base-Revision` on save. `X-Base-Revision` on a
read describes that version's provenance, not the next save's base. Validate
length and SHA-256 before accepting a download. No range/partial read is offered
in v1, preventing accidental save of a truncated working copy.

Responses use `Cache-Control: private, no-store`, attachment disposition,
`nosniff` and a sandbox CSP. They provide no public URL or presigned bypass.
Stream interruption aborts the response. A read is pinned to one immutable
version even if the head moves during transfer. The application never executes
shared file content as instructions. Authorized local copies are not remotely
revocable; subsequent requests are checked again.

## Failure semantics

Errors are `{code,error}`. CONFLICT is a result envelope, distinct from an error.

| HTTP | Code | Client action |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Correct missing/invalid metadata; no success |
| 400 | `CONTENT_MISMATCH` | Keep draft; length or hash is wrong |
| 401 | Existing auth middleware error | Restore valid credentials |
| 403 | `ACCESS_DENIED` | Stop accessing this scope; refresh run/project context |
| 403 | `READ_ONLY` | Keep draft; reads and completed operation replay remain available |
| 404 | `NOT_FOUND` | No authorized file/candidate/operation found; operation absence is not proof a concurrent request cannot still commit |
| 409 | `OPERATION_KEY_REUSED` | Do not change parameters under this key |
| 409 | `PATH_COLLISION` | Select a path that can represent a file |
| 413 | `FILE_TOO_LARGE` | Respect capability limit |
| 503 | `PROJECT_FILES_DISABLED` | Capability unavailable or configuration invalid |
| 503 | `STORAGE_UNAVAILABLE` | Bytes are not confirmed as shared; retry the same complete request/key |
| 503 | `OUTCOME_UNKNOWN` | Commit acknowledgement was lost; query the same operation or retry unchanged |
| 503 | `TEMPORARILY_UNAVAILABLE` | Database/lock timeout; retry unchanged |

UUID parse errors and the existing auth/workspace middleware retain the existing
API's `{error}` shape and may omit `code`. Clients must accept that shape too.
503/202 responses include `Retry-After: 1`; use bounded backoff, not a tight loop.

PENDING means an intent exists without a committed result. It does **not** mean
a background worker will finish it. Retry with the original body/key when the
client owns them. Each retry gets a fresh immutable object key; no in-flight
attempt overwrites another attempt's bytes. The final short transaction commits
version, head or candidate, upload reference and complete result atomically.
If another attempt already committed, the loser replays that result.

Uploads happen outside transactions. Upload failure, rejected final authorization
and rolled-back metadata leave a durable intent and possibly unreferenced bytes;
they never report a preserved conflict unless a CONFLICT result committed.
Automatic expiry/GC is intentionally absent: do not delete pending objects based
on age or a one-time lack of references. Metadata retention and private bucket
retention are prerequisites for safe retries and future cleanup.
