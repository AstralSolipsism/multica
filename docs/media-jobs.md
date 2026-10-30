# Media jobs

Stage 1 provides the shared scheduler, transfer path and CLI. Native adapters
plug into `daemon.Config.MediaExecutor(provider, profileID)` in Stage 2. A nil
or unavailable adapter advertises no media capability; installing an agent CLI
alone does not claim native image/video support.

## Request and receipt

```sh
multica media generate --capability image-generate --provider auto \
  --prompt 'A red lighthouse at dusk' --output json
multica media generate --capability image-edit --provider codex \
  --prompt-file ./prompt.txt --input subject=./photo.png --out ./result.png
multica media generate --capability video-generate --provider flow \
  --prompt 'Clouds over a mountain' --duration 8 --aspect 16:9 --async
multica media job get <job-id> --output json
multica media job wait <job-id> --out ./result.mp4
multica media job cancel <job-id>
```

`--input` and `--input-attachment` are repeatable; optional roles are `input`,
`subject`, `scene`, and `style`. `--model`, `--size`, `--aspect` and `--duration`
are passed to the adapter, which validates native combinations. `--issue`
binds a member-created job to an issue. Inside a task, the server derives and
locks the producing task, issue, chat session and actor from the task token.
A task cannot override this binding.

The default command polls until terminal. Without `--out`, **no output binary
is downloaded**: the response contains `attachment_id`, durable `markdown_url`
and ready-to-paste `markdown`. `--out` streams to a temporary sibling file and
renames after a complete download. `--async` returns the job immediately and
cannot be combined with `--out`.

## Scheduler and adapter contract

There is one `media_job` table. Migrations are `9035_labrastro_media_job`,
`9036_labrastro_media_job_identity_index`, `9037_labrastro_media_job_queue_index`
and `9038_labrastro_media_job_running_index`. No executor, attempt, upload-part,
profile-lock or cache tables are introduced. `attempt` is a single current
assignment UUID on the job, used to reject stale receipts.

States are `queued → running → completed/failed/cancelled`; a definite provider
429 returns the same job to `queued`. Each runtime has at most one running
media job. Claims lock the runtime and queued job and use the existing runtime
owner/public/shared-with rules. Workspace membership is required. Eligible
runtimes must be online, carry a matching per-runtime capability and not be
cooling. Header-level `media-*` capabilities are discarded.

| Runtime provider | Tag | Operations |
| --- | --- | --- |
| codex | media-image-codex-v1 | image-generate, image-edit |
| antigravity (`--provider agy`) | media-image-agy-v1 | image-generate, image-edit |
| flow | media-video-flow-v1 | video-generate |
| whisk | media-image-whisk-v1 | image-remix |

Rank uses the minimum remaining percentage across applicable active quota
windows. Exhausted windows are excluded; agy uses the Gemini pool, not the
Claude/GPT pool. Unknown quota ranks below measured capacity. Expired windows
are ignored. `auto` can cross providers with the same operation. A typed
`media.RateLimitError` cools that runtime/tag in `agent_runtime.metadata` until
Retry-After, the next relevant quota reset, or a one-minute fallback. Registration
preserves these server-owned cooldowns. A job permits at most 32 explicit quota
retries and has a 30-minute deadline, enforced on claims, reads and transfers.

`media.Executor.Submit` receives downloaded inputs and a private job directory;
it writes its artifact inside that directory and honors context cancellation.
Submit is called once per assignment. After generation, only HTTP upload of the
same file is retried, up to three total attempts. The upload is idempotent per
job/attempt, including a lost response after storage commit. Local files are
removed on return. Cancellation is observed within the worker's three-second
status interval and prevents later output/receipts from reviving the job.

Claims and receipts use negotiated `rpc-v1` (`media.claim`, `media.result`), with
HTTP fallback only when a WS request was not sent. Parameters, input attachment
IDs and a scoped, expiring `mjt_` token travel over RPC. Binary data never does.
An ambiguous claim or daemon crash is not automatically replayed against a
model: the job expires failed. This stage intentionally has no durable native
execution recovery or resumable upload ledger.

## HTTP and storage

- User/task auth: `POST /api/media/jobs`, `GET /api/media/jobs/{id}`,
  `POST /api/media/jobs/{id}/cancel`. Read/cancel is restricted to the caller;
  task credentials additionally require the same originating task.
- Daemon auth: `POST /api/daemon/media/claim`, `POST /api/daemon/media/result`.
  WS calls must name a runtime in the authenticated connection's runtime set.
- Job token: `GET /api/media/jobs/{id}/inputs/{attachmentID}`,
  `GET /api/media/jobs/{id}/status`, `POST /api/media/jobs/{id}/output?filename=...`.
  Tokens authorize only declared inputs and one output for the current attempt,
  not ordinary account APIs. Revoked runtime consent/ownership stops transfers.

Output is a fixed-length raw HTTP body, sniffed as image/video, up to 1 GiB.
Local and S3 use their existing `UploadStream` implementations. The ordinary
multipart `/api/upload-file` endpoint now streams from a bounded-memory multipart
spool; `?media=1` opts into the 1 GiB file limit for media inputs. Existing uploads
retain the 100 MiB limit. Deployment proxies must permit the desired request size.
External-channel task credentials retain their existing default-deny route
policy for the new media commands.

## Verification

The integration fixture uses PostgreSQL, a real WebSocket hub, a fake Executor
and Local storage. It streams a 110 MiB output, injects an upload failure and a
lost committed-upload response, checks one Submit / three uploads / one output
attachment, observes heartbeat acknowledgements during transfer, and verifies
receipt-only versus explicit streamed download behavior. Separate tests cover
quota selection, permission boundaries, stale receipts, cancellation, task and
issue binding, CLI validation, migrations/rollback and S3's streaming contract.
No real provider login or generation is needed for these checks.
