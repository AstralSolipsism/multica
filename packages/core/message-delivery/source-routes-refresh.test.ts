// @vitest-environment node

// OL-28 review regressions (reviewer repros, adopted): configuration queries
// without realtime events must re-read on reopen, and a revoke response that
// cannot confirm revoked=true must not resolve as success.

import { afterEach, expect, it, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import { ApiClient } from "../api/client";
import { setApiInstance } from "../api";
import { createQueryClient } from "../query-client";
import {
  messageSourceRoutesOptions,
  messageSourceApprovedTargetsOptions,
} from "./source-queries";

afterEach(() => vi.unstubAllGlobals());

it("reopening source routes reads an externally disabled route with the production QueryClient", async () => {
  let enabled = true;
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    routes: [{ id: "r1", target_type: "member", enabled }],
  })));
  vi.stubGlobal("fetch", fetch);
  setApiInstance(new ApiClient("https://review.example.test"));
  const client = createQueryClient();
  const options = messageSourceRoutesOptions("ws1", "inbox");
  await client.fetchQuery(options);
  enabled = false;
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  try {
    expect(observer.getCurrentResult().data?.[0]?.enabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    client.clear();
  }
});

it("reopening team approvals reads an externally revoked approval with the production QueryClient", async () => {
  let approved = true;
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    approved_targets: approved ? [{ id: "a1", target_type: "group" }] : [],
  })));
  vi.stubGlobal("fetch", fetch);
  setApiInstance(new ApiClient("https://review.example.test"));
  const client = createQueryClient();
  const options = messageSourceApprovedTargetsOptions("ws1");
  await client.fetchQuery(options);
  approved = false;
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  try {
    expect(observer.getCurrentResult().data).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    client.clear();
  }
});

it("does not confirm revocation when the successful HTTP response cannot confirm revoked=true", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  const client = new ApiClient("https://review.example.test");
  await expect(client.revokeMessageSourceTarget("a1")).rejects.toMatchObject({
    body: { code: "response_unconfirmed" },
  });
});
