import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DependencyView, IssuePrerequisite } from "@multica/core/api";
import { issueKeys } from "@multica/core/issues/queries";
import { renderWithI18n } from "../test/i18n";
import { EditDependenciesModal } from "./edit-dependencies";

const calls = vi.hoisted(() => ({ dependencies: vi.fn(), search: vi.fn(), save: vi.fn() }));
vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return { ...actual, api: { ...actual.api,
    getIssueDependencies: calls.dependencies,
    searchIssues: calls.search,
    updateIssueWithDependencies: calls.save,
    getIssue: vi.fn(async (id: string) => ({ id, identifier: id, title: id })),
    listProjects: vi.fn(async () => []),
    listIssueStatuses: vi.fn(async () => ({ statuses: [] })),
  } };
});
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/issues/${id}` }),
}));
vi.mock("../navigation", () => ({ useNavigation: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const prerequisite = (id: string, title: string): IssuePrerequisite => ({
  issueId: id, identifier: id, title, status: "in_progress", statusCategory: "started",
  satisfied: false, sourceEdges: [`edge-${id}`], inheritedFrom: [], descendantCount: 0,
});
const initial: DependencyView = {
  blockedBy: [prerequisite("MUL-2", "Original title"), prerequisite("MUL-3", "Remove me")],
  inheritedBlockedBy: [], blocking: [], unsatisfied: [], hasRestrictedBlockers: false,
  dependencyVersion: "v1",
};
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  calls.dependencies.mockResolvedValue(initial);
  calls.search.mockResolvedValue({ issues: [{
    id: "MUL-4", identifier: "MUL-4", title: "New selection", status: "todo", status_category: "unstarted",
  }] });
  calls.save.mockResolvedValue({ id: "MUL-1" });
});
afterEach(() => client.clear());

it.each([false, true])("refreshes title and status without replacing a draft (dirty=%s)", async (dirty) => {
  renderWithI18n(<QueryClientProvider client={client}>
    <EditDependenciesModal onClose={vi.fn()} data={{ issueId: "MUL-1" }} />
  </QueryClientProvider>);
  const originalRow = (await screen.findByRole("button", { name: /MUL-2.*Original title/ })).parentElement!;
  expect(within(originalRow).getByText("In Progress")).toBeInTheDocument();
  if (dirty) {
    fireEvent.click(screen.getByRole("button", { name: "Remove prerequisite MUL-3" }));
    fireEvent.change(screen.getByPlaceholderText("Search issues..."), { target: { value: "New" } });
    fireEvent.click(await screen.findByRole("option", { name: /MUL-4/ }));
    await screen.findByRole("button", { name: /MUL-4.*New selection/ });
  }
  calls.dependencies.mockResolvedValue({ ...initial, blockedBy: [
    { ...initial.blockedBy[0], title: "Updated title", status: "done", statusCategory: "done", satisfied: true },
    initial.blockedBy[1],
  ] });
  await act(async () => { await client.invalidateQueries({ queryKey: issueKeys.dependencies("ws", "MUL-1") }); });
  const row = (await screen.findByRole("button", { name: /MUL-2.*Updated title/ })).parentElement!;
  expect(screen.queryByText("Original title")).not.toBeInTheDocument();
  expect(within(row).queryByText("In Progress")).not.toBeInTheDocument();
  const save = screen.getByRole("button", { name: "Save" });
  if (dirty) {
    expect(screen.queryByRole("button", { name: /MUL-3.*Remove me/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /MUL-4.*New selection/ })).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() => expect(calls.save).toHaveBeenCalledWith("MUL-1", {
      blockedBy: ["MUL-2", "MUL-4"], expectedDependencyVersion: "v1",
    }));
  } else {
    expect(save).toBeDisabled();
    expect(screen.getByRole("button", { name: /MUL-3.*Remove me/ })).toBeInTheDocument();
  }
});
