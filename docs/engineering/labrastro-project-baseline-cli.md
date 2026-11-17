# `multica project baseline` — baseline wiki CLI

OL-1329 turns the baseline CLI into the write surface for the tree wiki.
Humans and agents share identical permissions; every page write except `create`
requires the revision number the author read (`--base`), and the server
auto-rebases orthogonal changes (a rename never blocks a body edit; different
sections merge). The command group keeps its historical name
`multica project baseline`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | failure or indeterminate result (inspect state before retrying) |
| 2 | usage error, or HTTP 400 / 404 / 422 |
| 3 | 409 `baseline_conflict`: re-read with `tree` / `get`, merge, retry with the new `--base` |

Lint uses the read-only exit contract [below](#read-only-lint).

## Commands

| Command | Purpose | Key flags |
| --- | --- | --- |
| `tree <pid>` | page tree with slugs, titles, `vN`, depths and H2/H3 outlines | `--no-sections`, `--output text\|json` |
| `get <pid>` | read one page / section / historical revision | `--page <slug>`, `--section "<小节>"` (without `--page` searches across pages), `--revision N`, `--output markdown\|text\|json` (json adds `links`, `backlinks`, `related_issues`) |
| `create <pid>` | create a page (publishes `create` v1) | `--title`, `--slug`, `--parent`, `--after`, `--content-file`, `--summary`, `--source-issue` |
| `write <pid>` | whole-page or section write | `--page`, `--base N` (required), `--content-file` (alone or with `--section`), `--delete-section`, `--summary`, `--source-issue` |
| `rename <pid>` | change title or slug | `--page`, `--base N`, `--title`, `--slug`, `--summary`, `--source-issue` |
| `move <pid>` | change parent or order | `--page`, `--base N`, `--parent <slug>\|--root`, `--after <slug>\|--first`, `--summary`, `--source-issue` |
| `archive <pid>` / `restore <pid>` | soft delete / undo (slug stays reserved) | `--page`, `--base N`, `--recursive`, `--parent` (restore only), `--summary`, `--source-issue` |
| `history <pid>` | revisions with kinds (create/content/rename/move/archive/restore/rollback) | `--page`, `--limit`, `--before` |
| `diff <pid>` | structure metadata diff (title/slug/parent/position/archived) plus section-level body diff | `--page`, `--from N`, `--to M` (defaults to current) |
| `rollback <pid>` | restore vN as a new revision | `--page`, `--to N`, `--base M`, `--content-only`, `--summary`, `--source-issue` |
| `activity <pid>` | project-wide recent changes, archived pages included | `--limit`, `--before` |
| `search <pid> "<q>"` | title/body full-text search with section snippets | `--limit` |
| `lint [<pid>]` | check links, architecture diagrams and boundary gates | `--dir <export-dir>` (instead of pid), `--page <slug>`, `--output text\|json` |
| `export <pid>` | export `<slug>.md` files with YAML headers into `--dir`, or one `--single-file` | `--dir ./docs/baseline`, `--single-file <path>` |

`--content-file` reads a regular file inside the current directory only
(`filepath.IsLocal` + `os.OpenRoot`, in-directory symlinks allowed), capped at
64 KiB of NUL-free UTF-8. `--source-issue` accepts an `OL-xxx` identifier or a
UUID; the server validates it belongs to the project. Writes never auto-retry.

## Migration from the retired commands

Retired subcommands (`propose`, `adopt`, `annotations`, `respond`) exit with
code 2 and print a migration hint. Map old invocations:

| Old | New |
| --- | --- |
| `get --index` | `tree` |
| `get --chapter overview [--section s]` | `get --page overview [--section s]` (built-in chapter keys are slugs) |
| `get --chapter module:<name>` | `get --page <name>`; if the module collided with a built-in slug it gained a 6-char hash suffix, or it may have been renamed — run `tree` to see the live slug |
| `get --candidate` | removed — writes publish immediately; use `history` and `diff` |
| `propose --section … --base-current` | `write --section … --base N` (`--base-current` is gone: stale reads must not blind-overwrite) |
| `adopt` / `adopt --reject` | removed — `rollback` undoes an unwanted write |
| `diff --chapter c --from --to` | `diff --page <slug> --from --to` |
| `annotations` / `respond` | `comment list` / `comment show` / `comment reply`; the retired commands remain rejected |

## Typical loop

```bash
multica project baseline tree <pid>                       # outline + current vN per page
multica project baseline get <pid> --page architecture --section "分层"
multica project baseline write <pid> --page architecture --section "分层" \
  --content-file ./edit.md --base 5 --summary "补充分层规则" --source-issue OL-1304
# exit code 3 → someone else published; merge and retry with the new --base
multica project baseline history <pid> --page architecture
multica project baseline diff <pid> --page architecture --from 5
multica project baseline rollback <pid> --page architecture --to 5 --base 7
```

## Passage discussions

All commands start with `multica project baseline comment` and take `<pid>`.
They support `--output text|json`; comment writes do not take `--base`.

| Command | Flags |
| --- | --- |
| `list` | `--page <slug-or-id> [--state open|resolved|all]` (default open) |
| `show` | `--thread <uuid> [--with-section]` |
| `create` | `--page <slug-or-id> (--quote "rendered passage" [--section "title-or-anchor"] | --section "title-or-anchor") --content-file ./comment.md [--issue OL-x]` |
| `reply` | `--thread <uuid> --content-file ./reply.md` |
| `edit` | `--comment <uuid> --content-file ./edit.md` |
| `delete` | `--comment <uuid>` |
| `resolve` / `reopen` | `--thread <uuid>` |

Comment files use the same directory-confined UTF-8 reader, limited to 4000
code points (16000 bytes). Quotes must uniquely match rendered section/page
text; ambiguous or missing quotes return exit 2. `show --with-section`
returns current own-section Markdown, not descendants or a stale snapshot.

Only explicit agent/squad mentions outside code in a new comment/reply enter
dispatch. Ordinary comments, human mentions, `@all`, edits and resolution do
not create an Issue, Issue comment or task. `woke` reports accepted and blocked
targets independently of the saved comment. A blocked result can be retried by
posting a new explicit mention. See [the comment contract](labrastro-baseline-comments.md).

## Read-only lint

```bash
multica project baseline lint <project-id> --output json
multica project baseline export <project-id> --dir ./docs/baseline
multica project baseline lint --dir ./docs/baseline --page architecture
```

Supply exactly one project ID or `--dir`. Online lint reads the active `/tree`
and `/pages/{slug}` endpoints; offline lint reads the exported `.md` files in
one directory, without credentials or network access. Both use the same checker.
`--page <slug>` filters diagnostics after checking the complete snapshot: it
includes that page's diagnostics and conservation mismatches involving its
parent or direct children. An unknown page is a usage error.

Directory input follows the same working-directory confinement, UTF-8 and
regular-file checks as `--content-file`. Export headers contain `slug`, `title`
and an optional `parent` **slug**, preserving the page tree without database
IDs. Missing parents, cycles, duplicate slugs and malformed frontmatter are
rejected. Older exports without `parent` remain readable as root pages; export
again to check their parent/child boundaries. Use the directory export, not
`--single-file`. Locations are 1-based lines in the Markdown body (excluding
export frontmatter), matching online diagnostics.

The checks are deterministic:

- Wiki links use the same slug/title/section resolver and Markdown exclusions as
  previews and backlinks. Missing or archived targets, missing sections and
  ambiguous page titles are errors. `[[...]]` in a fence is a warning: put
  navigation immediately below the diagram. Native Mermaid `node[[label]]`
  subprocess shapes are exempt.
- Mermaid `flowchart` / `graph` diagrams allow at most seven business nodes.
  Node text is limited to 36 CJK characters total and 22 per line (Latin text
  counts half); HTML tags do not count and `<br>` separates lines. Requirement
  IDs, SQL `table.column` / typed-column patterns, code line references and
  numbered steps are errors, as are edge-label ellipses. Hexadecimal `fill`,
  `stroke` or `color` in `style`, `classDef` or `linkStyle` is an error for **all**
  Mermaid diagram types. A flowchart page must link to each active direct child
  outside fences.
- A parent node ID matching a direct child's slug is reconciled with that
  child's matching **top-level subgraph ID**, treating `-` and `_` alike.
  Incoming and outgoing external peer sets must match separately; repeated
  internal fan-out to the same external peer is allowed. Diagnostics name the
  missing/extra peers and direction. Children without that container expansion
  are not subject to conservation checks.
- A section opts into boundary gates only when it contains a Markdown list and
  its heading contains `门规`, or its list has at least two bold field labels.
  It must contain `对外开口`, `唯一记忆事实`, `死守底线`, `外部默认前提`.
  `死守底线` needs a nonempty `反例：...` in its item/sublist or an explicit
  violation condition (for example, `若取消后又成交，则判为违规`). Ordinary
  paragraphs and BDD lists are unaffected. This checks structure and markers,
  not the semantic adequacy of a claimed counterexample.

The Mermaid topology reader handles classic node shapes, quoted/Markdown
labels, semicolon-separated statements, chains, `&` fan-out, labeled solid,
dashed and thick arrows, bidirectional arrows, nested subgraphs and comments.
It does not replace Mermaid's renderer or validate visual layout. Unsupported
statements (for example `@{...}` node/edge attributes) produce
`mermaid_topology_unchecked` warnings and skip conservation for that diagram;
use simple statements to obtain a complete topology check. Unheaded edges
(`---`, `~~~`) have no incoming/outgoing direction.

`--output text` (default) prints locations, severity, stable diagnostic code and
message, then counts. `--output json` prints one object to stdout:

```json
{"ok":true,"error_count":0,"warning_count":0,"diagnostics":[]}
```

Each diagnostic contains `severity`, `code`, `page`, `section`, `line`, and
`message`. Errors use `wiki_link_missing`, `wiki_link_ambiguous`,
`child_navigation`, `mermaid_node_limit`, `mermaid_label_length`,
`mermaid_implementation_detail`, `mermaid_edge_ellipsis`, `mermaid_color`,
`boundary_conservation`, `gate_missing_field`, `gate_counterexample`, or
`page_content`. Warnings use `wiki_link_in_fence` or
`mermaid_topology_unchecked`. Output is sorted by page, line, code and message.

Lint's exit codes are **0** when `error_count == 0` (warnings allowed), **1** for
blocking diagnostics or any request failure (including HTTP 4xx), and **2** for
invalid arguments or local input. Request/input failures print their explanation
to stderr without a partial JSON result. Lint makes no writes and introduces no
validation gate into `create` or `write`; incomplete drafts remain saveable.
