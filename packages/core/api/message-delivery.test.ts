// @vitest-environment node

// OL-26: schema + client coverage for the Labrastro message-delivery API
// surface. The wire contract lives in
// server/internal/messagedelivery/README.md — these tests pin the lenient
// parsing rules (unknown enum values survive, malformed payloads fall back
// conservatively, nothing unverified renders as "sent") and the exact
// request shapes (paths, revision-guarded bodies).

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { setApiInstance } from "./index";
import { createQueryClient } from "../query-client";
import { messageDeliveriesOptions } from "../message-delivery/queries";
import { autopilotKeys } from "../autopilots/queries";
import { parseWithFallback, setSchemaLogger } from "./schema";
import { noopLogger } from "../logger";
import {
  ApproveMessageTargetResponseSchema,
  EMPTY_LIST_MESSAGE_DELIVERIES_RESPONSE,
  EMPTY_LIST_MESSAGE_ROUTES_RESPONSE,
  EMPTY_MESSAGE_DELIVERY,
  EMPTY_MESSAGE_ROUTE,
  GetMessageDeliveryResponseSchema,
  ListMessageApprovedTargetsResponseSchema,
  ListMessageDeliveriesResponseSchema,
  ListMessageRoutesResponseSchema,
  MessageDeliveryResponseSchema,
  MessageRouteSchema,
  RevokeMessageTargetResponseSchema,
  emptyMessageDeliveryDetail,
} from "./schemas";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ROUTE = {
  id: "c1ab0000-0000-0000-0000-000000000001",
  workspace_id: "bc8c0000-0000-0000-0000-000000000002",
  autopilot_id: "0a770000-0000-0000-0000-000000000003",
  installation_id: "9f1c0000-0000-0000-0000-000000000004",
  channel_type: "feishu",
  target_type: "member",
  target_user_id: "0d4b0000-0000-0000-0000-000000000005",
  target_chat_id: null,
  target_message_id: null,
  target_thread_id: null,
  target_key: "member:0d4b0000-0000-0000-0000-000000000005",
  conditions: "success",
  content_mode: "with_output",
  enabled: true,
  revision: 1,
  created_by: "55e00000-0000-0000-0000-000000000006",
  updated_by: "55e00000-0000-0000-0000-000000000006",
  effective_from: "2026-09-08T02:30:00Z",
  created_at: "2026-09-08T02:30:00Z",
  updated_at: "2026-09-08T02:30:00Z",
};

describe("MessageRouteSchema", () => {
  it("parses the documented route shape", () => {
    const parsed = MessageRouteSchema.parse(ROUTE);
    expect(parsed.id).toBe(ROUTE.id);
    expect(parsed.target_type).toBe("member");
    expect(parsed.enabled).toBe(true);
    expect(parsed.revision).toBe(1);
  });

  it("keeps unknown enum values (forward compatibility)", () => {
    const parsed = MessageRouteSchema.parse({
      ...ROUTE,
      target_type: "channel",
      conditions: "on_skip",
      content_mode: "full_json",
    });
    expect(parsed.target_type).toBe("channel");
    expect(parsed.conditions).toBe("on_skip");
    expect(parsed.content_mode).toBe("full_json");
  });

  it("tolerates additive fields via .loose()", () => {
    const parsed = MessageRouteSchema.parse({ ...ROUTE, future_field: { x: 1 } });
    expect((parsed as Record<string, unknown>).future_field).toEqual({ x: 1 });
  });
});

describe("ListMessageRoutesResponseSchema", () => {
  it("defaults an empty list", () => {
    const parsed = parseWithFallback(
      {},
      ListMessageRoutesResponseSchema,
      EMPTY_LIST_MESSAGE_ROUTES_RESPONSE,
      { endpoint: "test" },
    );
    expect(parsed.routes).toEqual([]);
  });

  it("falls back the whole response when a row is malformed", () => {
    const warn = vi.fn();
    setSchemaLogger({ ...noopLogger, warn });
    const parsed = parseWithFallback(
      { routes: [ROUTE, { nope: true }] },
      ListMessageRoutesResponseSchema,
      EMPTY_LIST_MESSAGE_ROUTES_RESPONSE,
      { endpoint: "test" },
    );
    // A malformed row must not present half-guessed configuration as real.
    expect(parsed.routes).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("ListMessageDeliveriesResponseSchema", () => {
  const DELIVERY = {
    id: "e4520000-0000-0000-0000-000000000007",
    workspace_id: ROUTE.workspace_id,
    route_id: ROUTE.id,
    route_revision: 3,
    autopilot_id: ROUTE.autopilot_id,
    run_id: "77bd0000-0000-0000-0000-000000000008",
    source_kind: "run_only",
    status: "sent",
    attempts: 1,
    next_attempt_at: "2026-09-08T02:30:01Z",
    error_code: null,
    last_error: null,
    shard_total: 1,
    installation_id: ROUTE.installation_id,
    target_key: ROUTE.target_key,
    delivered_at: "2026-09-08T02:30:02Z",
    first_attempt_at: "2026-09-08T02:30:01Z",
    created_at: "2026-09-08T02:30:01Z",
    updated_at: "2026-09-08T02:30:02Z",
  };

  it("parses the documented records page", () => {
    const parsed = ListMessageDeliveriesResponseSchema.parse({
      deliveries: [DELIVERY],
      limit: 50,
      offset: 0,
    });
    expect(parsed.deliveries).toHaveLength(1);
    expect(parsed.deliveries[0]?.status).toBe("sent");
  });

  it("keeps an unknown future status string instead of dropping the row", () => {
    const parsed = ListMessageDeliveriesResponseSchema.parse({
      deliveries: [{ ...DELIVERY, status: "throttled" }],
    });
    expect(parsed.deliveries[0]?.status).toBe("throttled");
  });

  it("confirms only a valid run-filter echo, keeping old or malformed echoes unconfirmed", () => {
    const runId = "019e0123-4567-7000-8000-0123456789ab";
    for (const echo of [undefined, null, "invalid", 123, {}, runId]) {
      const parsed = ListMessageDeliveriesResponseSchema.parse({
        deliveries: [DELIVERY],
        applied_run_id: echo,
      });
      expect(parsed.applied_run_id).toBe(echo === runId ? runId : null);
      expect(parsed.deliveries).toHaveLength(1);
    }
  });

  it("falls back to an empty page on a malformed response", () => {
    const warn = vi.fn();
    setSchemaLogger({ ...noopLogger, warn });
    const parsed = parseWithFallback(
      "not-json-shaped",
      ListMessageDeliveriesResponseSchema,
      EMPTY_LIST_MESSAGE_DELIVERIES_RESPONSE,
      { endpoint: "test" },
    );
    expect(parsed.deliveries).toEqual([]);
    expect(parsed.applied_run_id).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("GetMessageDeliveryResponseSchema", () => {
  it("parses detail with snapshots and receipts", () => {
    const parsed = GetMessageDeliveryResponseSchema.parse({
      delivery: {
        id: "e4520000-0000-0000-0000-000000000007",
        status: "sent",
      },
      content_snapshot: {
        text: "report body",
        summary: "summary line",
        run_status: "completed",
        has_output: true,
        link: "https://app.example/ws/issues/OL-1",
      },
      target_snapshot: {
        target_type: "topic",
        channel_type: "feishu",
        installation_id: ROUTE.installation_id,
        user_id: null,
        open_id: null,
        chat_id: "oc_test",
        message_id: "om_anchor",
        thread_id: null,
      },
      source_ref: {
        run_id: "77bd0000-0000-0000-0000-000000000008",
        execution_mode: "run_only",
        issue_id: null,
        issue_identifier: null,
        issue_status: null,
      },
      receipts: [
        {
          id: "aa310000-0000-0000-0000-000000000009",
          delivery_id: "e4520000-0000-0000-0000-000000000007",
          workspace_id: ROUTE.workspace_id,
          installation_id: ROUTE.installation_id,
          shard_index: 0,
          shard_total: 1,
          send_uuid: "5c070000-0000-0000-0000-00000000000a",
          external_message_id: "om_9f2",
          created_at: "2026-09-08T02:30:01Z",
          updated_at: "2026-09-08T02:30:02Z",
        },
      ],
    });
    expect(parsed.content_snapshot?.has_output).toBe(true);
    expect(parsed.target_snapshot?.chat_id).toBe("oc_test");
    expect(parsed.receipts[0]?.external_message_id).toBe("om_9f2");
  });

  it("accepts null snapshots and defaults an empty receipt ledger", () => {
    const parsed = GetMessageDeliveryResponseSchema.parse({
      delivery: { id: "d1", status: "failed" },
      content_snapshot: null,
      target_snapshot: null,
      source_ref: null,
    });
    expect(parsed.content_snapshot).toBeNull();
    expect(parsed.receipts).toEqual([]);
  });

  it("the conservative fallback never reports a verifiable status", () => {
    const fallback = emptyMessageDeliveryDetail("ap-1", "d-1");
    expect(fallback.delivery.status).toBe("unknown");
    expect(fallback.content_snapshot).toBeNull();
    expect(fallback.receipts).toEqual([]);
    expect(EMPTY_MESSAGE_DELIVERY.status).toBe("unknown");
    expect(EMPTY_MESSAGE_ROUTE.enabled).toBe(false);
  });
});

describe("Approved-target and receipt wrappers", () => {
  it("parses the approve response", () => {
    const parsed = ApproveMessageTargetResponseSchema.parse({
      approved_target: {
        id: "t1",
        workspace_id: "w1",
        autopilot_id: "a1",
        installation_id: "i1",
        target_key: "group:oc_1",
        target_type: "group",
        approved_by: "u1",
        approved_at: "2026-09-08T02:30:00Z",
        revoked_at: null,
      },
    });
    expect(parsed.approved_target.target_key).toBe("group:oc_1");
  });

  it("lists default to empty", () => {
    expect(
      ListMessageApprovedTargetsResponseSchema.parse({}).approved_targets,
    ).toEqual([]);
  });

  it("parses the revoke response with the cancelled count", () => {
    expect(
      RevokeMessageTargetResponseSchema.parse({ revoked: true, cancelled_deliveries: 2 })
        .cancelled_deliveries,
    ).toBe(2);
  });

  it("parses the test-send / retry {delivery} wrapper", () => {
    const parsed = MessageDeliveryResponseSchema.parse({
      delivery: { id: "d1", status: "queued" },
    });
    expect(parsed.delivery.status).toBe("queued");
  });
});

describe("ApiClient message-delivery endpoints", () => {
  function stubFetch(body: unknown, status = 200) {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("creates a route with the documented payload shape", async () => {
    const fetchMock = stubFetch({ route: ROUTE }, 201);
    const client = new ApiClient("https://api.example.test");
    const route = await client.createMessageRoute(ROUTE.autopilot_id, {
      installation_id: ROUTE.installation_id,
      target_type: "member",
      target_user_id: ROUTE.target_user_id ?? undefined,
      conditions: "success",
      content_mode: "with_output",
      enabled: true,
    });
    expect(route.id).toBe(ROUTE.id);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.example.test/api/autopilots/${ROUTE.autopilot_id}/message-routes`,
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      installation_id: ROUTE.installation_id,
      target_type: "member",
      target_user_id: ROUTE.target_user_id,
      conditions: "success",
      content_mode: "with_output",
      enabled: true,
    });
  });

  it("updates a route with expected_revision in the body", async () => {
    const fetchMock = stubFetch({ route: { ...ROUTE, revision: 4 } });
    const client = new ApiClient("https://api.example.test");
    const route = await client.updateMessageRoute(ROUTE.autopilot_id, ROUTE.id, {
      installation_id: ROUTE.installation_id,
      target_type: "group",
      target_chat_id: "oc_test",
      conditions: "all",
      content_mode: "summary",
      expected_revision: 3,
    });
    expect(route.revision).toBe(4);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://api.example.test/api/autopilots/${ROUTE.autopilot_id}/message-routes/${ROUTE.id}`,
    );
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body)).expected_revision).toBe(3);
  });

  it("sends enabled + expected_revision on the enable endpoint", async () => {
    const fetchMock = stubFetch({ route: { ...ROUTE, enabled: false } });
    const client = new ApiClient("https://api.example.test");
    await client.setMessageRouteEnabled(ROUTE.autopilot_id, ROUTE.id, false, 3);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/message-routes/${ROUTE.id}/enable`);
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false, expected_revision: 3 });
  });

  it("passes intersecting run/status filters and paging, preserving the applied echo", async () => {
    const runId = "019e0123-4567-7000-8000-0123456789ab";
    const fetchMock = stubFetch({ deliveries: [], limit: 50, offset: 100, applied_run_id: runId });
    const client = new ApiClient("https://api.example.test");
    const page = await client.listMessageDeliveries(ROUTE.autopilot_id, {
      runId,
      status: "uncertain",
      limit: 50,
      offset: 100,
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/message-deliveries?");
    expect(url).toContain("status=uncertain");
    expect(url).toContain("offset=100");
    expect(new URL(url).searchParams.get("run_id")).toBe(runId);
    expect(page.applied_run_id).toBe(runId);
  });

  it("revokes an approved target with DELETE", async () => {
    const fetchMock = stubFetch({ revoked: true, cancelled_deliveries: 1 });
    const client = new ApiClient("https://api.example.test");
    const res = await client.revokeMessageTarget(ROUTE.autopilot_id, "target-1");
    expect(res.revoked).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/message-approved-targets/target-1`);
    expect(init.method).toBe("DELETE");
  });

  it("posts retries to the retry endpoint", async () => {
    const fetchMock = stubFetch({
      delivery: { id: "d1", status: "queued" },
    });
    const client = new ApiClient("https://api.example.test");
    const delivery = await client.retryMessageDelivery(ROUTE.autopilot_id, "d1");
    expect(delivery.status).toBe("queued");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/message-deliveries/d1/retry`);
    expect(init.method).toBe("POST");
  });
});

describe("OL-26 review regressions", () => {
  // TestSend omits RunID in deliveries.go. The handler returns the sqlc row;
  // pgtype.UUID{Valid:false} is encoded as JSON null, in list rows and the
  // detail envelope alike.
  const testSend = {
    id: "test-delivery",
    workspace_id: "workspace",
    route_id: "route",
    route_revision: 1,
    autopilot_id: "autopilot",
    run_id: null,
    source_kind: "test_send",
    status: "sent",
    attempts: 1,
    installation_id: "installation",
    target_key: "group:oc_test",
    shard_total: 1,
  };
  const runDelivery = {
    ...testSend,
    id: "run-delivery",
    run_id: "run",
    source_kind: "run_only",
  };
  function response(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    return new ApiClient("https://api.example.test");
  }

  it("retains a real test-send outcome with no source run", async () => {
    const api = response({ delivery: testSend });
    const actual = await api.testMessageRoute("autopilot", "route");
    expect(actual.status).toBe("sent");
    expect(actual.run_id).toBeNull();
  });

  it("keeps all delivery records when the page includes a test send", async () => {
    const api = response({ deliveries: [runDelivery, testSend], limit: 50, offset: 0 });
    const actual = await api.listMessageDeliveries("autopilot");
    expect(actual.deliveries).toHaveLength(2);
  });

  it("keeps a failed test send retryable in the delivery detail", async () => {
    const api = response({
      delivery: { ...testSend, status: "failed", error_code: "sender_unavailable" },
      content_snapshot: { text: "Labrastro test message", run_status: "test" },
      target_snapshot: { target_type: "group", chat_id: "oc_test" },
      source_ref: { run_id: "" },
      receipts: [],
    });
    const actual = await api.getMessageDelivery("autopilot", "test-delivery");
    expect(actual.delivery.status).toBe("failed");
    expect(actual.content_snapshot?.text).toBe("Labrastro test message");
  });

  it("refreshes deliveries when the autopilot prefix is invalidated", async () => {
    const client = createQueryClient();
    setApiInstance(response({ deliveries: [], limit: 50, offset: 0 }));
    const options = messageDeliveriesOptions("workspace", "autopilot");
    await client.fetchQuery(options);
    // The worker wrote back a new delivery; the next realtime autopilot
    // event invalidates the shared prefix and the records refetch.
    response({ deliveries: [runDelivery], limit: 50, offset: 0 });
    await client.invalidateQueries({ queryKey: autopilotKeys.all("workspace") });
    const actual = await client.fetchQuery(options);
    client.clear();
    expect(actual.deliveries).toHaveLength(1);
  });

  it("nests records keys under the autopilot prefix with status, run and page", () => {
    expect(
      messageDeliveriesOptions("workspace", "autopilot", {
        status: "failed",
        runId: "run-1",
        limit: 100,
        offset: 200,
      }).queryKey,
    ).toEqual([
      "autopilots",
      "workspace",
      "message-delivery",
      "autopilot",
      "deliveries",
      "failed",
      "run-1",
      "page",
      100,
      200,
    ]);
  });

  it("throws response_unconfirmed instead of a phantom saved route", async () => {
    const api = response({ route: { broken: true } });
    await expect(
      api.createMessageRoute("autopilot", {
        installation_id: "inst",
        target_type: "member",
        target_user_id: "user",
        conditions: "success",
        content_mode: "summary",
      }),
    ).rejects.toMatchObject({
      name: "ApiError",
      body: { code: "response_unconfirmed" },
    });
  });
});
