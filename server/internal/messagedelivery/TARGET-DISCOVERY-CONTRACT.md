# Feishu target discovery (OL-72)

Read-only APIs for delivery group, message-anchor and conversation-grant pickers.
Discovery does not save or approve targets. Existing source/project/issue/
automation scope, installation, group-reachability and message-belongs-to-group
checks remain on their save/send paths. OL-12 chat-only ingress is unchanged.

## Endpoints and authorization

Prefix: `/api/workspaces/{workspace_uuid}/lark/installations/{installation_uuid}`.
Use installation UUIDs from the existing installation list, not app/bot IDs.
Existing authenticated browser-session/human-PAT and workspace middleware apply;
send the corresponding `X-Workspace-ID` header.

| Method and suffix | Response schema | Query |
| --- | --- | --- |
| `GET /target-capabilities` | `capabilities` | none |
| `GET /chats` | `chats_page` | `page_size` (1–100, default 20), `q`, `cursor` |
| `GET /chats/{chat_id}/message-anchors` | `anchors_page` | `page_size` (1–50, default 20), `cursor` |

Caller must be a human workspace member AND workspace owner/admin or the bound
agent owner, matching installation/conversation management. Automation edit
access, public-agent invocation, target approval and workspace membership alone
do not grant bot-history read access. Task tokens and cloud agent PATs are
refused even if they carry their runtime owner's human identity. Installation
lookup is workspace-bound; missing agents, revoked installations and archived
agents are unusable. Every page repeats authorization.

Responses use `Cache-Control: no-store`. No DB writes, sends, contact lookups,
resource downloads, approval or conversation-grant mutations occur. A forbidden
picker should explain the management role required, not request raw IDs to
bypass it. Existing saved targets retain their existing API behavior.

## Capabilities

```json
{"chat_list_supported":true,"message_anchor_list_supported":true,"region":"feishu","scope_status":"not_checked","max_chat_page_size":100,"max_message_page_size":50}
```

Booleans describe the configured transport, not current provider permission
grants. Stub transport returns false; list calls then return 503. Provider
permissions are checked on real list calls. Missing installation service gives
503; inactive installation/agent gives 409. Forbidden users get 403 here too.
On older servers a 404 may mean the endpoint is unavailable; do not infer these
capabilities from `install_supported` or `conversation_supported`.

## Groups and name search

`q` is a trimmed, case-insensitive group-name substring, at most 100 Unicode
characters. It filters **one joined-groups provider page at a time**. Continue
while `has_more === true`, including empty filtered pages. “No matches” is only
known after pagination finishes. Changing the query starts a new sequence.
Public unjoined groups are never searched; dissolved groups are omitted.

```json
{"items":[
  {"chat_id":"oc_a","name":"Release","description":"Team A","avatar":"","external":false,"chat_status":"normal"},
  {"chat_id":"oc_b","name":"Release","description":"Team B","avatar":"","external":true,"chat_status":"normal"}
],"has_more":false,"next_cursor":""}
```

Identity is `(installation_id, chat_id)`. Show name plus description, available
avatar/external badge, and an ID suffix expandable to the full ID so even equal
names/descriptions are distinguishable. The user need not type an ID. Owner
identities and tenant keys are excluded. Missing/new status strings are retained;
they do not prove sending is allowed.

Sort is fixed at `ByCreateTimeAsc`; provider docs warn that activity ordering
can skip groups that move between pages. This is not an immutable snapshot:
bots may join/leave and groups may disappear. Deduplicate accumulated rows by ID.

## Message anchors

Selected group must have provider `chat_mode=group` or `topic`. P2p and limited
public-info responses fail closed. Each page checks group mode, then calls the
history endpoint which enforces current bot membership. A returned message
with a different chat ID rejects the whole page.

```json
{"items":[{"message_id":"om_new","chat_id":"oc_a","message_type":"text","summary":"release ready","create_time":"1700000000000","thread_id":"omt_topic","sender":{"type":"user","id":"ou_1","id_type":"open_id"}}],"has_more":false,"next_cursor":""}
```

`create_time` is an epoch **millisecond string**; localize for display. Order is
newest first (`ByCreateTimeDesc`). Selection uses stable `message_id`;
`thread_id` is optional. This uses the `chat` container: ordinary group topic
roots are included, not all nested topic replies. It is not a complete chat
transcript or text-search API. Deleted/recalled messages and forwarded children
are omitted without losing continuation. No messages gives `items: []`.

Text/post summaries reuse the flattener, replace inline mention names, collapse
whitespace/control characters, and keep at most 200 Unicode characters plus an
ellipsis. Media/cards use placeholders; unsupported or malformed content gives
`[Message]`. Render as plain text, not HTML/Markdown. No raw message body or
attachment keys are returned. Only provider-returned user `open_id` or app
`app_id` is exposed with its type. Anonymous/unknown senders have no identity
fields. No contact lookup or inferred platform-member identity/name occurs;
show the sender type and optional ID suffix. Selection may become stale and
cannot reserve a message; refresh on save/provider errors.

## Pagination and errors

`next_cursor` is an opaque, URL-safe signed continuation, valid for 30 minutes
from issuance and bound to workspace, installation, human caller, group/list
operation, normalized query and page size. Do not construct, transfer or store
it as target identity. App-secret rotation invalidates it. Upstream tokens are
forwarded unchanged and sort stays fixed. Each request fetches one page only.
`has_more=false` always has `next_cursor=""`; shorter/empty pages do not imply
completion. Expiration/provider rejection requires restarting from page one.

Errors use `{"error":"safe fallback text","code":"stable_code"}`. Generic
auth, router membership, UUID validation and internal DB errors may retain the
repository's existing `{"error":"..."}` envelope without `code`.

| HTTP | Code | Meaning / action |
| --- | --- | --- |
| 400 | `lark_discovery_invalid_request` | Invalid size/group/query, duplicate paging parameters or provider-rejected parameters |
| 400 | `lark_discovery_invalid_cursor` | Corrupt/expired/wrong-scope/provider-rejected cursor; restart |
| 403 | `lark_discovery_forbidden` | Human agent owner/workspace admin required |
| 403 | `lark_discovery_permission_denied` | Missing scope or external-group permission; repair app permissions |
| 404 | `lark_installation_not_found` | Unknown/cross-workspace installation or missing bound agent |
| 404 | `lark_discovery_chat_unavailable` | Invalid/unjoined/invisible group or p2p; select again |
| 409 | `lark_installation_inactive` | Revoked installation or archived agent |
| 410 | `lark_discovery_message_unavailable` | Provider reports deleted/recalled/invalid anchor; refresh |
| 429 | `lark_discovery_rate_limited` | Provider quota/rate limit; retry with backoff |
| 502 | `lark_discovery_invalid_response` | Malformed envelope/continuation/identity/time or cross-chat item |
| 503 | `lark_discovery_unsupported` | Missing transport/installation service |
| 503 | `lark_discovery_unavailable` | Credentials/bot/network/gateway unavailable or unclassified refusal |

Raw upstream error bodies/URLs are never returned. Rate limits do not promise a
retry interval. Unknown errors are not empty results or permission grants.

## Frontend example and fixtures

This browser-session example uses the actual endpoints; UUIDs come from current
application state. Production packages/core must parse schemas and map errors.

```js
const base = `/api/workspaces/${workspaceId}/lark/installations/${installationId}`;
async function read(path) {
  const res = await fetch(path, { headers: { "X-Workspace-ID": workspaceId } });
  const body = await res.json();
  if (!res.ok) throw body;
  return body; // use packages/core schema parsing in production
}
const capabilities = await read(`${base}/target-capabilities`);
const query = new URLSearchParams({ page_size: "20", q: "Release" });
const first = await read(`${base}/chats?${query}`);
if (first.has_more === true) {
  query.set("cursor", first.next_cursor);
  const second = await read(`${base}/chats?${query}`);
  // Merge by chat_id; continue even if either page has no matches.
}
const anchors = await read(`${base}/chats/${encodeURIComponent(selectedChat.chat_id)}/message-anchors?page_size=20`);
// Selected IDs go into EXISTING save/approval requests:
// group: target_chat_id; topic: target_chat_id + target_message_id
// (+ optional target_thread_id); conversation: {chat_id, chat_type:"group"}.
```

Wire schema: `../integrations/lark/target-discovery.schema.json`, definitions
`capabilities`, `chats_page`, `anchors_page`, `error`. Sanitized test data:
`../integrations/lark/testdata/target-discovery-examples.json`. Executable
provider shapes and two-page requests: `target_discovery_test.go` and
`handler/lark_target_discovery_test.go`. Frontend/core parsing and query wrappers
belong to the frontend successor; no frontend files change here.

## Official permissions and regions (checked 2026-09-13)

- Groups: any of `im:chat`, `im:chat:readonly`, `im:chat:read`, or legacy
  `im:chat.group_info:readonly`. Anchor group-mode preflight uses get-chat,
  whose listed choices are `im:chat`, `im:chat:readonly` or `im:chat:read`.
  Enable bot capability; no contact scope is needed. Sources:
  [Feishu groups](https://open.feishu.cn/document/server-docs/group/chat/list),
  [Lark groups](https://open.larksuite.com/document/server-docs/group/chat/list),
  [Feishu get-chat](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat/get).
- Group history: one of `im:message`, `im:message:readonly`, or legacy
  `im:message.history:readonly`, **plus** `im:message.group_msg`. Bot membership
  is required; an @-mention-only scope is insufficient. Tenant/app identity is
  used, never user access tokens. Sources:
  [Feishu history](https://open.feishu.cn/document/server-docs/im-v1/message/list),
  [Lark history](https://open.larksuite.com/document/server-docs/im-v1/message/list).
- Stored region selects `open.feishu.cn` or `open.larksuite.com`, including token
  acquisition; the existing deployment/test base-URL override remains supported.
  Shapes and limits match, but external-group support is not promised identical:
  Feishu history guidance allows enabling external sharing, whereas Lark history
  error guidance still says external groups are unsupported. Surface the
  provider refusal; never switch clouds automatically or infer permission from
  the external badge (same history sources above).

Tests use hermetic provider fixtures and local PostgreSQL. No live tenant,
external-group, production or deployment verification is claimed.
