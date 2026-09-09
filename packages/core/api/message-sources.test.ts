// @vitest-environment node

// OL-28: schema + client coverage for the OL-27 source-route API surface
// (personal inbox forwarding + team activity/comment subscriptions). The
// wire contract lives in server/internal/messagedelivery/README.md ("OL-27
// HTTP API") and server/internal/handler/labrastro_message_sources.go —
// these tests pin the exact request shapes (paths, revision-guarded bodies,
// no conditions/content_mode, no run filter) and the lenient parsing rules
// (unknown enum values survive, malformed payloads fall back conservatively,
// nothing unverified renders as saved or sent).

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";
import { parseWithFallback, setSchemaLogger } from "./schema";
import { noopLogger } from "../logger";
import {
  EMPTY_LIST_MESSAGE_ROUTE_DELIVERIES_RESPONSE,
  EMPTY_LIST_MESSAGE_SOURCE_ROUTES_RESPONSE,
  EMPTY_MESSAGE_EVENT_CATALOG,
  EMPTY_MESSAGE_SOURCE_ROUTE,
  GetMessageRouteDeliveryResponseSchema,
  ListMessageRouteDeliveriesResponseSchema,
  ListMessageSourceApprovedTargetsResponseSchema,
  ListMessageSourceRoutesResponseSchema,
  MessageEventCatalogSchema,
  MessageSourceRouteSchema,
  emptyMessageRouteDeliveryDetail,
} from "./schemas";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const INBOX_ROUTE = {
  id: "c1ab0000-0000-0000-0000-000000000001",
  workspace_id: "bc8c0000-0000-0000-0000-000000000002",
  autopilot_id: null,
  source_kind: "inbox",
  installation_id: "9f1c0000-0000-0000-0000-000000000004",
  channel_type: "feishu",
  target_type: "member",
  target_user_id: "55e00000-0000-0000-0000-000000000006",
  target_chat_id: null,
  target_message_id: null,
  target_thread_id: null,
  target_key: "member:55e00000-0000-0000-0000-000000000006",
  project_id: null,
  event_types: ["issue_assigned", "new_comment"],
  enabled: true,
  revision: 1,
  created_by: "55e00000-0000-0000-0000-000000000006",
  updated_by: "55e00000-0000-0000-0000-000000000006",
  effective_from: "2026-09-08T02:30:00Z",
  last_disabled_at: null,
  created_at: "2026-09-08T02:30:00Z",
  updated_at: "2026-09-08T02:30:00Z",
};

const TEAM_ROUTE = {
  ...INBOX_ROUTE,
  id: "c1ab0000-0000-0000-0000-0000000000aa",
  source_kind: "activity",
  target_type: "group",
  target_user_id: null,
  target_chat_id: "oc_team",
  target_key: "group:oc_team",
  project_id: "aa310000-0000-0000-0000-000000000009",
  event_types: ["status_changed"],
};

describe("MessageSourceRouteSchema", () => {
  it("parses the documented personal route shape", () => {
    const parsed = MessageSourceRouteSchema.parse(INBOX_ROUTE);
    expect(parsed.autopilot_id).toBeNull();
    expect(parsed.source_kind).toBe("inbox");
    expect(parsed.event_types).toEqual(["issue_assigned", "new_comment"]);
    expect(parsed.project_id).toBeNull();
    expect(parsed.last_disabled_at).toBeNull();
  });

  it("parses a team route with a project range", () => {
    const parsed = MessageSourceRouteSchema.parse(TEAM_ROUTE);
    expect(parsed.source_kind).toBe("activity");
    expect(parsed.project_id).toBe(TEAM_ROUTE.project_id);
    expect(parsed.target_chat_id).toBe("oc_team");
  });

  it("keeps unknown future enum values (forward compatibility)", () => {
    const parsed = MessageSourceRouteSchema.parse({
      ...INBOX_ROUTE,
      source_kind: "digest",
      target_type: "channel",
    });
    expect(parsed.source_kind).toBe("digest");
    expect(parsed.target_type).toBe("channel");
  });

  it("the conservative fallback never reports an enabled saved rule", () => {
    expect(EMPTY_MESSAGE_SOURCE_ROUTE.enabled).toBe(false);
    expect(EMPTY_MESSAGE_SOURCE_ROUTE.revision).toBe(0);
    expect(EMPTY_MESSAGE_SOURCE_ROUTE.id).toBe("");
  });
});

describe("ListMessageSourceRoutesResponseSchema", () => {
  it("falls back the whole response when a row is malformed", () => {
    const warn = vi.fn();
    setSchemaLogger({ ...noopLogger, warn });
    const parsed = parseWithFallback(
      { routes: [INBOX_ROUTE, { nope: true }] },
      ListMessageSourceRoutesResponseSchema,
      EMPTY_LIST_MESSAGE_SOURCE_ROUTES_RESPONSE,
      { endpoint: "test" },
    );
    // A malformed row must not present half-guessed configuration as real.
    expect(parsed.routes).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("MessageEventCatalogSchema", () => {
  it("parses the documented catalog", () => {
    const parsed = MessageEventCatalogSchema.parse({
      personal: {
        source_kind: "inbox",
        target_type: "member",
        event_types: [
          { type: "status_changed", group: "status_changes", label: "Status changed" },
        ],
      },
      team: [
        {
          source_kind: "activity",
          events: [{ event: "status_changed", label: "Issue status changed" }],
        },
        { source_kind: "comment", events: [{ event: "comment", label: "New comment" }] },
      ],
    });
    expect(parsed.personal.event_types[0]?.group).toBe("status_changes");
    expect(parsed.team.map((t) => t.source_kind)).toEqual(["activity", "comment"]);
  });

  it("the empty catalog fallback offers nothing rather than guessed events", () => {
    expect(EMPTY_MESSAGE_EVENT_CATALOG.personal.event_types).toEqual([]);
    expect(EMPTY_MESSAGE_EVENT_CATALOG.team).toEqual([]);
  });
});

describe("source-route delivery records", () => {
  const DELIVERY = {
    id: "e4520000-0000-0000-0000-000000000007",
    workspace_id: INBOX_ROUTE.workspace_id,
    route_id: TEAM_ROUTE.id,
    route_revision: 1,
    autopilot_id: null,
    run_id: null,
    source_ref_id: "77bd0000-0000-0000-0000-000000000008",
    source_kind: "activity",
    source_scope: "activity",
    source_project_id: TEAM_ROUTE.project_id,
    status: "sent",
    attempts: 1,
    next_attempt_at: null,
    error_code: null,
    last_error: null,
    shard_total: 1,
    installation_id: INBOX_ROUTE.installation_id,
    target_key: "group:oc_team",
    delivered_at: "2026-09-08T02:30:02Z",
    first_attempt_at: "2026-09-08T02:30:01Z",
    created_at: "2026-09-08T02:30:01Z",
    updated_at: "2026-09-08T02:30:02Z",
  };

  it("parses the documented records page (no applied_run_id on this surface)", () => {
    const parsed = ListMessageRouteDeliveriesResponseSchema.parse({
      deliveries: [DELIVERY],
      limit: 100,
      offset: 0,
    });
    expect(parsed.deliveries[0]?.source_scope).toBe("activity");
    expect(parsed.deliveries[0]?.source_ref_id).toBe(DELIVERY.source_ref_id);
    expect(parsed).not.toHaveProperty("applied_run_id");
  });

  it("keeps an unknown future status string instead of dropping the row", () => {
    const parsed = ListMessageRouteDeliveriesResponseSchema.parse({
      deliveries: [{ ...DELIVERY, status: "throttled" }],
    });
    expect(parsed.deliveries[0]?.status).toBe("throttled");
  });

  it("falls back to an empty page on a malformed response", () => {
    const warn = vi.fn();
    setSchemaLogger({ ...noopLogger, warn });
    const parsed = parseWithFallback(
      "not-json-shaped",
      ListMessageRouteDeliveriesResponseSchema,
      EMPTY_LIST_MESSAGE_ROUTE_DELIVERIES_RESPONSE,
      { endpoint: "test" },
    );
    expect(parsed.deliveries).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("parses the detail with frozen snapshots, locator and receipts", () => {
    const parsed = GetMessageRouteDeliveryResponseSchema.parse({
      delivery: { id: "d1", status: "sent" },
      content_snapshot: {
        text: "changed assignee: Member Sam → Unassigned",
        summary: "MUL-42 assignee changed",
        source_kind: "activity",
        issue_identifier: "MUL-42",
        issue_title: "Demo",
        actor_name: "Sam",
        change: "changed assignee: Member Sam → Unassigned",
        assignee_change: { from_type: "member", from_id: "u1", to_type: "", to_id: "" },
        link: "https://app.example/ws/issues/MUL-42",
      },
      target_snapshot: { target_type: "group", chat_id: "oc_team" },
      source_ref: {
        source_kind: "activity",
        activity_id: "act-1",
        issue_id: "i1",
        issue_identifier: "MUL-42",
      },
      receipts: [
        {
          id: "r1",
          delivery_id: "d1",
          workspace_id: "w1",
          installation_id: "i1",
          shard_index: 0,
          shard_total: 1,
          send_uuid: "5c070000-0000-0000-0000-00000000000a",
          external_message_id: "om_9f2",
          created_at: "2026-09-08T02:30:01Z",
          updated_at: "2026-09-08T02:30:02Z",
        },
      ],
    });
    expect(parsed.content_snapshot?.assignee_change?.to_type).toBe("");
    expect(parsed.source_ref?.activity_id).toBe("act-1");
    expect(parsed.receipts[0]?.external_message_id).toBe("om_9f2");
  });

  it("the conservative detail fallback never reports a verifiable status", () => {
    const fallback = emptyMessageRouteDeliveryDetail("d-1");
    expect(fallback.delivery.status).toBe("unknown");
    expect(fallback.content_snapshot).toBeNull();
    expect(fallback.receipts).toEqual([]);
  });
});

describe("ListMessageSourceApprovedTargetsResponseSchema", () => {
  it("parses team approvals with scope and project range", () => {
    const parsed = ListMessageSourceApprovedTargetsResponseSchema.parse({
      approved_targets: [
        {
          id: "t1",
          workspace_id: "w1",
          autopilot_id: null,
          source_kind: "comment",
          project_id: null,
          installation_id: "i1",
          target_key: "group:oc_1",
          target_type: "group",
          approved_by: "u1",
          approved_at: "2026-09-08T02:30:00Z",
          revoked_at: null,
        },
      ],
    });
    expect(parsed.approved_targets[0]?.source_kind).toBe("comment");
    expect(parsed.approved_targets[0]?.project_id).toBeNull();
  });
});

describe("ApiClient message-source endpoints", () => {
  function stubFetch(body: unknown, status = 200) {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        status === 204
          ? new Response(null, { status })
          : new Response(JSON.stringify(body), {
              status,
              headers: { "Content-Type": "application/json" },
            }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("fetches the event catalog", async () => {
    const fetchMock = stubFetch({
      personal: { source_kind: "inbox", target_type: "member", event_types: [] },
      team: [],
    });
    const client = new ApiClient("https://api.example.test");
    await client.getMessageEventCatalog();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://api.example.test/api/message-event-catalog");
  });

  it("lists routes with the source_kind filter", async () => {
    const fetchMock = stubFetch({ routes: [INBOX_ROUTE] });
    const client = new ApiClient("https://api.example.test");
    const res = await client.listMessageSourceRoutes("inbox");
    expect(res.routes[0]?.source_kind).toBe("inbox");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get("source_kind")).toBe("inbox");
  });

  it("creates a personal route without conditions/content_mode", async () => {
    const fetchMock = stubFetch({ route: INBOX_ROUTE }, 201);
    const client = new ApiClient("https://api.example.test");
    const route = await client.createMessageSourceRoute({
      source_kind: "inbox",
      installation_id: INBOX_ROUTE.installation_id,
      target_type: "member",
      event_types: ["issue_assigned"],
      enabled: true,
    });
    expect(route.id).toBe(INBOX_ROUTE.id);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/message-routes");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      source_kind: "inbox",
      installation_id: INBOX_ROUTE.installation_id,
      target_type: "member",
      event_types: ["issue_assigned"],
      enabled: true,
    });
    expect(body).not.toHaveProperty("conditions");
    expect(body).not.toHaveProperty("content_mode");
  });

  it("updates a route with expected_revision in the body", async () => {
    const fetchMock = stubFetch({ route: { ...TEAM_ROUTE, revision: 4 } });
    const client = new ApiClient("https://api.example.test");
    const route = await client.updateMessageSourceRoute(TEAM_ROUTE.id, {
      source_kind: "activity",
      installation_id: TEAM_ROUTE.installation_id,
      target_type: "group",
      target_chat_id: "oc_team",
      project_id: TEAM_ROUTE.project_id,
      event_types: ["status_changed"],
      expected_revision: 3,
    });
    expect(route.revision).toBe(4);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.example.test/api/message-routes/${TEAM_ROUTE.id}`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body)).expected_revision).toBe(3);
  });

  it("sends enabled + expected_revision on the enable endpoint", async () => {
    const fetchMock = stubFetch({ route: { ...INBOX_ROUTE, enabled: false } });
    const client = new ApiClient("https://api.example.test");
    await client.setMessageSourceRouteEnabled(INBOX_ROUTE.id, false, 3);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/message-routes/${INBOX_ROUTE.id}/enable`);
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false, expected_revision: 3 });
  });

  it("deletes a route with DELETE", async () => {
    const fetchMock = stubFetch(null, 204);
    const client = new ApiClient("https://api.example.test");
    await client.deleteMessageSourceRoute(INBOX_ROUTE.id);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.example.test/api/message-routes/${INBOX_ROUTE.id}`);
    expect(init.method).toBe("DELETE");
  });

  it("test-send posts to the route test-send endpoint", async () => {
    const fetchMock = stubFetch({
      delivery: { id: "d1", status: "sent", source_kind: "test_send", source_scope: "inbox" },
    });
    const client = new ApiClient("https://api.example.test");
    const delivery = await client.testMessageSourceRoute(INBOX_ROUTE.id);
    expect(delivery.status).toBe("sent");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/message-routes/${INBOX_ROUTE.id}/test-send`);
    expect(init.method).toBe("POST");
  });

  it("lists route deliveries with status + paging, and never sends run_id", async () => {
    const fetchMock = stubFetch({ deliveries: [], limit: 100, offset: 100 });
    const client = new ApiClient("https://api.example.test");
    await client.listMessageRouteDeliveries(TEAM_ROUTE.id, {
      status: "failed",
      limit: 100,
      offset: 100,
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(
      `/api/message-routes/${TEAM_ROUTE.id}/message-deliveries`,
    );
    expect(parsed.searchParams.get("status")).toBe("failed");
    expect(parsed.searchParams.get("offset")).toBe("100");
    expect(parsed.searchParams.has("run_id")).toBe(false);
  });

  it("posts retries to the route delivery retry endpoint", async () => {
    const fetchMock = stubFetch({ delivery: { id: "d1", status: "queued" } });
    const client = new ApiClient("https://api.example.test");
    await client.retryMessageRouteDelivery(TEAM_ROUTE.id, "d1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      `/api/message-routes/${TEAM_ROUTE.id}/message-deliveries/d1/retry`,
    );
    expect(init.method).toBe("POST");
  });

  it("approves a team target with the exact scope payload", async () => {
    const fetchMock = stubFetch(
      {
        approved_target: {
          id: "t1",
          workspace_id: "w1",
          autopilot_id: null,
          source_kind: "activity",
          project_id: TEAM_ROUTE.project_id,
          installation_id: "i1",
          target_key: "group:oc_1",
          target_type: "group",
          approved_by: "u1",
          approved_at: "2026-09-08T02:30:00Z",
          revoked_at: null,
        },
      },
      201,
    );
    const client = new ApiClient("https://api.example.test");
    const target = await client.approveMessageSourceTarget({
      source_kind: "activity",
      project_id: TEAM_ROUTE.project_id,
      installation_id: "i1",
      target_type: "group",
      target_chat_id: "oc_1",
    });
    expect(target.id).toBe("t1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/message-approved-targets");
    expect(JSON.parse(String(init.body))).toEqual({
      source_kind: "activity",
      project_id: TEAM_ROUTE.project_id,
      installation_id: "i1",
      target_type: "group",
      target_chat_id: "oc_1",
    });
  });

  it("revokes a team approval with DELETE", async () => {
    const fetchMock = stubFetch({ revoked: true, cancelled_deliveries: 2 });
    const client = new ApiClient("https://api.example.test");
    const res = await client.revokeMessageSourceTarget("t1");
    expect(res.cancelled_deliveries).toBe(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/message-approved-targets/t1");
    expect(init.method).toBe("DELETE");
  });

  it("an unparseable write response is an explicit unconfirmed error, never a saved route", async () => {
    stubFetch({ route: { nope: true } }, 201);
    const client = new ApiClient("https://api.example.test");
    const err = await client
      .createMessageSourceRoute({
        source_kind: "inbox",
        installation_id: "i1",
        target_type: "member",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).body).toEqual({ code: "response_unconfirmed" });
  });
});
