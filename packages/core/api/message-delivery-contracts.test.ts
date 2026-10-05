// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";
import { MessageDeliverySchema, MessageSourceDeliverySchema } from "./schemas";

const client = new ApiClient("https://api.example.test");
const route = {
  id: "route-1", workspace_id: "ws-1", autopilot_id: "ap-1",
  installation_id: "inst-1", target_type: "group",
};
const approval = { ...route, id: "approval-1" };
const delivery = { id: "delivery-1", status: "queued" };
const saveRoute = {
  installation_id: "inst-1", target_type: "group", target_chat_id: "oc_team",
  conditions: "success", content_mode: "summary", source_kind: "activity",
};

function respond(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
}

afterEach(() => vi.unstubAllGlobals());

describe.each([
  { name: "automation routes", read: () => client.listMessageRoutes("ap-1"), empty: { routes: [] }, malformed: { routes: [route, {}] } },
  { name: "source routes", read: () => client.listMessageSourceRoutes("inbox"), empty: { routes: [] }, malformed: { routes: [route, {}] } },
  { name: "automation approvals", read: () => client.listMessageApprovedTargets("ap-1"), empty: { approved_targets: [] }, malformed: { approved_targets: [approval, {}] } },
  { name: "source approvals", read: () => client.listMessageSourceApprovedTargets(), empty: { approved_targets: [] }, malformed: { approved_targets: [approval, {}] } },
  {
    name: "event catalog", read: () => client.getMessageEventCatalog(),
    empty: { personal: { source_kind: "inbox", target_type: "member", event_types: [] }, team: [] },
    malformed: { personal: { event_types: [{ type: 42 }] }, team: [] },
  },
])("configuration read: $name", ({ read, empty, malformed }) => {
  it.each([null, {}, "unreadable"])("does not interpret %j as no configuration", async (body) => {
    respond(body);
    await expect(read()).rejects.toMatchObject({ body: { code: "response_unreadable" } });
  });

  it("rejects a malformed nested item instead of offering a partial configuration", async () => {
    respond(malformed);
    await expect(read()).rejects.toBeInstanceOf(ApiError);
  });

  it("accepts an explicitly empty configuration", async () => {
    respond(empty);
    await expect(read()).resolves.toEqual(empty);
  });
});

it.each([
  { personal: {}, team: [] },
  { personal: { event_types: [] } },
  { personal: { event_types: [] }, team: [{ source_kind: "activity" }] },
])("does not infer an event scope from an incomplete catalog: %j", async (body) => {
  respond(body);
  await expect(client.getMessageEventCatalog()).rejects.toMatchObject({ body: { code: "response_unreadable" } });
});

// Every confirmed message-delivery write has both a positive and a negative
// case. An HTTP 2xx alone never proves that a configuration write succeeded.
describe.each([
  { name: "createMessageRoute", write: () => client.createMessageRoute("ap-1", saveRoute), field: "route", value: route },
  { name: "updateMessageRoute", write: () => client.updateMessageRoute("ap-1", "route-1", saveRoute), field: "route", value: route },
  { name: "setMessageRouteEnabled", write: () => client.setMessageRouteEnabled("ap-1", "route-1", true, 1), field: "route", value: route },
  { name: "testMessageRoute", write: () => client.testMessageRoute("ap-1", "route-1"), field: "delivery", value: delivery },
  { name: "retryMessageDelivery", write: () => client.retryMessageDelivery("ap-1", "delivery-1"), field: "delivery", value: delivery },
  { name: "approveMessageTarget", write: () => client.approveMessageTarget("ap-1", saveRoute), field: "approved_target", value: approval },
  { name: "createMessageSourceRoute", write: () => client.createMessageSourceRoute(saveRoute), field: "route", value: route },
  { name: "updateMessageSourceRoute", write: () => client.updateMessageSourceRoute("route-1", saveRoute), field: "route", value: route },
  { name: "setMessageSourceRouteEnabled", write: () => client.setMessageSourceRouteEnabled("route-1", true, 1), field: "route", value: route },
  { name: "testMessageSourceRoute", write: () => client.testMessageSourceRoute("route-1"), field: "delivery", value: delivery },
  { name: "retryMessageRouteDelivery", write: () => client.retryMessageRouteDelivery("route-1", "delivery-1"), field: "delivery", value: delivery },
  { name: "approveMessageSourceTarget", write: () => client.approveMessageSourceTarget(saveRoute), field: "approved_target", value: approval },
])("confirmed write: $name", ({ write, field, value }) => {
  it.each([null, {}, { [field]: {} }, { [field]: { ...value, id: "" } }])("rejects an unconfirmed response: %j", async (body) => {
    respond(body);
    await expect(write()).rejects.toMatchObject({ body: { code: "response_unconfirmed" } });
  });

  it("returns the confirmed entity", async () => {
    respond({ [field]: value });
    await expect(write()).resolves.toMatchObject(value);
  });
});

describe.each([
  { name: "revokeMessageTarget", revoke: () => client.revokeMessageTarget("ap-1", "approval-1") },
  { name: "revokeMessageSourceTarget", revoke: () => client.revokeMessageSourceTarget("approval-1") },
])("confirmed revoke: $name", ({ revoke }) => {
  it.each([null, {}, { revoked: false }, { revoked: "true" }, { revoked: true, cancelled_deliveries: "unknown" }])("rejects %j", async (body) => {
    respond(body);
    await expect(revoke()).rejects.toMatchObject({ body: { code: "response_unconfirmed" } });
  });

  it("returns the confirmed cancellation count", async () => {
    const body = { revoked: true, cancelled_deliveries: 3 };
    respond(body);
    await expect(revoke()).resolves.toEqual(body);
  });
});

describe.each([
  { name: "automation", schema: MessageDeliverySchema },
  { name: "source", schema: MessageSourceDeliverySchema },
])("$name delivery status", ({ schema }) => {
  it.each([undefined, null, 42])("has no inferred status for %j", (status) => {
    expect(schema.safeParse({ id: "delivery-1", status }).success).toBe(false);
  });

  it("preserves unknown server statuses", () => {
    expect(schema.parse({ id: "delivery-1", status: "future_status" }).status).toBe("future_status");
  });
});
