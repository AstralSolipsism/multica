import { createStore } from "zustand/vanilla";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type IssueViewState,
  viewStoreSlice,
} from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { renderWithI18n } from "../../test/i18n";
import { DraftDefinitionFields, SaveViewDialog } from "./save-view-dialog";

const createView = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: [] }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multica/core/issue-views/mutations", () => ({
  useCreateIssueView: () => ({ mutate: createView, isPending: false }),
  useUpdateIssueView: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("./issues-header", () => ({
  IssueFilterMenu: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));

vi.mock("./filter-chips-bar", () => ({
  FilterChipList: ({ trailing }: { trailing?: React.ReactNode }) => trailing,
}));

function renderFields(sortBy: IssueViewState["sortBy"]) {
  const store = createStore<IssueViewState>()(viewStoreSlice);
  store.setState({ sortBy, sortDirection: "asc" });
  renderWithI18n(
    <ViewStoreProvider store={store}>
      <DraftDefinitionFields />
    </ViewStoreProvider>,
  );
  return store;
}

describe("DraftDefinitionFields ordering", () => {
  it("lets a saved view default switch between ascending and descending", async () => {
    const user = userEvent.setup();
    const store = renderFields("created_at");

    await user.click(screen.getByRole("button", { name: /Default display/ }));
    await user.click(screen.getByRole("button", { name: "Oldest first" }));

    expect(store.getState().sortDirection).toBe("desc");
    expect(screen.getByRole("button", { name: "Newest first" })).toBeInTheDocument();
  });

  it("hides direction for manual ordering, where direction has no effect", async () => {
    const user = userEvent.setup();
    renderFields("position");

    await user.click(screen.getByRole("button", { name: /Default display/ }));

    expect(screen.queryByRole("button", { name: "Workflow order" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reverse workflow order" }),
    ).not.toBeInTheDocument();
  });
});

describe("SaveViewDialog draft lifecycle", () => {
  const liveStore = createStore<IssueViewState>()(viewStoreSlice);
  // Hosts build `scope` inline, so every host render passes a new object.
  const dialog = (open: boolean) => (
    <ViewStoreProvider store={liveStore}>
      <SaveViewDialog
        open={open}
        onOpenChange={() => {}}
        scope={{ kind: "my", variant: "assigned" }}
      />
    </ViewStoreProvider>
  );

  it("keeps a half-typed name when the host re-renders", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithI18n(dialog(true));

    await user.type(screen.getByLabelText("Name"), "Ongoing");
    rerender(dialog(true));

    expect(screen.getByLabelText("Name")).toHaveValue("Ongoing");
  });

  it("starts from a blank name on the next open", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithI18n(dialog(true));

    await user.type(screen.getByLabelText("Name"), "Ongoing");
    rerender(dialog(false));
    rerender(dialog(true));

    expect(screen.getByLabelText("Name")).toHaveValue("");
  });
});

describe("saved DAG view defaults", () => {
  it("saves Graph direction and parent grouping without copying personal folds, viewport or selection", async () => {
    createView.mockClear();
    const user = userEvent.setup();
    const store = createStore<IssueViewState>()(viewStoreSlice);
    store.setState({
      viewMode: "dag",
      dagDirection: "LR",
      dagCollapsedIds: ["issue:private-fold"],
      dagIndependentExpanded: true,
      dagViewport: { x: -123, y: 89, zoom: 1.4 },
      dagSelectedNodeId: "a",
    });
    renderWithI18n(
      <ViewStoreProvider store={store}>
        <SaveViewDialog open onOpenChange={() => {}} scope={{ kind: "workspace" }} />
      </ViewStoreProvider>,
    );
    await user.type(screen.getByLabelText("Name"), "Dependency view");
    await user.click(screen.getByRole("button", { name: /Default display/ }));
    expect(screen.queryByRole("combobox", { name: "Ordering" })).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "Direction" }));
    await user.click(screen.getByRole("option", { name: "Top to bottom" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Create view" }));
    expect(createView).toHaveBeenCalledOnce();
    const payload = createView.mock.calls[0]![0];
    expect(payload).toMatchObject({
      name: "Dependency view",
      scope_type: "workspace",
      display: { viewMode: "dag", dagDirection: "TB", dagGrouping: "parent" },
    });
    for (const key of [
      "dagCollapsedIds",
      "dagViewport",
      "dagSelectedNodeId",
      "dagIndependentExpanded",
    ]) {
      expect(payload.display).not.toHaveProperty(key);
      expect(payload.query).not.toHaveProperty(key);
    }
    expect(store.getState().dagDirection).toBe("LR");
    expect(store.getState().dagCollapsedIds).toEqual(["issue:private-fold"]);
  });

  it("hides Graph in the default-display editor when the surface disallows it", async () => {
    const user = userEvent.setup();
    const store = createStore<IssueViewState>()(viewStoreSlice);
    renderWithI18n(
      <ViewStoreProvider store={store}>
        <DraftDefinitionFields allowDag={false} />
      </ViewStoreProvider>,
    );
    await user.click(screen.getByRole("button", { name: /Default display/ }));
    await user.click(screen.getByRole("combobox", { name: "Layout" }));
    expect(screen.queryByRole("option", { name: "Graph" })).toBeNull();
  });
});
