import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createStore } from "zustand/vanilla";
import { setApiInstance, type ApiClient } from "@multica/core/api";
import { issueKeys, workspaceIssueUsageOptions } from "@multica/core/issues/queries";
import { viewStoreSlice, type IssueViewState } from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { useCustomPricingStore } from "@multica/core/runtimes/custom-pricing-store";
import type { IssueUsageRow } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { formatUsd, summarizeTaskUsageAcross } from "../../runtimes/utils";
import { IssueCostBadge } from "./issue-cost-badge";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
afterEach(() => { cleanup(); useCustomPricingStore.setState({ pricings: {} }); });

const row = (issue_id: string, overrides: Partial<IssueUsageRow> = {}): IssueUsageRow => ({
  issue_id, model: "test-model", provider: "test-provider", input_tokens: 1_000_000, output_tokens: 0,
  cache_read_tokens: 0, cache_write_tokens: 0, cost_usd_ticks: 30_000_000_000,
  uncosted_input_tokens: 500_000, uncosted_output_tokens: 0, uncosted_cache_read_tokens: 0, uncosted_cache_write_tokens: 0,
  ...overrides,
});
function QueryOwner() { useQuery(workspaceIssueUsageOptions("ws-1")); return null; }
function setup(ids: (string | string[])[], rows: IssueUsageRow[], owner = true) {
  const fetch = vi.fn(async () => rows);
  setApiInstance({ listWorkspaceIssueUsage: fetch } as unknown as ApiClient);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createStore<IssueViewState>()(viewStoreSlice);
  const render = () => <QueryClientProvider client={qc}><ViewStoreProvider store={store}>
    {owner && <QueryOwner />}
    {ids.map((id, i) => <div key={i} data-testid={`cost-${i}`}><IssueCostBadge issueIds={id} /></div>)}
  </ViewStoreProvider></QueryClientProvider>;
  const view = renderWithI18n(render());
  return { ...view, qc, store, fetch, render };
}

describe("issue card costs", () => {
  it("uses one indexed batch for 100 cards, refreshes once on invalidation, and never fetches from cards", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `issue-${i}`);
    const { fetch, qc, rerender, render } = setup(ids, ids.map((id) => row(id)));
    await waitFor(() => expect(screen.getAllByText("$3.00")).toHaveLength(100));
    rerender(render());
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(() => qc.invalidateQueries({ queryKey: issueKeys.workspaceUsage("ws-1") }));
    expect(fetch).toHaveBeenCalledTimes(2);
    qc.clear();
  });
  it("cache-only cards cannot start a request", () => {
    const { fetch, qc } = setup(["a", "b"], [], false);
    expect(fetch).not.toHaveBeenCalled();
    act(() => qc.setQueryData(issueKeys.workspaceUsage("ws-1"), { a: [row("a")] }));
    qc.clear();
  });
  it("aligns a mixed bill with the execution log, sums member IDs once, and reprices immediately", async () => {
    useCustomPricingStore.getState().setCustomPricing("test-model", { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 });
    const parent = row("parent");
    const child = row("child", { cost_usd_ticks: 150_000_000_000, uncosted_input_tokens: 0 });
    const { store, qc, fetch } = setup(["parent", "child", ["parent", "child", "parent"]], [parent, child]);
    const detail = summarizeTaskUsageAcross([
      [{ ...parent, input_tokens: 500_000, uncosted_input_tokens: 0 }],
      [{ ...parent, input_tokens: 500_000, cost_usd_ticks: undefined, uncosted_input_tokens: undefined }],
    ]);
    await waitFor(() => expect(screen.getByTestId("cost-0")).toHaveTextContent(formatUsd(detail!.cost)));
    expect(screen.getByTestId("cost-1")).toHaveTextContent("$15.00");
    expect(screen.getByTestId("cost-2")).toHaveTextContent("$19.00");
    act(() => useCustomPricingStore.getState().setCustomPricing("test-model", { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }));
    await waitFor(() => expect(screen.getByTestId("cost-0")).toHaveTextContent("$8.00"));
    expect(screen.getByTestId("cost-2")).toHaveTextContent("$23.00");
    act(() => store.getState().toggleCardProperty("cost"));
    expect(screen.queryByText("$8.00")).toBeNull();
    act(() => store.getState().toggleCardProperty("cost"));
    expect(screen.getByText("$8.00")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    qc.clear();
  });
  it("leaves absent usage blank, keeps metered zero, and uses shared USD rounding", async () => {
    const { qc } = setup(["empty", "zero", "large", []], [
      row("zero", { cost_usd_ticks: 0, uncosted_input_tokens: 0 }),
      row("large", { cost_usd_ticks: 1_657_000_000_000, uncosted_input_tokens: 0 }),
    ]);
    await screen.findByText("$166");
    expect(screen.getByTestId("cost-0")).toBeEmptyDOMElement();
    expect(screen.getByTestId("cost-1")).toHaveTextContent("$0.00");
    expect(screen.getByTestId("cost-3")).toBeEmptyDOMElement();
    qc.clear();
  });
});
