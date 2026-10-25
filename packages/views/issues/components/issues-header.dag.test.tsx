// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore } from "zustand/vanilla";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import {
  viewStoreSlice,
  type IssueViewState,
} from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import type { SupportedLocale } from "@multica/core/i18n";
import { renderWithI18n } from "../../test/i18n";
import { IssueDisplayControls } from "./issues-header";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
afterEach(cleanup);

function renderControls(allowDag: boolean, locale: SupportedLocale = "en") {
  setApiInstance({
    listProperties: async () => ({ properties: [] }),
  } as unknown as ApiClient);
  const store = createStore<IssueViewState>()(viewStoreSlice);
  store.getState().setViewMode("list");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderWithI18n(
    <QueryClientProvider client={qc}>
      <ViewStoreProvider store={store}>
        <IssueDisplayControls scopedIssues={[]} allowDag={allowDag} />
      </ViewStoreProvider>
    </QueryClientProvider>,
    { locale },
  );
  return { store, ...view };
}

describe("DAG header controls", () => {
  it("switches to Graph and offers neither ordering nor direction controls", async () => {
    const user = userEvent.setup();
    const { store } = renderControls(true);
    await user.click(screen.getByRole("button", { name: "List" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Graph" }));
    expect(store.getState().viewMode).toBe("dag");
    await user.click(screen.getByRole("button", { name: "Display" }));
    expect(screen.queryByRole("combobox", { name: "Ordering" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Grouping" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Direction" })).toBeNull();
    const cost = screen.getByRole("button", { name: "Cost" });
    expect(cost).toHaveAttribute("aria-pressed", "true");
    await user.click(cost);
    expect(store.getState().cardProperties.cost).toBe(false);
    expect(screen.queryByRole("button", { name: "Priority" })).toBeNull();
  });

  it("does not offer Graph on a surface that cannot render it", async () => {
    const user = userEvent.setup();
    const { store } = renderControls(false);
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(screen.queryByRole("menuitemradio", { name: "Graph" })).toBeNull();
    expect(store.getState().viewMode).toBe("list");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Display" }));
    expect(screen.queryByRole("button", { name: "Cost" })).toBeNull();
  });
});


it.each([
  ["en", "Display", "Cost"], ["zh-Hans", "显示", "费用"], ["ja", "表示", "費用"],
  ["ko", "보기", "비용"], ["fr", "Affichage", "Coût"],
] as const)("translates the cost control in %s", async (locale, display, cost) => {
  const user = userEvent.setup();
  const { store } = renderControls(true, locale);
  // Store change is the same controlled input used by the view menu.
  act(() => store.getState().setViewMode("dag"));
  // Locate Display by its translated tooltip text, independent of viewport labels.
  await user.click(screen.getByRole("button", { name: display }));
  expect(screen.getByRole("button", { name: cost })).toHaveAttribute("aria-pressed", "true");
});
