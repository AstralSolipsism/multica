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
  jumped: [] as string[],
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

import { YouShouldKnowArchiveSection, groupTips } from "./archive-section";

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

function renderSection(
  tips: IssueTip[],
  onJumpToComment?: (id: string) => void,
  commentTime?: (id: string) => string | undefined,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(youShouldKnowKeys.issue("ws-1", "issue-1", "all"), {
    tips,
  });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <YouShouldKnowArchiveSection
        issueId="issue-1"
        identifier="OL-1"
        onJumpToComment={onJumpToComment}
        commentTime={commentTime}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.workspaceEnabled = true;
  state.personalEnabled = true;
  state.pushed = [];
  state.jumped = [];
  // Group labels carry an hour:minute, so pin the timezone to keep the
  // expected strings stable (the viewer's-TZ test re-stubs per case).
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

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
    expect(labels).toEqual(["Issue description", "Comment · Oct 2, 10:00 AM", "Comment · Oct 1, 10:00 AM"]);
    // Both c-old tips render inside their group.
    expect(screen.getByText("First tip")).toBeInTheDocument();
    expect(screen.getByText("Second tip")).toBeInTheDocument();
  });

  it("links a comment group header to its comment", () => {
    renderSection([tip({ anchor_comment_id: "c-1" })]);
    fireEvent.click(screen.getByRole("button", { name: /^Comment ·/ }));
    expect(state.pushed).toContain("/issues/OL-1#comment-c-1");
  });

  it("jumps via the callback when the mount provides one, falling back to the URL otherwise", () => {
    // With a callback: group header and overturned-by link both route
    // through it — the URL fallback cannot reach virtualized comments.
    renderSection(
      [
        tip({ anchor_comment_id: "c-1" }),
        tip({
          id: "o",
          anchor_comment_id: "c-2",
          line: "Was true",
          status: "overturned",
          overturned_by_comment_id: "c-9",
        }),
      ],
      (id) => state.jumped.push(id),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Comment ·/ }));
    expect(state.jumped).toEqual(["c-1"]);
    expect(state.pushed).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "No longer valid" }));
    fireEvent.click(screen.getByRole("button", { name: "Overturned by this comment" }));
    expect(state.jumped).toEqual(["c-1", "c-9"]);
    expect(state.pushed).toEqual([]);
  });

  it("groups and orders by the earliest tip when tips arrive in server order (newest first)", () => {
    // The server returns newest-first (ORDER BY created_at DESC): the same
    // comment's newer tip arrives before its older one, so "earliest" must
    // be computed, not inherited from arrival order.
    renderSection([
      tip({ id: "x-new", anchor_comment_id: "c-x", created_at: "2026-10-05T10:00:00Z" }),
      tip({ id: "y", anchor_comment_id: "c-y", created_at: "2026-10-03T10:00:00Z" }),
      tip({ id: "x-old", anchor_comment_id: "c-x", created_at: "2026-10-01T10:00:00Z" }),
    ]);

    // X sorts by its EARLIEST tip (10-01), so Y (10-03) comes first.
    const labels = screen.getAllByText(/^Comment ·/).map((el) => el.textContent);
    expect(labels).toEqual(["Comment · Oct 3, 10:00 AM", "Comment · Oct 1, 10:00 AM"]);
  });

  it("groups by earliest tip via groupTips regardless of input order", () => {
    const groups = groupTips([
      tip({ id: "x-new", anchor_comment_id: "c-x", created_at: "2026-10-05T10:00:00Z" }),
      tip({ id: "y", anchor_comment_id: "c-y", created_at: "2026-10-03T10:00:00Z" }),
      tip({ id: "x-old", anchor_comment_id: "c-x", created_at: "2026-10-01T10:00:00Z" }),
    ]);
    expect(groups.map((g) => [g.key, g.time])).toEqual([
      ["c-y", "2026-10-03T10:00:00Z"],
      ["c-x", "2026-10-01T10:00:00Z"],
    ]);
  });

  it("sorts groups by labelTime via groupTips, falling back to the earliest tip", () => {
    // c-early's tip is newer than c-late's, but the comment times decide the
    // order; c-unknown has no lookup entry and sorts by its earliest tip.
    const commentTime = (id: string) =>
      id === "c-early"
        ? "2026-10-13T08:00:00Z"
        : id === "c-late"
          ? "2026-10-13T08:30:00Z"
          : undefined;
    const groups = groupTips(
      [
        tip({ id: "a", anchor_comment_id: "c-early", created_at: "2026-10-13T09:00:00Z" }),
        tip({ id: "b", anchor_comment_id: "c-late", created_at: "2026-10-13T08:35:00Z" }),
        tip({ id: "c", anchor_comment_id: "c-unknown", created_at: "2026-10-13T08:10:00Z" }),
      ],
      commentTime,
    );
    expect(groups.map((g) => [g.key, g.labelTime])).toEqual([
      ["c-late", "2026-10-13T08:30:00Z"],
      ["c-unknown", "2026-10-13T08:10:00Z"],
      ["c-early", "2026-10-13T08:00:00Z"],
    ]);
  });

  it("labels groups with the viewer's local day, not the UTC day slice", () => {
    // 22:30 UTC on Oct 11 is already Oct 12 east of UTC+1:30. The label
    // must agree with the comment card's local timestamp.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-10-12T06:30:00Z"));
    try {
      vi.stubEnv("TZ", "Asia/Shanghai");
      renderSection([tip({ anchor_comment_id: "c-1", created_at: "2026-10-11T22:30:00Z" })]);
      expect(screen.getByText(/^Comment ·/).textContent).toBe("Comment · Oct 12, 6:30 AM");
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("labels same-day comment groups by the comment's own time so they read apart", () => {
    // OL-346 (YSK-36): two same-day comments each triggered a run and the
    // archive showed two identical "Comment · <day>" rows. The mount's
    // comment-time lookup supplies each comment's own created_at, which
    // differs from its earliest tip time — the label must follow the
    // comment, not the tip.
    const commentTime = (id: string) =>
      ({
        "c-morning": "2026-10-13T01:00:00Z",
        "c-afternoon": "2026-10-13T08:20:00Z",
      })[id];
    renderSection(
      [
        tip({ id: "a", anchor_comment_id: "c-morning", created_at: "2026-10-13T01:05:00Z" }),
        tip({ id: "b", anchor_comment_id: "c-afternoon", created_at: "2026-10-13T08:25:00Z" }),
      ],
      undefined,
      commentTime,
    );

    // Group order follows the same comment time the labels show (OL-387):
    // c-afternoon (8:20) sorts above c-morning (1:00).
    const labels = screen.getAllByText(/^Comment ·/).map((el) => el.textContent);
    expect(labels).toEqual(["Comment · Oct 13, 8:20 AM", "Comment · Oct 13, 1:00 AM"]);
  });

  it("orders groups by the label time so out-of-order runs never invert the labels (OL-387)", () => {
    // Two comments trigger runs that finish out of order: c-late's tip lands
    // before c-early's. Sorting by the earliest tip (pre-OL-387) put the
    // "8:00" label above the "8:30" one; sorting by the label time keeps the
    // visible times descending.
    const commentTime = (id: string) =>
      ({
        "c-early": "2026-10-13T08:00:00Z",
        "c-late": "2026-10-13T08:30:00Z",
      })[id];
    renderSection(
      [
        tip({ id: "a", anchor_comment_id: "c-early", created_at: "2026-10-13T09:00:00Z" }),
        tip({ id: "b", anchor_comment_id: "c-late", created_at: "2026-10-13T08:35:00Z" }),
      ],
      undefined,
      commentTime,
    );

    const labels = screen.getAllByText(/^Comment ·/).map((el) => el.textContent);
    expect(labels).toEqual(["Comment · Oct 13, 8:30 AM", "Comment · Oct 13, 8:00 AM"]);
  });

  it("falls back to the group's earliest tip time when the comment is not loaded", () => {
    renderSection(
      [
        tip({ id: "a", anchor_comment_id: "c-gone", created_at: "2026-10-13T09:05:00Z" }),
        tip({ id: "b", anchor_comment_id: "c-gone", created_at: "2026-10-13T09:01:00Z" }),
      ],
      undefined,
      () => undefined,
    );
    expect(screen.getByText(/^Comment ·/).textContent).toBe("Comment · Oct 13, 9:01 AM");
  });

  it("falls back to the group's earliest tip time when the comment time is unparseable", () => {
    renderSection(
      [
        tip({ id: "a", anchor_comment_id: "c-bad", created_at: "2026-10-13T09:05:00Z" }),
        tip({ id: "b", anchor_comment_id: "c-bad", created_at: "2026-10-13T09:01:00Z" }),
      ],
      undefined,
      () => "not-a-date",
    );
    expect(screen.getByText(/^Comment ·/).textContent).toBe("Comment · Oct 13, 9:01 AM");
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
    // Valid rows render without the greying class.
    expect(screen.getByText("Valid tip").closest("div")).not.toHaveClass("opacity-60");

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
    // The greying is the visual signal; data-invalid alone is not enough.
    expect(row).toHaveClass("opacity-60");

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
