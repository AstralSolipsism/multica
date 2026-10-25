import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore } from "zustand/vanilla";
import type { NodeProps } from "@xyflow/react";
import { createDagModelIndex, computeDagOverview, computeDagLine } from "@multica/core/issues/dag";
import { graphNode, issueGraph } from "./dag-test-fixtures";
import { viewStoreSlice, type IssueViewState } from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { issueKeys } from "@multica/core/issues/queries";
import { renderWithI18n } from "../../test/i18n";
import { DagTaskCard } from "./dag-task-card";
import { DagOverviewCardView } from "./dag-overview-card";
import type { DagTaskFlowNode, DagOverviewFlowNode } from "./dag-scene-flow";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
afterEach(cleanup);

it("shows each task's own cost, the whole line including its root, and the independent group's cost", () => {
  const index = createDagModelIndex(issueGraph([
    graphNode("parent"), graphNode("child", { parentIssueId: "parent" }), graphNode("independent"),
  ]));
  const overview = computeDagOverview(index);
  const line = computeDagLine(index, "parent");
  if (!line) throw new Error("Expected parent line");
  const qc = new QueryClient();
  const row = (issue_id: string, cost: number) => ({ issue_id, model: "unknown", provider: "test", input_tokens: 0,
    output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd_ticks: cost * 10_000_000_000 });
  qc.setQueryData(issueKeys.workspaceUsage("ws-1"), {
    parent: [row("parent", 2)], child: [row("child", 3)], independent: [row("independent", 4)],
  });
  const store = createStore<IssueViewState>()(viewStoreSlice);
  const { container } = renderWithI18n(<QueryClientProvider client={qc}><ViewStoreProvider store={store}>
    {overview.cards.map((card) => <DagOverviewCardView key={card.id} {...({ data: { card, statusColor: null } } as NodeProps<DagOverviewFlowNode>)} />)}
    {line.tasks.map((task) => <DagTaskCard key={task.issue.id} {...({ data: { task, statusColor: null, projectTitle: null, showStage: false } } as NodeProps<DagTaskFlowNode>)} />)}
  </ViewStoreProvider></QueryClientProvider>);
  expect(within(container.querySelector('[data-dag-kind="line"]') as HTMLElement).getByText("$5.00")).toBeInTheDocument();
  expect(within(container.querySelector('[data-dag-kind="independent"]') as HTMLElement).getByText("$4.00")).toBeInTheDocument();
  expect(within(container.querySelector('[data-dag-task="T-CHILD"]') as HTMLElement).getByText("$3.00")).toBeInTheDocument();
  act(() => store.getState().toggleCardProperty("cost"));
  expect(screen.queryByText(/\$/)).toBeNull();
  qc.clear();
});
