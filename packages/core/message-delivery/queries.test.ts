// @vitest-environment jsdom
// jsdom, not node: TanStack never starts refetch intervals where `window` is
// undefined, and the observer scenarios below exercise exactly that timer.

import { afterEach, describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import type { ListMessageDeliveriesResponse } from "../types";
import {
  messageDeliveriesInfiniteOptions,
  RUN_DELIVERIES_SETTLE_MS,
  runDeliveriesRefetchInterval,
} from "./queries";

const COMPLETED_AT = "2026-11-08T00:00:00Z";
const completed = Date.parse(COMPLETED_AT);

function page(...statuses: string[]): ListMessageDeliveriesResponse {
  return {
    deliveries: statuses.map((status, index) => ({ id: `d-${index}`, status })),
    applied_run_id: "run-1",
  } as unknown as ListMessageDeliveriesResponse;
}

function succeeded(...statuses: string[]) {
  return { status: "success" as const, data: { pages: [page(...statuses)] } };
}

describe("runDeliveriesRefetchInterval", () => {
  const finished = { status: "completed", completed_at: COMPLETED_AT };
  const settled = completed + RUN_DELIVERIES_SETTLE_MS;

  it("keeps polling while the run is still going", () => {
    for (const status of ["running", "issue_created"]) {
      expect(
        runDeliveriesRefetchInterval({ status, completed_at: null }, succeeded("sent"), settled * 10),
      ).toBe(30_000);
    }
  });

  it("keeps polling a finished run inside the settle window", () => {
    expect(runDeliveriesRefetchInterval(finished, succeeded("sent"), settled - 1)).toBe(30_000);
    expect(runDeliveriesRefetchInterval(finished, succeeded(), completed + 60_000)).toBe(30_000);
  });

  it("stops once a successful read shows a settled run with nothing in flight", () => {
    for (const status of ["completed", "failed", "skipped"]) {
      expect(
        runDeliveriesRefetchInterval({ status, completed_at: COMPLETED_AT }, succeeded("sent", "failed"), settled),
      ).toBe(false);
    }
    expect(runDeliveriesRefetchInterval(finished, succeeded(), settled)).toBe(false);
  });

  it("keeps the bounded recovery when the latest read failed or has not landed", () => {
    expect(runDeliveriesRefetchInterval(finished, { status: "pending" }, settled)).toBe(30_000);
    expect(runDeliveriesRefetchInterval(finished, { status: "error" }, settled)).toBe(30_000);
    // A failed refetch keeps the cached rows; they no longer prove anything.
    expect(
      runDeliveriesRefetchInterval(finished, { status: "error", data: { pages: [page("sent")] } }, settled),
    ).toBe(30_000);
  });

  it("polls fast whenever a delivery is in flight, including automatic retries", () => {
    for (const status of ["queued", "sending"]) {
      expect(runDeliveriesRefetchInterval(finished, succeeded("sent", status), settled * 10)).toBe(5_000);
    }
  });

  it("keeps polling when the completion time is unknown", () => {
    expect(
      runDeliveriesRefetchInterval({ status: "failed", completed_at: null }, succeeded("failed"), settled * 10),
    ).toBe(30_000);
  });
});

describe("a settled run's deliveries under a real observer", () => {
  afterEach(() => vi.useRealTimers());

  function observe(queryFn: () => Promise<ListMessageDeliveriesResponse>) {
    vi.useFakeTimers();
    vi.setSystemTime(completed + RUN_DELIVERIES_SETTLE_MS * 6);
    const client = new QueryClient();
    const run = { status: "completed", completed_at: COMPLETED_AT };
    const observer = new InfiniteQueryObserver(client, {
      ...messageDeliveriesInfiniteOptions("ws-1", "ap-1", { runId: "run-1" }),
      queryFn,
      refetchInterval: (query) => runDeliveriesRefetchInterval(run, query.state, Date.now()),
    });
    const unsubscribe = observer.subscribe(() => {});
    return { client, observer, unsubscribe };
  }

  it("recovers from a failed first read, then stops", async () => {
    const queryFn = vi
      .fn<() => Promise<ListMessageDeliveriesResponse>>()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValue(page("sent"));
    const { observer, unsubscribe } = observe(queryFn);

    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().isError).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(observer.getCurrentResult().isSuccess).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(queryFn).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("recovers from a failed refetch over cached rows, then stops", async () => {
    const queryFn = vi
      .fn<() => Promise<ListMessageDeliveriesResponse>>()
      .mockResolvedValueOnce(page("failed"))
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValue(page("sent"));
    const { client, observer, unsubscribe } = observe(queryFn);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queryFn).toHaveBeenCalledTimes(1);

    // An autopilot event invalidates the prefix; that refetch fails.
    await client.invalidateQueries();
    await vi.advanceTimersByTimeAsync(0);
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(observer.getCurrentResult().isError).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(queryFn).toHaveBeenCalledTimes(3);
    expect(observer.getCurrentResult().data?.pages[0]?.deliveries[0]?.status).toBe("sent");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(queryFn).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});
