# Feishu / Lark private chat discovery (OL-75)

An incoming private message can identify a conversation for human confirmation.
Discovery neither grants invocation nor replays the rejected message after
confirmation. The next message uses the existing conversation, task-token and
live grant-revocation checks. OL-12 chat-only behavior is preserved.

## Read and confirm

Prefix: `/api/workspaces/{workspace_uuid}/lark/installations/{installation_uuid}`.
Use the installation UUID from the existing installation list and the matching
`X-Workspace-ID` header. Browser sessions and human PATs use the existing auth
middleware. No endpoint accepts an app ID as an installation UUID.

| Method / suffix | Body | Result |
| --- | --- | --- |
| `GET /private-chat-candidates` | none; no paging or search parameters | `candidate_list` |
| `POST /private-chat-candidates/confirm` | `confirm_request` | existing `conversation_response` |
| `PUT /conversation` (existing) | `{scope:"workspace",chats:[...]}` | replaces the whole authorized list; empty list revokes |

Reading requires a human workspace member who can manage the bound agent:
agent owner or workspace owner/admin, matching OL-72. Confirmation additionally
requires that human to be able to invoke the agent. Administration alone never
permits invoking someone else's private agent. Task tokens and cloud agent PATs
cannot read or confirm, even with their runtime owner's user ID. Every request
checks workspace, installation and agent; revoked installations and archived
agents cannot supply candidates or accept confirmation.

All responses are `Cache-Control: no-store`. The existing member-visible
installation inventory does not expose candidate metadata. Listing candidates
may prune expired metadata and perform one optional contact-name lookup; it
never fetches private message bodies, sends messages or changes consent.

```json
{
  "items":[{
    "id":"01994566-7cc0-7000-8000-000000000001",
    "chat_id":"oc_private_alice",
    "chat_type":"p2p",
    "sender":{"type":"user","id":"ou_alice","id_type":"open_id"},
    "display_name":"Alice",
    "identity_status":"name_available",
    "authorization_status":"pending",
    "first_seen_at":"2026-09-13T12:00:00Z",
    "last_seen_at":"2026-09-13T12:00:00Z",
    "expires_at":"2026-09-20T12:00:00Z"
  }],
  "max_candidates":50,
  "retention_seconds":604800
}
```

`id` is an opaque server-issued candidate UUID, scoped to its installation.
`chat_id` is the actual event's `oc_`; `sender.id` is its separate app-scoped
`ou_`. Never substitute one for the other or treat either as a platform member.
Use the candidate UUID for confirmation and `(installation_id, chat_id)` for
conversation identity. The normal joined-group API is not a private-chat index.

Names are optional plain text, limited to 100 Unicode characters with
whitespace/control/format characters normalized. `identity_status` is
`name_available` only for a nonempty name returned for that exact open ID by
the contact API; otherwise it is `id_only` and `display_name` is empty. Show the
available name, sender/chat ID suffixes expandable to full IDs, and last-seen
time. Equal names remain distinct. Do not silently select an ID-only candidate
when the human cannot recognize it; have the intended person send a fresh
message and correlate the resulting ID/time. Message text, mentions and local
account names are never identity evidence for the picker.

`authorization_status` is `pending` or `authorized`, derived from membership in
the currently saved conversation grant. It describes saved consent, not current
provider reachability or the grantor's live invocation rights. The latter still
apply on inbound messages, task admission, tools and replies. Expiration removes
the observation, not a separately saved grant. Removing a chat from the grant
may expose its still-valid observation as pending again; it never reauthorizes
the chat automatically.

## Explicit save and revocation

```json
{"scope":"workspace","candidate_ids":["01994566-7cc0-7000-8000-000000000001"]}
```

Confirm 1–50 distinct candidate UUIDs in one request. The server resolves every
UUID against this installation's unexpired candidates, then atomically unions
their p2p targets with all saved group/private targets. At most **50 total
authorized conversations** remain allowed. Any unavailable candidate, permission
failure or limit violation rejects the entire operation. It never silently
evicts saved targets to make room or accepts a client-provided sender/chat pair.

A changed grant receives a new consent UUID and the current authenticated human
as `authorized_by`, covering the resulting full list. The confirmation UI must
explain this workspace-scoped permission and the retained targets before save.
Old consent epochs do not inherit the new grant. Repeating a confirmation while
its candidates are valid and all targets already belong to this same human's
grant returns that grant without changing its ID. After expiration, an old
confirmation may instead return 410; inspect the saved grant before retrying.

Remove authorized chats using the existing full-list `PUT /conversation`;
`{"scope":"workspace","chats":[]}` revokes all. Revocation still works for a
manager without invocation rights. As before, full-list saves represent a
complete replacement, so the client must refresh current saved state before
editing it. Confirmation and full-list saves serialize with candidate writes,
installation revocation and reinstallation. Neither discovery nor confirmation
replays queued rejected inputs. A fresh user message is required to start work.

## Collection, privacy and retention

The production path is authenticated outbound WebSocket → event decoder →
connection-bound app/tenant validation and installation-ID stamping → normalizer
→ current installation lookup → existing message-ID dedup claim → conversation
authorization → candidate observation on denial. No public candidate-create API
exists. A delayed connection cannot follow its app ID to a different installation.

Only `im.message.receive_v1`, `chat_type=p2p`, `sender_type=user` and valid,
consistent `oc_`/`ou_`/`om_` IDs qualify. Missing source metadata, normalized/raw
mismatches, bot senders, groups, inactive installations and archived/missing
agents produce no candidates. Candidate collection does not require sender-to-
member binding and never grants one. A previously saved target denied because
its grantor lost rights does not create a new observation to repair its grant.

Reuse `channel_installation.config.private_chat_candidates`: each observation
stores only candidate UUID, chat ID, sender open ID, first and latest event
timestamps. No message body/ID, event ID, tenant key, union ID, email, avatar or
contact name is added to this metadata. Existing body-free drop audits and
message dedup tombstones retain their existing independent lifecycle.

- Maximum 50 observations per installation, including currently authorized
  observations. New arrivals evict the least recent observations, never grants.
- One observation per private chat. Distinct later messages update the timestamp;
  retries and older messages cannot extend it. A changed sender for the same
  still-valid chat is ignored rather than relabeling a previously seen object.
- Validity ends 7 days after the latest qualifying provider message timestamp.
  Old events are ignored; timestamps more than 5 minutes ahead of the server
  are ignored. Accepted clock skew uses the provider timestamp consistently.
- Expired entries are excluded on every read and confirmation, and physically
  pruned on list reads and subsequent observation writes. There is no background
  deletion timer: an idle installation can retain up to 50 expired metadata rows
  in its JSON until touched. Revocation clears the key; reinstallation replaces
  the config; installation/workspace deletion removes it with the parent row.

Observation writes patch only their JSON key, preserving credentials and grants.
They do not change the connection fingerprint or restart the bot. Per-installation
row locking and a bounded in-memory sort avoid new indexes, queues or sweepers.
Reassess this storage choice only if measured per-bot contention justifies a
separate candidate table. There is no database schema migration.

## Capabilities, errors and compatibility

The OL-72 `GET /target-capabilities` response adds:

```json
{"private_chat_candidates_supported":true,"private_chat_identity_lookup_supported":true,"max_private_chat_candidates":50,"private_chat_candidate_retention_seconds":604800}
```

These describe implemented/configured services. `scope_status` remains
`not_checked`; the booleans cannot prove event subscription, provider scopes,
bot availability or contact visibility. A stub contact client can still list
local observations, with `id_only` names. An empty list can mean no qualifying
event, expiry/eviction/reinstallation, or that messages never reached the bot;
it is not evidence of complete private-chat enumeration.

Errors use the existing `{error,code}` envelope. Existing auth/router/member,
UUID-validation, generic management-denial and internal-DB errors may retain
`{error}` without `code`.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `lark_conversation_invalid_request` | Invalid JSON/scope/list; invalid/duplicate candidate ID or mixed manual targets |
| 403 | `lark_discovery_forbidden` | Human management access required |
| 403 | `lark_conversation_invocation_denied` | Confirming human cannot invoke the bound agent |
| 404 | `lark_installation_not_found` | Unknown/cross-workspace installation |
| 409 | `lark_installation_inactive` | Installation revoked/changed or agent archived |
| 409 | `lark_conversation_limit_exceeded` | Union would exceed 50 saved targets; remove a target explicitly |
| 410 | `lark_private_chat_candidate_unavailable` | Expired/evicted/unknown/wrong-installation candidate; refresh |
| 503 | `lark_discovery_unsupported` | Installation service not configured (read/capability path) |

Optional contact lookup failures (including permission denial, omitted users,
rate limits, timeout and malformed responses) retain HTTP 200 observations with
`id_only`; no raw provider error, token or unnecessary contact field is returned.

Older clients can continue using the existing installation and full-list grant
APIs. Newly added fields are additive; older servers may omit capability fields
or return 404 for these routes. The successor frontend must use schema parsing,
explicit `=== true` checks, defaults for unknown states, and refresh on stale
candidate errors. Keep selection local until explicit save. Do not turn a 403
into an unguarded raw-ID fallback. The manual grant API remains compatible for
independently known `oc_` targets; it does not claim to validate a candidate's
freshness. Group/anchor discovery and delivery approvals are unchanged.

Rolling back the binary requires no DDL. Rollback restores older handlers that
ignore the new JSON key. Existing saved grants remain valid under their ordinary
contract. To remove observational data as part of an authorized rollback, use
`UPDATE channel_installation SET config=config-'private_chat_candidates' WHERE
channel_type='feishu'`; this does not revoke grants. Clear the key before running
an older binary if its full-config fingerprint must avoid a one-time reconnect.
No production migration, cleanup command or deployment was performed here.

## Provider evidence and validation

Checked 2026-09-13 against official documentation, including its linked Markdown
representations. Feishu requires bot capability, the receive-message event
subscription and `im:message.p2p_msg:readonly` (or legacy `im:message.p2p_msg`) for
user-to-bot private events. The event contains IDs/types, not a sender display
name; dedup must use `message_id` because event IDs can differ for a duplicate.
[Feishu receive event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive),
[Lark receive event](https://open.larksuite.com/document/server-docs/im-v1/message/events/receive).

Names reuse the production `BatchGetUsers` transport:
`GET /open-apis/contact/v3/users/batch?user_id_type=open_id&user_ids=ou_...`
with this installation's tenant token and stored Feishu/Lark region. The maximum
is 50 user IDs. The listed API scope is `contact:contact.base:readonly`; `name`
also requires one of its documented field scopes, such as
`contact:user.base:readonly`. Users outside the app's contact data range can be
omitted. Message reachability therefore does not promise readable names, notably
for external users. The implementation discards other contact fields.
[Feishu batch users](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/batch),
[Lark batch users](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/batch).

Wire schemas and examples: `../integrations/lark/private-chat-discovery.schema.json`
and `../integrations/lark/testdata/private-chat-discovery-examples.json`. Backend
acceptance tests in `handler/lark_private_chat_discovery_test.go` exercise real
PostgreSQL, production decode/normalize/dedup/consent, the actual HTTP adapter
against a hermetic provider, malformed/denied name responses, cross-scope and
machine denials, concurrent bounds/confirmation, expiry, revoke/reinstall and
lost commit acknowledgements. Connection-source/fingerprint regression tests
are in `integrations/lark/private_chat_source_test.go`.

There are no live Feishu/Lark tenant credentials in this task environment.
Real tenant event delivery, contact scopes/ranges and external-user names remain
unverified; the tests establish protocol and backend behavior, not live account
access. Before tenant acceptance, send a fresh private message, inspect the
candidate, confirm it, send another message, revoke, and verify no later run.
Repeat with a user outside contact visibility and with a second bot/workspace.

No new bot-side notice was introduced. The existing refusal remains; the frontend
successor supplies en/zh-Hans/ja/ko copy for candidate states and stable errors.
