# `multica project baseline` — baseline wiki CLI

OL-1329 turns the baseline CLI into the write surface for the tree wiki.
Humans and agents share identical permissions; every write except `create`
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
| `annotations` / `respond` | retired with the annotation batches; wiki comments arrive in a follow-up release |

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
