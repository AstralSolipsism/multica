// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ListMessageDeliveriesResponse } from "../types";
import { RUN_DELIVERIES_SETTLE_MS, runDeliveriesRefetchInterval } from "./queries";

const COMPLETED_AT = "2026-11-08T00:00:00Z";
const completed = Date.parse(COMPLETED_AT);

function pages(...statuses: string[]): ListMessageDeliveriesResponse[] {
  return [
    {
      deliveries: statuses.map((status, index) => ({ id: `d-${index}`, status })),
      applied_run_id: "run-1",
    } as unknown as ListMessageDeliveriesResponse,
  ];
}

describe("runDeliveriesRefetchInterval", () => {
  const finished = { status: "completed", completed_at: COMPLETED_AT };

  it("keeps polling while the run is still going", () => {
    for (const status of ["running", "issue_created"]) {
      expect(
        runDeliveriesRefetchInterval({ status, completed_at: null }, pages("sent"), completed + RUN_DELIVERIES_SETTLE_MS * 10),
      ).toBe(30_000);
    }
  });

  it("keeps polling a finished run inside the settle window", () => {
    expect(runDeliveriesRefetchInterval(finished, undefined, completed + RUN_DELIVERIES_SETTLE_MS - 1)).toBe(30_000);
    expect(runDeliveriesRefetchInterval(finished, pages(), completed + 60_000)).toBe(30_000);
  });

  it("stops once a finished run has settled with nothing in flight", () => {
    for (const status of ["completed", "failed", "skipped"]) {
      expect(
        runDeliveriesRefetchInterval({ status, completed_at: COMPLETED_AT }, pages("sent", "failed"), completed + RUN_DELIVERIES_SETTLE_MS),
      ).toBe(false);
    }
    expect(runDeliveriesRefetchInterval(finished, pages(), completed + RUN_DELIVERIES_SETTLE_MS)).toBe(false);
  });

  it("polls fast whenever a delivery is in flight, including automatic retries", () => {
    for (const status of ["queued", "sending"]) {
      expect(
        runDeliveriesRefetchInterval(finished, pages("sent", status), completed + RUN_DELIVERIES_SETTLE_MS * 10),
      ).toBe(5_000);
    }
  });

  it("keeps polling when the completion time is unknown", () => {
    expect(
      runDeliveriesRefetchInterval({ status: "failed", completed_at: null }, pages("failed"), completed + RUN_DELIVERIES_SETTLE_MS * 10),
    ).toBe(30_000);
  });
});
