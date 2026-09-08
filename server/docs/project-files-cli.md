# Project file CLI/runtime handoff (OL-34)

OL-34 adds the business CLI and on-demand runtime entry points against OL-33's
merged API baseline `aa5d5a17dc821d88dfdace7a49726df55d49dd31` (PR #19).
The wire contract remains [project-files-contract.md](project-files-contract.md).
This delivery does not change the server file service, database schema, storage
configuration, deployment, or run authorization. Real infrastructure and two
live runtime verification belong to OL-35/36/37.

## Commands and result interpretation

All commands are under `multica project file`, accept `--output json` (the only
format), and use existing CLI server/workspace/task-token resolution. Project
arguments are UUIDs from the runtime brief or `project list`.

| Command | Required input | Result |
| --- | --- | --- |
| `capabilities <project>` | none | Enabled API version, read-only flag and limits |
| `list <project>` | optional `--prefix`, `--after`, `--limit` | One metadata page, no bodies |
| `read <project> <path>` | `--to-file`, optional `--revision` | Verified new local file; exact revision/version/hash metadata on stdout |
| `save <project> <path>` | `--from-file`, `--base-revision`, new `--request-file` | Original API SAVED/CONFLICT envelope |
| `candidates <project> <path>` | optional `--after`, `--limit` | One unresolved candidate page |
| `candidate <project> <candidate>` | new `--to-file` | Verified candidate copy, revision 0 |
| `adopt <project> <path> <candidate>` | `--expected-revision`, new `--request-file` | Original API SAVED/CONFLICT envelope |
| `operation <project> <operation>` | original operation ID | One COMPLETED/PENDING lookup |
| `retry <request-file>` | original snapshot and credential | Exact original mutation and key |

`save` and `adopt` accept `--operation-id` for an explicit new decision ID;
otherwise a UUID is generated and persisted **before** sending. Save content type
defaults to `application/octet-stream`; `--content-type` is captured by the
snapshot and never re-inferred on retry. List defaults to 50 with a maximum of
200; follow `next_cursor` explicitly with unchanged prefix/path. No recursive
listing, automatic polling or implicit mutation retry occurs.

Example (substitute project UUID and the revision from the read JSON):

```bash
multica project file capabilities "$PROJECT_ID" --output json
multica project file list "$PROJECT_ID" --prefix docs/ --output json
multica project file read "$PROJECT_ID" docs/facts.md --to-file ./facts.md --output json
# Edit facts.md, retaining the read response's revision in REVISION_READ.
multica project file save "$PROJECT_ID" docs/facts.md --from-file ./facts.md \
  --base-revision "$REVISION_READ" --content-type text/markdown \
  --request-file ./save-facts-1.json --output json
```

Downloads require a new destination and verify Content-Length, SHA-256, file and
version IDs, revision, and requested candidate/history identity. Failed or
truncated downloads never replace the working file. The read response's
`revision` is the base for the next edit; `base_revision` records provenance.
Candidate downloads have revision 0 and are not a current working copy.

| Exit | Meaning |
| --- | --- |
| 0 | Validated read/query, or a SAVED mutation |
| 1 | Other error, including OPERATION_KEY_REUSED, PATH_COLLISION, PROJECT_FILES_DISABLED or local publication failure |
| 2 | Transport failure, including truncated transfer; a mutation that was attempted has an unconfirmed outcome |
| 3 | 401/403; stop and keep draft/snapshot; no member/profile fallback |
| 4 | Not found; operation absence does not prove an in-flight mutation cannot commit |
| 5 | Invalid input, including locally rejected flags/paths/revisions or a draft exceeding the advertised server limit |
| 6 | Durably preserved CONFLICT; current file unchanged |
| 7 | Pending/unconfirmed response, malformed/unknown result, or 5xx mutation failure other than PROJECT_FILES_DISABLED |

Successful and conflict responses retain the complete API fields, including
future extra fields, without mixing diagnostics into stdout. An operation lookup
of a completed conflict also exits 6; PENDING exits 7. A SAVED response carrying
`candidate_id` (even null), missing fields, the wrong request identity or
inconsistent revision is rejected. PENDING and unknown statuses never count as
successful writes. Failures emit JSON with the API `code` when available plus
`operation_id`/`request_file` for a preserved mutation; stderr supplies guidance.
Shell flag-parser errors use Cobra's existing diagnostic path.

The error envelope's `state` describes this attempt: `FAILED` for local or
preflight failures and terminal API rejections (including 400/401/403/404,
operation-key/path errors, 413 and 503 `PROJECT_FILES_DISABLED`). `UNCONFIRMED`
is reserved for a mutation attempt or operation lookup with a transport failure,
unverifiable result, or nonterminal 5xx response. Drafts and snapshots remain in
both cases. A rejected retry or failed lookup does **not** settle any earlier
uncertain mutation; retain its original request. `FAILED` on a preflight network
error means no mutation was sent, even though the exit code is still 2. A malformed
preflight response similarly exits 7 with `FAILED`. Do not infer outcome from the
exit code alone or automatically retry terminal authorization/configuration errors.

For an uncertain result, query `operation` first. If appropriate, wait at least
one second after a 202/503 and `retry` the original snapshot. PENDING has no worker
behind it. Replaying a committed conflict returns that same conflict even after
the head moves or its candidate is adopted. A new edit or adoption decision needs
a new operation ID and an explicit newly observed base/expected revision.

## Local recovery and scope

Each mutation requires a new local `--request-file`. It contains a versioned JSON
snapshot, base64 save bytes, content hash, complete request checksum, server and
workspace scope, and a one-way SHA-256 binding of the current credential. It
contains no raw token, storage secret, public URL or signed storage URL. A source
file can change afterwards without changing retry bytes. Edited snapshots are
rejected, including changes to target, operation ID or revision. Checksums detect
accidental edits; they are not authentication against a local actor able to edit
both content and checksums.

The same credential is deliberately required for retry: a later run in a reused
workdir must not create a new write from the previous run's private operation.
After member credential rotation, the same member can still query the original
operation using the API's actor scope. Do not rewrite a snapshot to change its
credential or abandon an unknown request. This conservative local retry binding
does not broaden the backend's identity or authorization rules.

Files are written privately (0600), synced, then published with a hard link to
avoid overwrite races. A failed publication sends no mutation. Existing
destinations, including symlinks, are refused. Use a local filesystem supporting
hard links and private file permissions; unsupported filesystems fail closed.
The guarantee covers process interruption and partial writes, not filesystem or
machine loss. Snapshots remain after success/conflict/error; there is no automatic
cleanup. Keep them in the task workdir until results are resolved and evidence is
captured. Do not commit or attach request snapshots containing real resource data.

The client caps content at 64 MiB even if a server advertises a larger limit.
After preserving the snapshot, each new `save` fetches validated capabilities
once and checks `max_file_bytes` before uploading. An oversized draft exits 5
with `FILE_TOO_LARGE`/`FAILED`, retaining the snapshot and sending no mutation.
A capability failure also stops before upload. Limits can change after preflight;
the server remains authoritative and may still reject with 413. `retry` bypasses
this preflight so capability changes cannot hide an already committed operation;
it sends the original request/key unchanged. Snapshot base64 adds about one third
to disk size, and operations buffer bounded content/JSON in memory. Larger-file streaming
and retry across credential rotation are deferred until required by measured use.

## Runtime path and D build/configuration handoff

The existing claim flow resolves the issue/chat project into the task context.
`daemon.go` passes this to `execenv.Prepare` and runtime config injection. The
shared Project Context renderer now advertises capabilities/list/help, read
revision semantics, snapshot recovery and conflict exits. This renderer serves
issue/chat runtime briefs, including Claude and Codex. The existing
`.multica/project/resources.json` also gains a `shared_files` object containing
only those three commands. No-project runs receive no shared-file project entry.
Neither path calls the file API or loads file bodies during preparation.
Availability/authorization is checked by the runtime's explicit capabilities
call, so disabled deployments remain discoverable without claiming availability.

The built-in `multica-platform/references/projects.md` contains full CLI usage and
matches these commands. The installed CLI is the tool discovery mechanism; a new
MCP wrapper is unnecessary for these CLI-equipped runtimes.

Build in the reviewed checkout (replace `REVIEWED_SHA` with the B PR's accepted
commit). No database is needed:

```bash
set -eu
: "${REVIEWED_SHA:?set the accepted OL-34 commit SHA}"
test "$(git rev-parse HEAD)" = "$REVIEWED_SHA"
cd server
mkdir -p ../artifacts/ol-34
GOTOOLCHAIN=go1.26.6 go test ./internal/cli ./cmd/multica ./internal/daemon/execenv -count=1
GOTOOLCHAIN=go1.26.6 go build -trimpath \
  -ldflags "-X main.version=ol-34-review -X main.commit=$REVIEWED_SHA" \
  -o ../artifacts/ol-34/multica ./cmd/multica
GOTOOLCHAIN=go1.26.6 go build -trimpath -o ../artifacts/ol-34/server ./cmd/server
../artifacts/ol-34/multica project file --help
```

D must install this **CLI/daemon binary** in the test runtime's command path;
updating only the API/web service leaves old agents without commands/briefing.
The API server must also be built from the accepted B commit: the updated
built-in skill files are embedded by `internal/service/builtin_skills.go` and
distributed in task claims by the server. Deploying only the CLI leaves old skill
documentation in new runs. No service/API logic changes are required by B.
The existing server-minted run token and `MULTICA_SERVER_URL`,
`MULTICA_WORKSPACE_ID`, `MULTICA_TOKEN`, `MULTICA_TASK_ID` remain the only runtime
business configuration. No new client secret or storage configuration is added.
`MULTICA_HTTP_TIMEOUT` controls bounded requests (default 30s); a slow test proxy
may need a documented larger value such as `2m`.

Use A's [operations package](project-files-operations.md) for server enablement,
private storage, migrations, proxy limits, rollback and write preconditions.
B adds no migration. Runtime/CLI rollback is restoring the previously deployed
binary and restarting the daemon at a controlled boundary; retain unresolved
request snapshots and do not end live test runs before lookup/retry evidence is
collected. No binary installation/restart/deployment is performed by this PR.

## E: two actual runtime phases

Prerequisites: D's approved deployment, new CLI/daemon, two concurrently **live**
issue or project-chat runs in the same authorized project, each retaining its
own server-issued task token/workdir. Keep both top-level turns active while
executing their assigned phases. A run's completion revokes its recovery path;
do not replace it with another task for later phases. Master/E owns starting and
coordinating those runs. Use disposable sample data only, under the write
preconditions in A's operations package.

Before invoking the script, capture each actual run's initial brief and
`.multica/project/resources.json`: both must contain the project UUID and
capabilities/list/help entry; neither must contain the later sample text.
Confirm the binaries' commit identifiers. Python 3 is the script's only helper
dependency; `MULTICA_BIN` can select the reviewed CLI binary explicitly.

Run the following phases **in order**, using the same project and a fresh shared
logical prefix (for example `ol37/20260908-01`). Each invocation terminates; the
two containing runs must stay live between phases.

```bash
python3 server/scripts/project-files-runtime-check.py PHASE \
  --project "$PROJECT_ID" --case "$CASE_PREFIX"
```

| Order | Run | PHASE | Required evidence |
| --- | --- | --- | --- |
| 1 | A | `a-seed` | Discover capabilities/list, save revision 1, read revision 1 |
| 2 | B | `b-read` | Read the same revision 1 before A advances |
| 3 | A | `a-advance` | Save A's edit against 1, obtain revision 2 |
| 4 | B | `b-conflict` | Save against old 1: exit 6, candidate retained, current still A/revision 2; candidate bytes readable, retry and lookup complete fields match |
| 5 | B | `b-adopt` | Read current 2 and decide adoption: revision 3, no candidate_id on SAVED; retry and lookup identical except replayed; original conflict remains unchanged |
| 6 | A | `a-verify` | Read B's adopted bytes/revision 3; B's private operation lookup returns NOT_FOUND |

The script writes private per-phase JSON evidence in its local case directory
and prints `passed:true` only after all assertions for that phase pass. Deliver
the phase **report** files using the issue attachment mechanism, not machine-local
links; retain request snapshots privately. Re-running a completed phase is
refused, and replacing the original run identity is refused locally. If a phase
fails after a mutation, inspect its preserved request and query the operation;
do not delete files and blindly restart the scenario under the same keys.

Real deployment transport interruptions, task-token revocation, proxy download
truncation and cross-project denial remain E's additional checks from A's
operations package. The CLI's fault matrix runs against a controlled HTTP peer;
it does not claim those actual infrastructure checks passed.

## Local verification boundary

`cmd/multica/cmd_project_file_test.go` drives the actual Cobra commands and
authenticated HTTP client against a controlled independent peer. It covers
success/conflict/adoption, full response replay, original conflict after head
advance, key reuse across contents/operations, missing/invalid parameters,
401/403/400/409/413/503 responses, dropped commit acknowledgement, pending/absent
operation, request retention and identity isolation, bounded cursor propagation,
empty files, malformed responses, download integrity and redirect refusal.
`internal/daemon/execenv/project_files_test.go` exercises actual environment
preparation/config injection for issue/chat on Claude/Codex plus no-project
omission. These tests start no installed agent CLI and require no DB/storage.

The author review also checks authority direction (client cannot choose author),
no raw credentials in snapshots, no automatic base rewriting, publication races,
bounded input/HTTP reads, and failure/result separation. There is no obsolete
file workflow to remove. Backend race/authorization correctness remains A's
reviewed responsibility; real runtime, MinIO and proxy proof remains E's.

The handoff script is also exercised against that controlled peer with a freshly
built CLI binary, two synthetic run identities, and separate working directories:
all six phases check real process exit statuses and full replay fields. A
concurrent snapshot-publication test verifies only one competing writer can send
a request and the winning recovery file remains readable.

Author verification used Go 1.26.6. The complete `internal/cli`, `cmd/multica` and
`internal/daemon/execenv` package regressions pass with the race detector; focused
vet and CLI builds pass. The first broad CLI invocation inherited the surrounding
task marker, which breaks existing human-mode CLI tests after TestMain removes
task credentials. It was rerun from an isolated copy of the same source without
that external marker. The race run also exposed an unsynchronized counter read
in the new dropped-ack **test peer**; its state access now uses the peer's mutex.
No production identity guard was weakened for testing. Python syntax and the
six-phase controlled-peer script check pass; live C/D/E results remain pending.
