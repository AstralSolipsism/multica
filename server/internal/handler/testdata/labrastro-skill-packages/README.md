# Pinned skill source fixtures

These offline fixtures preserve GitHub tree metadata (including mode/SHA) and
text bodies from two public MIT-licensed repositories. They are test inputs,
not installed skills. Tests never execute their scripts or resolve live refs.

| Fixture | Commit | Root tree | Expected scan |
|---|---|---|---|
| `mattpocock.json.gz` | `d81f3a183412e71a5b1e84ca21bc1a35eea03a60` | `b9814f871fb63e6b40b1e82017c363b59075e81c` | 37 candidates, 27 manifest defaults |
| `addyosmani.json.gz` | `9d0c60d406b454a78ccc0a175b19932047aa4dac` | `9adbe6dc3bed0df3ce67a445fc9013255cb73671` | 25 candidates/defaults, 11 with shared references |

Sources:

- <https://github.com/mattpocock/skills/tree/d81f3a183412e71a5b1e84ca21bc1a35eea03a60>
- <https://github.com/addyosmani/agent-skills/tree/9d0c60d406b454a78ccc0a175b19932047aa4dac>

`mattpocock.LICENSE` and `addyosmani.LICENSE` reproduce the source notices;
the original `LICENSE` body is also present in each fixture's file map.

To reproduce a snapshot, fetch `repos/<owner>/<repo>/git/trees/<commit>?recursive=1`
and the commit archive using `gh api`, then construct the JSON object:
`{owner,repo,commit,tree_sha,tree,files}`. Keep the entire tree array. For `files`,
keep regular UTF-8 files of at most 1 MiB, without NUL bytes, under `skills/`,
`references/`, plus `.claude-plugin/plugin.json` and `LICENSE`; do not follow
symlinks. Use sorted JSON keys and gzip `mtime=0`. Counts at live branches are
not assertions about these fixed commits. Updating the commit requires an
explicit review of changed candidate/default/reference expectations.

Run the reproducible offline scan and working-set observation with:

```sh
cd server
go test ./internal/handler -run '^TestLabrastroPinnedSourceFixtures$' -count=1 -v
```

The fake transport simulates 1 ms per request. The test logs source request
count, peak concurrent requests, retained cache bytes, largest completed bundle,
total allocations, a heap-delta sample every 1 ms, and elapsed time. Heap samples
include other process activity and are not a production capacity estimate.
`TestLabrastroSourceFailureAndTimeout` uses a 1 ms context with a 1 s transport
delay to verify cancellation, alongside truncated-tree and required-file failures.
