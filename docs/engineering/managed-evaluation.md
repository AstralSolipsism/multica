# Managed evaluation from active tasks

OL-1223 owner decision `01a1af1b-6130-723f-be30-e13352edb255` approves a simple CLI with service-managed infrastructure. Scoring criteria belong to the calling skill; sources, endpoints, model selection and credentials belong to the daemon. No new service source or task environment passthrough is introduced.

## Contract

```sh
multica jev evaluate --input-file evaluation.json --output json
# Use --input-file - to read the same JSON from stdin.
```

```json
{
  "state": {"reader": "A reader seeing only this dialog", "dialog": "Product background and decision text"},
  "questions": {
    "clarity": {
      "type": "score",
      "instructions": "How much unexplained context does this reader need?",
      "criteria": ["None", "Minor", "Several unexplained references", "Missing product background"]
    }
  }
}
```

The input is at most 64 KiB. `state` is a JSON object or string; `questions` contains 1–16 named score questions. Each question needs nonempty instructions and 2–32 ordered nonempty criteria. Only these transport fields are accepted. There are no provider, URL, source, model or key parameters. Output format is `table` or `json`.

```json
{"ok":true,"answers":{"clarity":{"score":2}},"latency_ms":328,"daemon_version":"<runtime version>"}
```

Scores are raw numeric values in the inclusive range 0 to `criteria.length - 1`, including fractional values. The platform does not normalize scores or decide whether a card passes. For example, deck retains its own division by 3 and inclusive 0.685 rejection boundary.

A service failure returns JSON such as `{"ok":false,"reason":"timeout","latency_ms":1501,"daemon_version":"..."}` and a nonzero CLI exit code. Reasons are `disabled`, `breaker`, `timeout`, `invalid`, or `error`. Authentication, invalid input, incompatible daemons and transport failures also exit nonzero; they can have no JSON output. Absence of a score is never a score of zero.

## Identity and data flow

The CLI uses only the injected task token, task ID and loopback daemon port. It does not fall back to owner credentials, public server configuration or another profile, and does not follow redirects. The daemon's `POST /tasks/{task_id}/jev-evaluate` checks the existing active-task registry and matches the URL task ID to the credential. Missing, unknown, completed-task and wrong-task credentials fail before provider access. This has the same local trust boundary as repo checkout: someone who can steal a task token can impersonate that task; it is not OS-user isolation.

The daemon forwards state, questions and its configured model through its existing Jev client. Ordered sources, per-source deadlines, breaker and health accounting are shared with effort decisions. The endpoint has a 10-second overall deadline; the CLI allows 11 seconds for transport. Upstream responses are capped at 1 MiB and must contain valid scores for every requested question. Only numeric answers, latency, reason and daemon version reach the task; provider extras, response bodies and credentials are not returned or logged by this endpoint.

All supplied business text is sent to the daemon's existing configured providers. No source is enabled by this change. For deck, this includes each question's context, reader, brief and option text. Disk evidence is not sent independently, but text copied into those fields is included. Whether those configured providers are available is verified after deployment, not inferred from an empty task environment.

## Rollout and evidence

Both CLI and daemon must include this change. First review and merge the platform PR; then obtain approval for the concrete runtime upgrade. The skill PR may be reviewed in parallel but must remain unmerged until real evaluation is verified, as required by the owner’s selected sequential rollout. After upgrading, run the fixed positive and negative deck cases and retain requests, raw results/failures, elapsed time and versions. Then merge the skill PR. Unit tests use local fixed-response servers and do not establish scoring quality or production connectivity.

Only after real scoring verification may the approved five skills be published from reviewed main and recorded in the deployment ledger. Agent bindings remain untouched. Real Issue-page submit/host-confirmation and fill/draft-protection verification is a separate required check; local sandbox tests do not replace it.
