# Project baseline CLI

`multica project baseline` implements Strixnova contract v3.1 section 7 using
the engineering API. The four chapter keys are `overview`, `domain_rules`,
`architecture`, and `exclusions_and_risks`.

```sh
multica project baseline get <project-id>
multica project baseline get <project-id> --chapter domain_rules
multica project baseline get <project-id> --chapter domain_rules --candidate --output json
multica project baseline get <project-id> --revision domain_rules:3 --output markdown

multica project baseline propose <project-id> --chapter domain_rules \
  --content-file ./rules.md --summary "Clarify settlement rules" --base 3
multica project baseline diff <project-id> --chapter domain_rules
multica project baseline diff <project-id> --chapter domain_rules --from 3 --to 4
multica project baseline adopt <project-id> --revision domain_rules:4
multica project baseline adopt <project-id> --revision domain_rules:4 --reject
multica project baseline export <project-id> --dir ./docs/baseline --output json
```

`get` defaults to chapter summaries. A selected chapter, a historical revision,
or `--output markdown` includes the Markdown body. `--candidate` selects current
candidates. Historical lookup is bounded and requires an exact chapter/version
match; a missing version reports `404 not_found` with exit code 2. JSON reads
return `engineering` and `chapters: [{chapter, revision}]`; `revision` is null
for a chapter without the selected version. Revision JSON retains server audit
fields. Historical reads return `engineering: null`.

`propose` requires a UTF-8 file under the current working directory, at most
64 KiB. Traversal and symlinks escaping that directory are rejected. A summary
is required and limited to 500 Unicode characters. With an existing adopted
version, specify `--base <number>` or explicitly choose `--base-current`.
Without either, only a first revision can be proposed. An existing candidate
requires `--replaces <number>`; inspect it before replacing. Optional
`--source-issue` accepts an issue identifier or UUID. These references are
resolved to IDs for the API; writes are never retried automatically.

`propose` and `diff` display server-computed anchor changes. Text output prints
each changed anchor's before/after body with line prefixes. It does not compute
another Diff or infer semantic warnings from words such as MUST/SHOULD. Server
warnings `rule_removed`, `rule_shrunk`, and `rule_deferred` print
`[RULE DOWNGRADE WARNING]` on stderr. `defer_missing_pool` and future warning
codes print `[BASELINE WARNING]`. JSON retains structured changes and warnings.
Candidate Diff JSON is `{diffs: [...]}`; historical Diff and proposal JSON are
the corresponding server objects.

`adopt` requires one to four explicit `--revision chapter:number` values, with
each chapter selected once. The CLI resolves those exact historical versions
and sends their stored `base_revision_id` as `expected_adopted_revision_id` in
one decision request. It never replaces the selected version with the current
candidate or refreshes the expected base. A concurrently replaced candidate or
changed base is rejected by the server. `--reject` uses the same selection and
atomic decision endpoint with `action=reject`.

Authorization remains with the server. Members must be deciders; task tokens
may decide only when `agent_decisions_enabled` permits it, and adopting rule
cuts still requires a human. `baseline_human_required` and
`baseline_rule_cut_needs_human` print a human review instruction and the project
engineering URL with the selected candidate. The URL uses `MULTICA_APP_URL`,
`FRONTEND_ORIGIN`, or the profile's app URL, falling back to the configured
server URL. Separate frontend/API installations should configure the app URL.
The CLI uses its normal credential resolver and never switches credentials.

Successful decision text prints Diff summaries followed by `open_issues` in
the server's `in_flight`/`queued` groups, including custom statuses and a
truncation notice. Decision JSON preserves the full server response. There is
no approval-comment proof or candidate UUID flag: the v3.1 decision API uses
explicit chapter versions and authenticated decider/delegation checks.

`export` writes only adopted versions to `01-overview.md`, `02-domain-rules.md`,
`03-architecture.md`, and `04-exclusions-and-risks.md`. Empty chapters have an
explicit unadopted marker. `--single-file ./PROJECT_BASELINE.md` combines all four
chapters and is mutually exclusive with `--dir`. Headers contain revision
numbers and adoption times, never audit UUIDs. Files are read-only snapshots;
edits must be proposed through the API to affect the baseline. Each file is
replaced atomically; a filesystem failure can leave earlier files updated.
Existing non-regular targets, including symlinks, are rejected. JSON output
lists exported paths, while completion notices go to stderr.

All five commands support `--output json`; text (or table) is the default.
Failures write only to stderr, without echoing baseline bodies even under
`--debug`. Exit codes are 0 for success, 1 for business/transport failures
(including 403/409/422), and 2 for invalid parameters or missing resources.
Other CLI commands retain their existing exit conventions.
