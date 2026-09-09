// @vitest-environment jsdom

// R4 evidence: real QueryClient + real query factories + a fetch stub that
// enforces the handler's actual limit rule (limit <= 200, else fall back to
// 50 — server/internal/handler/labrastro_message_delivery.go). 251 records
// must stay reachable page by page, no request may exceed the cap, and the
// load-more entry must disappear exactly when the scope is exhausted.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, setApiInstance } from "@multica/core/api";
import { createQueryClient } from "@multica/core/query-client";
import { renderWithI18n } from "../../test/i18n";
import { MessageDeliveriesSection } from "./message-deliveries-section";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/message-delivery", async (importOriginal) => {
  const original = await importOriginal<typeof import("@multica/core/message-delivery")>();
  return {
    ...original,
    useRetryMessageDelivery: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

const clients: ReturnType<typeof createQueryClient>[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});

function recordsFor(status: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${status}-${index + 1}`,
    run_id: `run-${index + 1}`,
    source_kind: "run_only",
    status,
    target_key: `member:user-${status}-${index + 1}`,
    created_at: "2026-09-08T02:30:01Z",
    updated_at: "2026-09-08T02:30:02Z",
  }));
}

describe("MessageDeliveriesSection pagination (R4)", () => {
  it("pages a 251-record scope at a fixed legal page size", async () => {
    const requests: string[] = [];
    const sent = recordsFor("sent", 251);
    const failed = recordsFor("failed", 3);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const request = new URL(url);
        requests.push(request.search);
        const requested = Number(request.searchParams.get("limit"));
        // Exact rule from the handler: >200 or invalid falls back to 50.
        const limit = requested > 0 && requested <= 200 ? requested : 50;
        const offset = Number(request.searchParams.get("offset")) || 0;
        const status = request.searchParams.get("status");
        const source = status === "failed" ? failed : sent;
        return new Response(
          JSON.stringify({
            deliveries: source.slice(offset, offset + limit),
            limit,
            offset,
            applied_run_id: null,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    setApiInstance(new ApiClient("https://api.example.test"));
    const client = createQueryClient();
    clients.push(client);
    renderWithI18n(
      <QueryClientProvider client={client}>
        <MessageDeliveriesSection autopilotId="ap-1" canWrite />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    // Page 1: records 1–100 (covers #51).
    await screen.findByText("member:user-sent-51");
    // Page 2: records 101–200 (covers #150). 
    await user.click(screen.getByRole("button", { name: /load more/i }));
    await screen.findByText("member:user-sent-150");
    // Page 3: records 201–251 (covers #201 and #251).
    await user.click(screen.getByRole("button", { name: /load more/i }));
    await screen.findByText("member:user-sent-201");
    await screen.findByText("member:user-sent-251");

    // No request ever exceeded the server's 200 cap; offsets walked forward.
    const limits = requests.map((q) => Number(new URLSearchParams(q).get("limit")));
    const offsets = requests.map((q) => Number(new URLSearchParams(q).get("offset") || 0));
    expect(Math.max(...limits)).toBeLessThanOrEqual(200);
    expect(offsets).toEqual(expect.arrayContaining([0, 100, 200]));

    // Scope exhausted → the entry disappears (never bounces to page one).
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /load more/i })).toBeNull(),
    );
    expect(screen.getByText("member:user-sent-1")).toBeInTheDocument();

    // Switching the status filter starts that scope at its own first page.
    await user.click(screen.getByRole("combobox", { name: /delivery records/i }));
    await user.click(await screen.findByRole("option", { name: /^failed$/i }));
    await screen.findByText("member:user-failed-3");
    expect(screen.queryByText("member:user-sent-1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  }, 30_000);
});
