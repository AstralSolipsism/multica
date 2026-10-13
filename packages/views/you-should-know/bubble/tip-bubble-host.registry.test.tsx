import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TipAnchorRegistry } from "@multica/core/you-should-know/anchors";
import { tipDisplayLedger } from "@multica/core/you-should-know";
import { flush, getBubble, makeTip, mockLayout, renderWithYsk, settle } from "../../test/you-should-know";
import { RowAnchor } from "../../test/you-should-know-layers";
import { useTipAnchorRegistry } from "../anchors/tip-anchor-context";

const apiMock = vi.hoisted(() => ({
  listActiveTips: vi.fn(),
  setTipState: vi.fn(),
  getNotificationPreferences: vi.fn(),
  listWorkspaces: vi.fn(),
}));
vi.mock("@multica/core/api", () => ({ api: apiMock }));
vi.mock("@multica/core/auth", () => {
  const state = { user: { id: "user-1" } };
  return {
    useAuthStore: Object.assign(
      (selector: (snapshot: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: () => "Agent",
    getActorInitials: () => "AG",
    getActorAvatarUrl: () => null,
  }),
}));

const registryRef: { current: TipAnchorRegistry | null } = { current: null };
function RegistryProbe() {
  registryRef.current = useTipAnchorRegistry();
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  mockLayout();
  registryRef.current = null;
  for (const mock of Object.values(apiMock)) mock.mockReset();
  apiMock.listActiveTips.mockResolvedValue({ tips: [makeTip()] });
  localStorage.clear();
  tipDisplayLedger.setState({ users: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("drops the bubble with its anchor before the settled resync", async () => {
  apiMock.listActiveTips.mockResolvedValue({
    tips: [
      makeTip({ id: "first", issue_id: "issue-1", line: "First line" }),
      makeTip({ id: "second", issue_id: "issue-2", line: "Second line" }),
    ],
  });
  const view = renderWithYsk(
    <>
      <RowAnchor issueId="issue-1" top={300} />
      <RowAnchor issueId="issue-2" top={340} />
    </>,
  );
  await settle();
  expect(getBubble()).toHaveTextContent("First line");
  view.rerender(<RowAnchor issueId="issue-2" top={340} />);
  await flush();
  expect(getBubble()).toBeNull();
  await settle();
  expect(getBubble()).toHaveTextContent("Second line");
});

it("preserves registry cleanup until the settled resync after an anchor is reused", async () => {
  renderWithYsk(<RegistryProbe />);
  await flush();
  const registry = registryRef.current;
  if (!registry) throw new Error("expected the tip registry");
  const measure = () => ({ top: 100, left: 100, width: 40, height: 20 });
  act(() => {
    registry.getState().register({
      id: "bubble",
      descriptor: { level: "detail_header", issueId: "issue-1" },
      measure,
    });
    registry.getState().register({
      id: "dot",
      descriptor: { level: "row", issueId: "issue-1" },
      measure,
    });
    registry.getState().setAnchorVisible("bubble", true);
    registry.getState().setAnchorVisible("dot", true);
  });
  await settle();
  expect(registry.getState().display.dotAnchorIds).toEqual(["dot"]);

  act(() => registry.getState().unregister("dot"));
  await flush();
  expect(registry.getState().display.dotAnchorIds).toEqual([]);

  // A recycled anchor must not inherit its former issue's dot for a frame.
  act(() => {
    registry.getState().register({
      id: "dot",
      descriptor: { level: "row", issueId: "another-issue" },
      measure,
    });
    registry.getState().setAnchorVisible("dot", true);
  });
  await flush();
  expect(registry.getState().display.dotAnchorIds).toEqual([]);
  await settle();
  expect(registry.getState().display).toEqual({ bubbleAnchorId: "bubble", dotAnchorIds: [] });
});
