# OL-40 validation record

Measured 2026-09-08 against the final graph implementation on the OL-39
baseline `15fc0209ab1c6c0ac1b61410e7d1f782353240a0`.

The OL-38 API budget passes for 1000 nodes / 4950 direct edges: p95 166.397 ms
(500 ms budget), 1.411 MiB uncompressed response (2 MiB budget), and maximum
38.20 MiB request allocation (64 MiB budget). All measured graphs returned the
exact seeded node IDs and source-edge IDs/endpoints with correct counts.

## Environment and method

- Linux amd64, Intel Xeon Platinum 8259CL 2.50 GHz; shared 96-logical-CPU host,
  no cgroup CPU or memory ceiling. This is not a dedicated production host.
- Go 1.27.1; PostgreSQL 15.19, all migrations through 466; Node 24.20.0;
  pnpm 10.28.2. CI uses its own Go 1.26 / PostgreSQL 17 environment.
- Isolated local database; synthetic data only. One workspace member, two
  projects plus unprojected issues, built-in statuses, no date filter or
  inactive runs. No real agent executables were used.
- pgxpool default configuration, established local connections, sequential
  requests, resident DB pages after fixture setup. First-request time is
  recorded separately; it is not a process/database cold-start result.
- Exactly 30 subsequent requests per sample, GC before each request; p95 is
  the 29th sorted observation. No response cache or graph cache.
- Timing includes the URL membership middleware, graph handler, SQL and JSON
  encoding. It excludes authentication, network, response decoding, fixture
  setup and browser layout/rendering.
- SELECT count includes one membership read plus seven snapshot reads;
  transaction control commands are excluded. Project/focus/filter/catalog
  lookups can add queries; this is the unfiltered built-in-status workspace case.
- Memory is the maximum process `TotalAlloc` delta over each measured request,
  including response encoding/buffering. It is a conservative allocation
  measure, not total RSS, retained heap, database memory or client memory.

## Prescribed shapes and larger probes

| Shape | Nodes / edges | SELECTs | First ms | p95 ms | JSON MiB | Max allocation MiB |
| --- | --- | --- | --- | --- | --- | --- |
| 100-wide | 100 / 90 | 8 | 15.226 | 11.895 | 0.074 | 1.40 |
| 100-chain | 100 / 99 | 8 | 9.359 | 9.457 | 0.076 | 1.33 |
| 100-dense | 100 / 450 | 8 | 16.144 | 18.386 | 0.134 | 3.35 |
| 100-hierarchy | 100 / 168 | 8 | 9.992 | 12.860 | 0.090 | 2.04 |
| 500-wide | 500 / 490 | 8 | 42.835 | 43.175 | 0.376 | 8.47 |
| 500-chain | 500 / 499 | 8 | 30.966 | 43.957 | 0.377 | 7.27 |
| 500-dense | 500 / 2450 | 8 | 71.170 | 90.345 | 0.701 | 18.69 |
| 500-hierarchy | 500 / 888 | 8 | 50.839 | 61.425 | 0.458 | 8.96 |
| 1000-wide | 1000 / 990 | 8 | 69.666 | 83.641 | 0.753 | 17.70 |
| 1000-chain | 1000 / 999 | 8 | 80.280 | 83.007 | 0.755 | 17.79 |
| 1000-dense | 1000 / 4950 | 8 | 152.698 | 166.397 | 1.411 | 38.20 |
| 1000-hierarchy | 1000 / 1788 | 8 | 107.368 | 115.850 | 0.918 | 18.86 |
| 5000-dense | 5000 / 24950 | 8 | 598.238 | 594.967 | 7.092 | 221.14 |
| 10000-dense | 10000 / 49950 | 8 | 1152.829 | 1214.996 | 14.194 | 363.10 |

The dense 5000/10000 probes also returned complete data. Their 221/363 MiB
allocations and 7/14 MiB payloads exceed the **1000-node** budget; this is not a
claim that the budget holds at all scales. The endpoint has no node cap and
returns diagnostic failures instead of truncation. Revisit compression,
allocation/encoding and a consistent chunk protocol if realistic larger-workspace
concurrency or transport measurements require them. UI layout and interaction
budgets remain OL-43/OL-45 work.

## Correctness and regression evidence

- The OL-38 reference returns exactly 14 workspace nodes / 7 stored edges;
  project P2 returns 6 matches + 5 external context nodes / 6 edges. Both
  unprojected/undated nodes remain present. Every graph dependency version
  matches its detail endpoint version, including inherited prerequisites.
- Tests cover shared filters/empty selections, locating a filtered issue,
  direct-edge direction, source provenance under legal bidirectional project
  collapse, hidden parent/prerequisite paths, cross-workspace references,
  URL-only requests and task-token workspace binding.
- A committed edit interleaved between snapshot reads changes status, parent,
  project and a relation: the in-flight response preserves its original
  snapshot; the next request sees all committed changes. Separate detail
  mismatches invalidate without patching topology.
- Actual queued/dispatched/running/waiting rows are distinguished from
  `in_progress`; completion of a run does not complete the Issue. Run-only
  changes preserve the topology version. Late query/commit failures and
  expired deadlines never produce partial success.
- API schema tests preserve unknown summaries, reject malformed/incomplete
  topology and expose unsupported/permission failures without list fallback.
  Actual realtime wiring tests cover relation/parent/project updates, task
  lifecycle, catalogs, auxiliary revisions and reconnect, preserving other
  workspace caches and excluding per-message streaming invalidation.
- The dependency model/service/handler and shared Issue Table suites pass
  under `go test -race`; the final graph suite passes after the URL/deadline
  tests. Targeted core tests: **114 passed across 6 files**. Core typecheck,
  changed-file ESLint, scoped Go vet, sqlc generation and diff checks pass.
  This is targeted validation, not a claim that every repository test ran.

Reproduction: use `scripts/go-test-with-agent-cli-guard.sh` with a migrated
isolated `DATABASE_URL`. Run `go test -race` in `server` for
`./internal/issuedependency ./internal/service ./internal/handler` with
`-run '^(TestIssueGraph|TestDependency|TestIssueTable|TestCanonicalIssueTable|TestListIssues_TableFacets|TestQueryIssues_PostTwin)'`.
Run `TestIssueGraphScale` with `ISSUE_GRAPH_BENCHMARK=1`; set
`ISSUE_GRAPH_BENCHMARK_PATH` to export the 30 raw durations for each shape.
The OL-40 issue delivery includes that JSON. See `docs/issue-graph-api.md`
for the frontend contract and synthetic response mock.
