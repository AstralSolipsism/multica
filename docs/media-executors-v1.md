# Media executor v1 baseline

OL-1124 introduces the storage and discovery boundary for the media workstream
in OL-1116. **The native host proof is still outstanding. This baseline is not a
working image/video generation feature and must not be accepted as the completed
Stage 1 deliverable.**

## Identity and discovery

A machine keeps its existing daemon UUID. Each native executor in each Multica
profile gets a persistent random executor UUID. A canonical credential directory
gets a separate random credential scope UUID; neither identity derives from an
account name or token. Symlink aliases converge on the same credential scope and
OS file lock. Flow and Whisk use one browser directory and therefore one scope.
Nothing copies credentials out of the default profile.

Registration and both heartbeat transports carry `media_executors`, a complete
inventory for one process connection on one runtime. The server validates the
provider/capability pair, descriptor version, model metadata, readiness and quota
mapping. HTTP header media capability tags are discarded. Only ready instances
contribute native capability tags to runtime metadata. The authoritative table,
not that UI projection, decides whether a connection lease is live.

A connection has a 90-second lease. Registration can reclaim an expired lease;
heartbeat cannot claim a new instance or another process's lease. Reports only
revoke omitted instances owned by their own connection. Shutdown revokes only
that process; another live profile keeps the shared runtime online. Registration preserves
reservations, cooldown and unfinished attempts. Quota updates use the existing
newer-wins and 300-second freshness-only throttle. A changed applicable-window
mapping clears the old observation. Unknown media quota never inherits coding
quota automatically.

The daemon uses a dedicated `provider=media` runtime with `metadata.kind=media`.
A provisioned media profile permits startup without a coding CLI. Media runtimes
heartbeat normally, are excluded from ordinary agent claim batches and binding
selectors, and cannot pass the agent readiness gate. Runtime visibility and
owner consent still apply to media candidates; workspace administration does
not grant use of another owner's private runtime.

## Profiles and native contract status

Named storage is under `.multica/profiles/<name>/media/native/`. Codex uses its
own directory, and Flow/Whisk share `google-browser`. The default Codex profile
respects `CODEX_HOME` or the native `.codex` directory. Profile names reject path
separators and traversal. Executor identity files live under `media/executors/`.

`multica --profile sub02 media login --provider codex [--device-auth]` invokes
native `codex login` with isolated file credential storage and ChatGPT login.
It removes ambient API/access-token authentication overrides from the child
process. It does not execute login on behalf of an agent task. These controls
follow the [official authentication documentation](https://learn.chatgpt.com/docs/auth)
and [state directory contract](https://learn.chatgpt.com/docs/config-file/environment-variables).
The command was tested with a fixture executable, not with a real account.

The production discovery registry deliberately has no verified native factories
installed yet. Existing directories report `unsupported/native_contract_unverified`,
never ready. The registry accepts injected executors for unit tests, which prove
that `needs_auth` and resource-lock failures revoke ready on the next refresh.
Those tests do not establish native logout detection or token refresh safety.
Native probes run outside the heartbeat worker on a 10-second cycle.

Remaining host-dependent work, required before Stage 1 acceptance:

| Provider | Evidence and implementation still required |
| --- | --- |
| codex | Subscription-native direct GPT Image 2.5 primitive/model ID, edit inputs, result recovery, artifact extraction, quota window applicability, and refresh coordination with existing coding processes. The media file lock alone does not coordinate a native Codex token refresher. |
| agy | Actual installed `image-generator` invocation, model flags for Nano Banana 2/Pro, supported isolated login/credential-store mapping, operation/artifact identity and internal retry observations. No `agy image-generator` command is invented. |
| flow | Native browser/CDP login mapping, local browser profile ownership, Veo 3.1 operation creation/recovery, inputs, artifacts and applicable quota windows. |
| whisk | Flow-backed subject/scene/style multi-image semantics and the same recovery/credential scope; report `resolved_provider=flow` and the actual model. |

The agy/Flow/Whisk login commands fail explicitly until their native mapping is
verified. Default agy discovery is not guessed from an undocumented directory.
A target-host access method and two independently authenticated profiles are
needed to verify these contracts. Do not mark a provider ready based on a login
file, advertised model name, fixture, or generic CLI installation.

## Wire and storage boundaries

Shared wire types are in `server/pkg/protocol/media.go`; the seven-method native
interface is in `server/internal/daemon/media/executor.go`. `Submit` reports
`not_submitted`, `accepted` or `unknown`; recovery must not resubmit an ambiguous
operation. Inputs retain their ordered roles and hashes. Artifacts stay local
until HTTP transfer; local paths are absent from wire descriptors.

Typed media RPC messages are bounded to 4 KiB by `MarshalMediaControl`. Prompts,
input lists and output manifests belong on authenticated HTTP. The job state
machine/RPC dispatch, data-plane handlers and upload engine are subsequent
workstream stages; defining their types does not advertise implementation.
`media-jobs-v1` currently negotiates the executor report schema; no ready native
executor can enter the job pool in this baseline.

The additive migration is `9035_labrastro_media_baseline`. Independent concurrent
index migrations are `9036_labrastro_media_executor_identity_index` through
`9051_labrastro_attachment_upload_part_index`, registered in the fork recovery
catalog. There are no new foreign keys. Old attachment hashes remain NULL until
verified content is read; no hash is invented during upgrade. Application-layer
job/upload transitions, dependency cleanup and finalization belong to the
subsequent Server/data-plane implementation.

## Verification

- `make sqlc` regenerates the storage model and queries.
- `go test -race ./pkg/protocol ./internal/daemon/media` covers invalid/false
  capabilities, bounded control messages, backend identity, independent profiles,
  stable IDs, aliases, an actual child-process lock conflict, and revocation.
- `go test ./internal/daemon -run TestDaemonMedia` checks report placement and
  recognition of a media-only host.
- `go test ./internal/handler -run TestMedia` requires the repository test DB.
  It checks reservation/unfinished-attempt retention, live/expired connection
  leases, profile-local revocation, stale quotas and private runtime consent.
- `go test ./internal/migrations -run TestMediaBaseline` requires PostgreSQL.
  It applies the complete media migration/index sequence to empty and populated
  attachment tables, checks indexes, then rolls back without losing old rows.
- `make test` uses the repository-managed environment. Missing Docker/PostgreSQL
  is a blocked integration run, not a passing result.

Native validation must record host, executable/browser version, actual model,
operation identity, output size/hash and applicable quota mapping, without
recording tokens, cookies, account identities or raw balances.
