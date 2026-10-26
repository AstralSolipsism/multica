// @vitest-environment jsdom

/**
 * The Display menu's Columns section: the only place to bring back a hidden
 * status column, now that boards no longer render a hidden-columns panel
 * (MUL-8160).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, type StoreApi } from "zustand/vanilla";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import {
  type IssueViewState,
  viewStoreSlice,
} from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import type { IssueStatus, IssueStatusEntry } from "@multica/core/types";
import { issueStatusKeys } from "@multica/core/issue-statuses/queries";
import { renderWithI18n } from "../../test/i18n";
import { ColumnStatusesProvider } from "../surface/column-statuses-context";
import { IssueDisplayControls } from "./issues-header";

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

function renderDisplay(
  columns: IssueStatus[] | null,
  setup: (store: StoreApi<IssueViewState>) => void = () => {},
  statuses: IssueStatusEntry[] = [],
) {
  setApiInstance(
    new Proxy({}, { get: () => async () => ({}) }) as unknown as ApiClient,
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (statuses.length) qc.setQueryData(issueStatusKeys.list("ws-1"), { statuses });
  const store = createStore<IssueViewState>()(viewStoreSlice);
  setup(store);
  const controls = <IssueDisplayControls scopedIssues={[]} hideViewToggle />;
  renderWithI18n(
    <QueryClientProvider client={qc}>
      <ViewStoreProvider store={store}>
        {columns ? (
          <ColumnStatusesProvider statuses={columns}>{controls}</ColumnStatusesProvider>
        ) : (
          controls
        )}
      </ViewStoreProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Display" }));
  return store;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("Display columns", () => {
  it("toggles custom columns independently of the card cost setting", async () => {
    const store = renderDisplay(["backlog_2", "todo", "done"], (s) => s.getState().setViewMode("board"), [{
      id: "discussion-status", workspace_id: "ws-1", key: "backlog_2", name: "Discussion",
      description: "", category: "unstarted", color: "#777777", is_system: false,
      position: 1, archived_at: null, created_at: "2026-10-26T00:00:00Z", updated_at: "2026-10-26T00:00:00Z",
    }]);
    const custom = await screen.findByRole("button", { name: "Discussion" });
    expect(custom).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(custom);
    expect(store.getState().hiddenStatuses).toContain("backlog_2");
    const cost = screen.getByRole("button", { name: "Cost" });
    const original = store.getState().cardProperties.cost;
    fireEvent.click(cost);
    expect(store.getState().cardProperties.cost).toBe(!original);
    expect(store.getState().hiddenStatuses).toContain("backlog_2");
    fireEvent.click(custom);
    expect(store.getState().hiddenStatuses).not.toContain("backlog_2");
  });

  it("lists the surface's columns in order and reflects hidden ones", async () => {
    renderDisplay(["todo", "in_progress", "done", "cancelled"], (store) =>
      store.getState().setViewMode("board"),
    );

    await screen.findByText("Columns");
    const chips = ["Todo", "In Progress", "Done", "Cancelled"].map((name) =>
      screen.getByRole("button", { name }),
    );
    expect(chips.map((chip) => chip.getAttribute("aria-pressed"))).toEqual([
      "true",
      "true",
      "true",
      "false",
    ]);
    expect(screen.queryByRole("button", { name: "Backlog" })).toBeNull();
  });

  it("hides and restores a column from its chip", async () => {
    const store = renderDisplay(["todo", "done", "cancelled"], (s) => s.getState().setViewMode("list"));

    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(store.getState().hiddenStatuses).toContain("done");

    fireEvent.click(screen.getByRole("button", { name: "Cancelled" }));
    expect(store.getState().hiddenStatuses).not.toContain("cancelled");
  });

  it("locks the chips while a status filter picks the columns", async () => {
    const store = renderDisplay(["todo", "done", "cancelled"], (s) => {
      s.getState().setViewMode("board");
      s.getState().toggleStatusFilter("todo");
    });

    const todo = await screen.findByRole("button", { name: "Todo" });
    expect(todo).toBeDisabled();
    fireEvent.click(todo);
    expect(store.getState().hiddenStatuses).not.toContain("todo");
    expect(screen.getByText("Clear the status filter to show or hide columns.")).toBeInTheDocument();
  });

  it("is absent where columns are not statuses", async () => {
    renderDisplay(["todo", "done"], (store) => {
      store.getState().setViewMode("board");
      store.getState().setGrouping("assignee");
    });

    await screen.findByText("Ordering");
    expect(screen.queryByText("Columns")).toBeNull();
  });

  it("is absent outside an issue surface", async () => {
    renderDisplay(null, (store) => store.getState().setViewMode("list"));

    await screen.findByText("Ordering");
    expect(screen.queryByText("Columns")).toBeNull();
  });
});
