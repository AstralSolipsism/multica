// @vitest-environment node

import { expect, it } from "vitest";
import {
  messageSourceKeys,
  messageEventCatalogOptions,
  messageSourceRoutesOptions,
  messageSourceApprovedTargetsOptions,
  messageRouteDeliveriesInfiniteOptions,
  messageRouteDeliveryOptions,
} from "./source-queries";

it.each([
  { name: "root", key: messageSourceKeys.all },
  { name: "catalog", key: (ws: string) => messageEventCatalogOptions(ws).queryKey },
  { name: "routes prefix", key: messageSourceKeys.routesAll },
  { name: "routes", key: (ws: string) => messageSourceRoutesOptions(ws, "inbox").queryKey },
  { name: "approvals", key: (ws: string) => messageSourceApprovedTargetsOptions(ws).queryKey },
  { name: "deliveries prefix", key: messageSourceKeys.deliveriesAll },
  { name: "deliveries", key: (ws: string) => messageRouteDeliveriesInfiniteOptions(ws, "route-1").queryKey },
  { name: "delivery", key: (ws: string) => messageRouteDeliveryOptions(ws, "route-1", "delivery-1").queryKey },
])("$name never shares cached data across workspaces", ({ key }) => {
  expect(key("ws-a").slice(0, 2)).toEqual(["message-sources", "ws-a"]);
  expect(key("ws-b").slice(0, 2)).toEqual(["message-sources", "ws-b"]);
  expect(key("ws-a")).not.toEqual(key("ws-b"));
});
