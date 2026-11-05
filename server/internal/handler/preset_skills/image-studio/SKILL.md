---
name: image-studio
description: Generate or edit images through the Labrastro runtime pool using multica media. Use for text-to-image requests or reference-image edits with Codex (GPT Image 2 / 2.5) or Antigravity (Nano Banana 2 / Pro) subscriptions, returning workspace attachment receipts.
---

# Image studio

Use the installed `multica` CLI and the task's injected platform authentication.
The server selects an authorized subscription host; provider credentials and
native execution stay on that host. This skill has no configuration, credentials,
host addresses, or helper service.

## Generate or edit

Write longer prompts to a UTF-8 file in the current workdir. Describe the image
and, for edits, what should change and what should be preserved.

```sh
multica media generate --capability image-generate --provider auto \
  --prompt-file ./prompt.txt --output json
multica media generate --capability image-edit --provider codex \
  --prompt-file ./prompt.txt --input subject=./reference.png --output json
multica media generate --capability image-edit --provider agy \
  --prompt-file ./prompt.txt --input-attachment subject=<attachment-id> --output json
```

### Provider & native model mapping

Users often specify the image model name rather than the CLI provider flag. Map
their request to `--provider` based on the actual host execution chain:

| CLI `--provider` | Host capability & native execution chain | Actual underlying image models & user mentions |
| --- | --- | --- |
| `--provider auto` (default) | Server ranks online `codex` and `agy` hosts by `plan_quota` | Used when the user does not specify a model or provider |
| `--provider codex` | `media-image-codex-v1`: `codex app-server` native `imageGeneration` tool | **Codex** native default image model: **`GPT Image 2`** (`gpt-image-2`) / **`GPT Image 2.5`** (`GPT Image`) |
| `--provider agy` | `media-image-agy-v1`: `agy` built-in `image-generator` subagent -> `generate_image` tool | **Antigravity (`agy`)** native image models: **`Nano Banana 2`** (`gemini-nano-banana-2.1`), **`Nano Banana Pro`** (`nano-banana-pro-preview`), **`gemini-2.5-flash-image`** (`Nano Banana` / `nanobanana`) |

- Default to `--provider auto`; honor an explicit `codex` or `agy` choice (including
  when the user names a corresponding image model from the table above). The
  server handles quota ranking and definite 429 failover. Do not resubmit a job
  to perform your own provider rotation.
- Omit `--model`: Codex `app-server` `imageGeneration` uses the subscription's
  native default image model (`gpt-image-2` / `GPT Image 2.5`) without a model
  selector, and `agy` CLI `--model` only controls the outer reasoning model while
  its built-in `image-generator` (`generate_image`) uses its native Nano Banana
  image models. `multica media generate` rejects `--model`; select the model
  family strictly via `--provider codex|agy`. `--size` and `--aspect` are prompt
  instructions, not exact pixel guarantees.
- Host-independent routing: `--provider` dispatches to an authorized subscription
  host in the workspace pool regardless of which conversation model or runtime
  you are currently running on. Even if your own runtime has a local
  `image-generator` subagent, use `multica media generate` with the requested
  `--provider` so explicit model/provider choices and workspace attachment
  receipts are honored.
- `image-edit` requires at least one reference. Prefer `--input-attachment` for
  images already in the workspace; `--input` uploads a local reference once.
  Both flags are repeatable (up to 16 total); optional roles are `input`,
  `subject`, `scene`, and `style`.
- Inside a task, the server derives the task/issue/chat binding from the token.
  Outside a task, use `--issue <issue-id>` when an issue attachment is needed.

## Wait and deliver

`generate` waits for completion by default. For explicit job management,
`--async` returns a queued job ID; collect its result in the same run:

```sh
multica media job get <job-id> --output json
multica media job wait <job-id> --output json
multica media job cancel <job-id> --output json
```

Only `state == completed` with an `attachment_id` and `markdown` is a successful
delivery. Return the job ID, attachment ID and the returned Markdown image card
verbatim; `markdown_url` is the durable download link. A queued/running job is
still pending. On failed/cancelled jobs, report the state and error; after a wait
or connection error, inspect the existing job rather than submitting again.
Do not end a run while its requested generation is still pending.

Without `--out`, the caller receives metadata only. Do not download and re-upload
the generated image to deliver it. When a local file is needed for implementation
or inspection, download the existing result with
`multica media job wait <job-id> --out ./result.png --output json` (or add `--out`
to a synchronous `generate`). `--async` and `--out` cannot be combined.

Host upload retries reuse the generated file without rerunning the model. A
terminal failure or unknown submission outcome is not permission to create
duplicate paid work. Report the known job/error and resolve that outcome first.
If the CLI lacks `media`, or no eligible host is available, report that concrete
availability problem; do not copy provider logins or install a browser bridge.
