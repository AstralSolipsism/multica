// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { setApiInstance } from "./index";
import { createQueryClient } from "../query-client";
import { messageDeliveriesInfiniteOptions, messageDeliveryOptions } from "../message-delivery/queries";

afterEach(() => vi.unstubAllGlobals());

it("updates an opened delivery detail when the list observes the worker terminal state", async () => {
  let status = "queued";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const delivery = { id: "d1", run_id: "r1", status, source_kind: "run_only" };
    const body = url.includes("message-deliveries/d1")
      ? { delivery, content_snapshot: { text: "report" }, receipts: [] }
      : { deliveries: [delivery], limit: 100, offset: 0 };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }));
  setApiInstance(new ApiClient("https://api.example.test"));
  const client = createQueryClient();
  const listOptions = messageDeliveriesInfiniteOptions("workspace", "autopilot");
  const detailOptions = messageDeliveryOptions("workspace", "autopilot", "d1");
  await client.fetchInfiniteQuery(listOptions);
  await client.fetchQuery(detailOptions);
  status = "sent";
  // Equivalent to the list poll: refetches the exact list query only.
  await client.refetchQueries({ queryKey: listOptions.queryKey, exact: true });
  expect(client.getQueryData(listOptions.queryKey)?.pages[0]?.deliveries[0]?.status).toBe("sent");
  const detail = await client.fetchQuery(detailOptions);
  client.clear();
  expect(detail.delivery.status).toBe("sent");
});
