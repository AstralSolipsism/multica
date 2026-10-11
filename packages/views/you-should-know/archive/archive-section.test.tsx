// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { youShouldKnowKeys } from "@multica/core/you-should-know";
import type { IssueTip } from "@multica/core/you-should-know";
import { renderWithI18n } from "../../test/i18n";

const state = vi.hoisted(() => ({
  workspaceEnabled: true,
  personalEnabled: true,
  pushed: [] as string[],
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({
    id: "ws-1",
    name: "Acme",
    settings: { you_should_know_enabled: state.workspaceEnabled },
  }),
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/issues/${id}` }),
}));
vi.mock("@multica/core/you-should-know", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/you-should-know")>(
    "@multica/core/you-should-know",
  );
  return {
    ...actual,
    useYouShouldKnowEnabled: () => ({
      workspaceEnabled: state.workspaceEnabled,
      personalEnabled: state.personalEnabled,
      enabled: state.workspaceEnabled && state.personalEnabled,
    }),
  };
});
vi.mock("../../navigation", () => ({
  useNavigation: () => ({ push: (href: string) => state.pushed.push(href) }),
}));

import { YouShouldKnowArchiveSection } from "./archive-section";

function tip(overrides: Partial<IssueTip> = {}): IssueTip {
  return {
    id: "tip-1",
    workspace_id: "ws-1",
    issue_id: "issue-1",
    issue_identifier: "OL-1",
    task_id: "task-1",
    agent_id: "agent-1",
    anchor_comment_id: null,
    tag: "you_should_know",
    line: "The build is slow",
    title: null,
    explanation: null,
    status: "valid",
    overturned_by_task_id: null,
    overturned_by_comment_id: null,
    overturned_reason: null,
    user_state: null,
    created_at: "2026-10-02T10:00:00Z",
    updated_at: "2026-10-02T10:00:00Z",
    ...overrides,
  };
}

function renderSection(tips: IssueTip[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(youShouldKnowKeys.issue("ws-1", "issue-1", "all"), {
    tips,
  });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <YouShouldKnowArchiveSection issueId="issue-1" identifier="OL-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.workspaceEnabled = true;
  state.personalEnabled = true;
  state.pushed = [];
});

afterEach(cleanup);

describe("YouShouldKnowArchiveSection — grouping and order", () => {
  it("groups by anchor comment, newest group first, description group included", () => {
    renderSection([
      tip({ id: "a", anchor_comment_id: "c-old", created_at: "2026-10-01T10:00:00Z", line: "First tip" }),
      tip({ id: "b", anchor_comment_id: "c-old", created_at: "2026-10-01T12:00:00Z", line: "Second tip" }),
      tip({ id: "c", anchor_comment_id: null, created_at: "2026-10-03T10:00:00Z", line: "On description" }),
      tip({ id: "d", anchor_comment_id: "c-new", created_at: "2026-10-02T10:00:00Z", line: "On new comment" }),
    ]);

    // Groups sort by their EARLIEST tip: description (10-03) > c-new (10-02) > c-old (10-01).
    const labels = screen.getAllByText(/^Issue description$|^Comment ·/).map((el) => el.textContent);
    expect(labels).toEqual(["Issue description", "Comment · Oct 2", "Comment · Oct 1"]);
    // Both c-old tips render inside their group.
    expect(screen.getByText("First tip")).toBeInTheDocument();
    expect(screen.getByText("Second tip")).toBeInTheDocument();
  });

  it("links a comment group header to its comment", () => {
    renderSection([tip({ anchor_comment_id: "c-1" })]);
    fireEvent.click(screen.getByRole("button", { name: /^Comment ·/ }));
    expect(state.pushed).toContain("/issues/OL-1#comment-c-1");
  });

  it("does not link the description group", () => {
    renderSection([tip({ anchor_comment_id: null })]);
    expect(screen.getByText("Issue description").closest("button")).toBeNull();
  });
});

describe("YouShouldKnowArchiveSection — filter and search", () => {
  const valid = tip({ id: "v", anchor_comment_id: null, line: "Valid tip" });
  const invalid = tip({
    id: "i",
    anchor_comment_id: null,
    line: "Invalid tip",
    status: "source_changed",
  });

  it("shows only valid tips by default and invalid ones on the other filter", () => {
    renderSection([valid, invalid]);
    expect(screen.getByText("Valid tip")).toBeInTheDocument();
    expect(screen.queryByText("Invalid tip")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "No longer valid" }));
    expect(screen.queryByText("Valid tip")).toBeNull();
    expect(screen.getByText("Invalid tip")).toBeInTheDocument();
  });

  it("searches case-insensitively across line, title and explanation", () => {
    renderSection([
      tip({ id: "a", anchor_comment_id: null, line: "Deploys are blue-green" }),
      tip({ id: "b", anchor_comment_id: null, line: "Matches by title", title: "GREEN cache" }),
      tip({ id: "c", anchor_comment_id: null, line: "Matches by explanation", explanation: "green means safe" }),
      tip({ id: "d", anchor_comment_id: null, line: "Unrelated" }),
    ]);
    const search = screen.getByLabelText("Search this issue");
    fireEvent.change(search, { target: { value: "GREEN" } });

    // Collapsed rows show the line; title/explanation matches keep their row.
    expect(screen.getByText("Deploys are blue-green")).toBeInTheDocument();
    expect(screen.getByText("Matches by title")).toBeInTheDocument();
    expect(screen.getByText("Matches by explanation")).toBeInTheDocument();
    expect(screen.queryByText("Unrelated")).toBeNull();
  });

  it("stacks search on top of the filter and reports no results", () => {
    renderSection([valid, invalid]);
    fireEvent.change(screen.getByLabelText("Search this issue"), {
      target: { value: "valid" },
    });
    // Default filter is valid: the invalid tip is filtered out even though
    // its line also matches.
    expect(screen.getByText("Valid tip")).toBeInTheDocument();
    expect(screen.queryByText("Invalid tip")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search this issue"), {
      target: { value: "nothing matches this" },
    });
    expect(screen.getByText("No matching tips")).toBeInTheDocument();
  });
});

describe("YouShouldKnowArchiveSection — invalid tips", () => {
  it("greys out and explains overturned tips, linking the overturning comment", () => {
    renderSection([
      tip({
        id: "o",
        line: "Was true",
        status: "overturned",
        overturned_by_comment_id: "c-9",
        overturned_reason: "superseded",
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "No longer valid" }));

    const row = screen.getByText("Was true").closest("[data-invalid]");
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("data-invalid", "true");

    const link = screen.getByRole("button", { name: "Overturned by this comment" });
    fireEvent.click(link);
    expect(state.pushed).toContain("/issues/OL-1#comment-c-9");
    // The reason renders next to the note, prefixed by " · ".
    expect(screen.getByText(/^· /, { exact: false })).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.textContent === " · superseded")).toBeInTheDocument();
  });

  it("says just Overturned when no comment id exists, and Source changed otherwise", () => {
    renderSection([
      tip({ id: "o2", line: "No comment", status: "overturned" }),
      tip({ id: "s2", line: "Edited source", status: "source_changed" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "No longer valid" }));

    expect(screen.getByText("Overturned")).toBeInTheDocument();
    expect(screen.getByText("Source changed")).toBeInTheDocument();
  });
});

describe("YouShouldKnowArchiveSection — visibility", () => {
  it("renders nothing while either switch is off", () => {
    state.workspaceEnabled = false;
    const { unmount } = renderSection([tip()]);
    expect(screen.queryByText("You should know")).toBeNull();
    unmount();

    state.workspaceEnabled = true;
    state.personalEnabled = false;
    renderSection([tip()]);
    expect(screen.queryByText("You should know")).toBeNull();
  });

  it("renders nothing without tips", () => {
    const { container } = renderSection([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("expands a tip to reveal its title and explanation", async () => {
    renderSection([tip({ title: "Blue-green", explanation: "Two environments, one live." })]);
    expect(screen.queryByText("Blue-green")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /The build is slow/ }));
    await waitFor(() => {
      expect(screen.getByText("Blue-green")).toBeInTheDocument();
      expect(screen.getByText("Two environments, one live.")).toBeInTheDocument();
    });
  });
});
