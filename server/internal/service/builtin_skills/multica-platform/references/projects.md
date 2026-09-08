# Projects and resources

A project groups work and carries durable resources. A resource is not just
display metadata; it is context later injected into task briefs and
`.multica/project/resources.json`.

- [Core model](#core-model)
- [CLI](#cli)
- [local_directory execution modes](#local_directory-execution-modes)
- [Referring to a project in a comment](#referring-to-a-project-in-a-comment)
- [When to add a resource](#when-to-add-a-resource)
- [Debugging wrong context](#debugging-wrong-context)
- [Side effects](#side-effects)

## Core model

Projects are durable context containers. Resources attached to a project can
affect future agent tasks.

```bash
multica project list --output json
multica project get <project-id> --output json
multica project resource list <project-id> --output json
```

Project resources are mutated through project resource commands/endpoints. Issue
comments do not create durable project resources.

A project's `description` is also durable context: when an issue (or a
quick-create task) is bound to a project, the project description is injected
into the agent's brief under `## Project Context` and written to
`.multica/project/resources.json` as `project_description`. Use it for
project-wide rules/context that should apply to every task in the project.

Common resource types:

- `github_repo` — durable GitHub repo context, with `resource_ref.url`, optional
  checkout `ref`, and optional prompt-only `default_branch_hint`;
- `local_directory` — daemon-local path context, with `resource_ref.local_path`,
  `daemon_id`, optional label, and optional `execution_mode` (`in_place`, the
  default, or `worktree`).

## Shared project files

An opt-in backend file API exists at `/api/projects/{project_uuid}/files`,
separate from resource pointers. It offers capabilities, bounded metadata lists,
authorized content reads, revision-checked saves, candidates and operation lookup.
The CLI advertises `multica project file --help`; each subcommand exposes its
parameters and recovery requirements. Project-bearing
runtime briefs and `.multica/project/resources.json.shared_files` carry its
capabilities/list/help commands; they do not preload any shared file content or
claim the opt-in service is enabled. Check capabilities before use.

```bash
multica project file capabilities <project-id> --output json
multica project file list <project-id> --prefix docs/ --limit 50 --output json
multica project file read <project-id> docs/facts.md --to-file ./facts.md --output json
multica project file save <project-id> docs/facts.md --from-file ./facts.md --base-revision <revision-read> --request-file ./save-1.json --output json
multica project file operation <project-id> <operation-id> --output json
multica project file retry ./save-1.json --output json
multica project file candidates <project-id> docs/facts.md --output json
multica project file candidate <project-id> <candidate-id> --to-file ./candidate.md --output json
multica project file adopt <project-id> docs/facts.md <candidate-id> --expected-revision <revision-observed-at-decision> --request-file ./adopt-1.json --output json
```

All these commands emit one JSON response on stdout. Downloads require a **new**
`--to-file` destination, verify length/SHA-256 before publishing, and return the
version headers as JSON. Use `revision`, not `base_revision`, as the next save's
base. `read --revision N` reads history. Lists contain one page (default 50,
maximum 200): use returned `next_cursor` as `--after` with the same prefix/path.
Candidate `revision` is 0 and must not become a working copy's current revision.

`save` requires an explicit `--base-revision` (0 creates); `adopt` requires an
explicit `--expected-revision`. Both require a new `--request-file`. Before any
mutation, the CLI persists the original request and content in a private JSON
snapshot. Do not edit, commit, share, or delete pending snapshots. `--operation-id`
is optional for a new decision (default UUID); the generated ID is saved before
the request and returned with results/errors. A retry uses the snapshot's ID,
bytes, content type, path and revision, even if the working file has changed.
The snapshot contains a one-way credential binding, never the raw credential;
it refuses replay with a different server, workspace or credential. A later run
cannot inherit the previous run's private ledger. For a rotated member credential,
query the original operation with the same member identity; do not rewrite the
snapshot or turn an uncertain request into a new operation.

Exit codes: **0** confirms a validated successful read/query or SAVED mutation;
**6** is a committed CONFLICT (candidate preserved, current file unchanged);
**7** means pending/unconfirmed or malformed response. Existing codes remain
**2** transport failure, **3** auth rejection, **4** not found, **5** invalid
parameters, **1** other errors (including operation-key reuse/path collision and
503 `PROJECT_FILES_DISABLED`). On mutation failures stdout preserves `code`,
`operation_id` and `request_file`. Its `state` is `FAILED` for local/preflight
failures and terminal API rejections, including 400/401/403/404/413 and
`PROJECT_FILES_DISABLED`. `UNCONFIRMED` is reserved for mutation attempts or
operation lookups with transport failures, unverifiable results or other 5xx
responses. A preflight network/malformed-response failure exits 2/7 but has
`FAILED` state because no mutation was sent. A rejected retry or failed lookup
does not settle an earlier uncertain attempt; retain its original request.
The CLI never invents a candidate or a successful save. Stop on
401/403; never fall back from the run's token to a member/profile credential.
PENDING does not schedule a worker, and operation 404 is not proof an in-flight
write cannot commit. Wait at least one second after 202/503; query first, then
retry unchanged when appropriate. There is no automatic retry or polling loop.

Snapshots/downloads are capped at 64 MiB of content by this CLI; a lower server
capability limit still applies. Each new `save` preserves its snapshot, fetches
capabilities once and prechecks `max_file_bytes` before uploading. Over-limit
drafts return `FILE_TOO_LARGE`/`FAILED` with exit 5; capability failures also send
no mutation and retain the snapshot. The server can still reject with 413 if its
limit changes. `retry` skips preflight to reach the original operation ledger
under changed capabilities, using the original bytes/key. JSON snapshots include
base64 content and need additional local disk/memory. Keep them in the task workdir; the CLI retains them
after success too, until the caller explicitly cleans up. The filesystem must
support private files and hard links (atomic publication without overwrite).

An enabled client must retain the revision read before editing, acknowledge only
`SAVED`, keep drafts on `CONFLICT` or unknown outcomes, and retry the same request
with its original operation key. Conflict adoption also requires an explicit
expected revision. A task token is limited to its current server-associated
project; operation keys are isolated per run. Listings contain no file contents,
and shared documents do not acquire instruction priority from being stored here.

For an uncertain save/adopt result, query its operation before resending content;
that lookup avoids the project write lock taken by mutation retries. In candidate
lists, `updated_at` means candidate creation time, not a later edit or resolution.
Use revision/version IDs for concurrency. Local PAT/task-token validity is
rechecked before commit; JWT expiry is rechecked when present, but remote JWT
session or cloud-PAT revocation during an authenticated request is not.

## CLI

```bash
multica project list --output json
multica project get <project-id> --output json
multica project create --title "<title>" --repo <github-url> --output json
multica project create --title "<title>" --start-date 2026-03-01 --due-date 2026-03-31 --output json
multica project update <project-id> --title "<title>" --output json
multica project update <project-id> --due-date 2026-04-15 --output json
multica project update <project-id> --start-date "" --output json   # clear the start date
multica project status <project-id> in_progress --output json
multica project resource list <project-id> --output json
multica project resource add <project-id> --type github_repo --url <github-url> --output json
multica project resource add <project-id> --type github_repo --url <github-url> --ref <branch-or-sha> --output json
multica project resource add <project-id> --type local_directory --local-path <abs-path> --daemon-id <daemon-id> --output json
multica project resource add <project-id> --type local_directory --local-path <abs-path> --daemon-id <daemon-id> --execution-mode worktree --output json
multica project resource update <project-id> <resource-id> --execution-mode in_place --output json
multica project resource update <project-id> <resource-id> --url <new-github-url> --output json
multica project resource update <project-id> <resource-id> --ref <branch-or-sha> --output json
multica project resource remove <project-id> <resource-id> --output json
```

For `github_repo`, non-JSON `--ref` sets `resource_ref.ref`, the default
checkout branch/tag/SHA for future tasks in that project. JSON `--ref '<json>'`
remains the escape hatch for full payloads or resource types not covered by
shortcuts. `project resource update` merges shortcut edits with the existing
`resource_ref`, so a partial edit does not clobber required fields.

`--start-date` / `--due-date` are optional calendar days (`YYYY-MM-DD`, like
issue dates). On `project update`, pass an empty string (`--start-date ""`) to
clear a date; an unset flag leaves it untouched.

## local_directory execution modes

`--execution-mode` decides how tasks share a `local_directory`.

`in_place` (default) runs the agent in the user's directory, one task at a time;
a second task waits in `waiting_local_directory`.

`worktree` gives each task its own git worktree of that repo, so tasks run
concurrently and each delivers its work as a branch in the user's repo instead
of editing the working copy. Every task of one conversation shares that branch —
`agent/<agent>/<issue>` for an issue, `agent/<agent>/chat-<session>` for a chat
— and each turn's worktree starts from the previous turn's work rather than from
`HEAD`; a task with no conversation behind it gets `agent/<agent>/<task>`.

Continuation is decided by an ownership record
(`refs/multica/local-state/<conversation-fingerprint>/<branch>`, whose path carries the owning
conversation — commit messages carry no owner data — and whose commit holds the
snapshot of the user's directory the branch already carries and the branch tip
it was recorded at), never by the branch name. A same-named branch the user
created — or one that no longer contains the recorded commit, i.e. deleted and
recreated or force-moved — is left alone and the task falls back to
`agent/<agent>/<issue>-<id>`.

A turn replays only what the user changed since that snapshot; when those edits
conflict with the branch's own work the worktree is handed to the agent
mid-merge and the run delivers nothing until the agent resolves it.

`worktree` requires the path to be a git repository with at least one commit;
tasks fail with an explicit error otherwise. The gate is the `local-worktree-v1`
capability the daemon advertises — not its version string — and it is checked
twice: at save time, and again against the daemon that claims each task, so a
machine whose runtime cannot do worktrees gets its tasks cancelled rather than
run in place. Saving `worktree` is refused (HTTP 422, code
`daemon_version_unsupported`) while the daemon on that machine does not
advertise the capability — the fix is updating the Multica app there, then
retrying. Pass an empty value to clear it back to the default.

## Referring to a project in a comment

A project has no `MUL-123`-style identifier, so writing its title as prose
produces dead text — there is nothing for the reader's client to autolink. Use
the mention-link form instead, with the project UUID from
`multica project list --output json`:

    [Roadmap](mention://project/<project-id>)

Every client makes it navigable, with different presentation: web and desktop
render a chip carrying the project's icon and current title, while mobile
renders an ordinary link that opens the project on tap. Unlike `@agent` /
`@squad`, it is a pure link: the mention parser does not recognize `project` at
all, so it enqueues nothing and notifies nobody — the same no-side-effect
contract as an `issue` mention.

Prefer this form over pasting the project's URL. Web and desktop do unfurl a
bare in-app project URL into that same chip, but mobile does not — there a
pasted URL is handed to the system browser and takes the reader out of the app.

## When to add a resource

Add/update a project resource when the user asks for durable project context:
"把这个 GitHub repo 绑到项目上", "以后都用这个 repo", "agent 总是拿不到这个项目的
仓库", or "这个项目要在我的本地目录里跑".

Project resources are durable and affect future tasks. `multica repo checkout`
is task-local checkout state.

## Debugging wrong context

1. `multica project get <project-id> --output json`.
2. `multica project resource list <project-id> --output json`.
3. Check `github_repo.resource_ref.url`, optional `ref`, `default_branch_hint`,
   and `local_directory.resource_ref.daemon_id`.
4. Updating resources is a durable mutation. After an update, listing the
   resource is the verification path.
5. If resources match the expected task context, inspect runtime/repo checkout
   path next.

## Side effects

Project create/update/delete/status and project resource add/update/remove
mutate durable workspace state and affect future tasks. Ask before changing
`local_directory` unless the user explicitly requested that exact local path.
