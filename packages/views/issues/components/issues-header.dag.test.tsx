// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
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
import { renderWithI18n } from "../../test/i18n";
import { IssueDisplayControls } from "./issues-header";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
afterEach(cleanup);

function renderControls(allowDag: boolean) {
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
  });

  it("does not offer Graph on a surface that cannot render it", async () => {
    const user = userEvent.setup();
    const { store } = renderControls(false);
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(screen.queryByRole("menuitemradio", { name: "Graph" })).toBeNull();
    expect(store.getState().viewMode).toBe("list");
  });
});
