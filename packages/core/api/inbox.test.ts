// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { ApiClient } from "./client";
import { setApiInstance } from "./index";
import { inboxKeys, inboxListOptions } from "../inbox/queries";

afterEach(() => vi.unstubAllGlobals());

it("keeps raw requests as the default and parses malformed grouped responses safely", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ invalid: true })));
  vi.stubGlobal("fetch", fetch);
  const api = new ApiClient("https://api.example.test");
  await expect(api.listInbox()).resolves.toEqual([]);
  expect(fetch.mock.calls[0]![0]).toBe("https://api.example.test/api/inbox");
  fetch.mockResolvedValue(new Response(JSON.stringify([{ id: "broken" }])));
  await expect(api.listInbox({ view: "grouped" })).resolves.toEqual([]);
  expect(fetch.mock.calls[1]![0]).toBe("https://api.example.test/api/inbox?view=grouped");
});

it("requests the grouped view and aborts its HTTP request when the query is cancelled", async () => {
  let signal: AbortSignal | undefined;
  const fetch = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = options.signal ?? undefined;
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  vi.stubGlobal("fetch", fetch);
  setApiInstance(new ApiClient("https://api.example.test"));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const request = qc.fetchQuery(inboxListOptions("ws-1"));
  const cancelled = expect(request).rejects.toThrow();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(fetch.mock.calls[0]![0]).toBe("https://api.example.test/api/inbox?view=grouped");
  await qc.cancelQueries({ queryKey: inboxKeys.list("ws-1") });
  expect(signal?.aborted).toBe(true);
  await cancelled;
  qc.clear();
});
