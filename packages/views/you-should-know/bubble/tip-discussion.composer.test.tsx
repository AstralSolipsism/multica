// @vitest-environment jsdom

/**
 * "Discuss in comments" against the real comment composer (OL-196). With the
 * issue's comment box on the page, the quoted tip shows up in it at once: the
 * composer follows its persisted draft, opens its editor on it and focuses it
 * (which scrolls it into view). No navigation, no send. The editor is a
 * stand-in — Tiptap needs layout jsdom lacks — and everything else is real.
 */

import { forwardRef, useEffect, useImperativeHandle, type Ref } from "react";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCommentDraftStore } from "@multica/core/issues/stores";
import { tipDisplayLedger } from "@multica/core/you-should-know";
import {
  getBubble,
  makeTip,
  mockLayout,
  renderWithYsk,
  settle,
} from "../../test/you-should-know";

const apiMock = vi.hoisted(() => ({
  listActiveTips: vi.fn(),
  setTipState: vi.fn(),
  getNotificationPreferences: vi.fn(),
  listWorkspaces: vi.fn(),
  listQuickActions: vi.fn(),
  previewCommentTriggers: vi.fn(),
  listTasksByIssue: vi.fn(),
  cancelTask: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("@multica/core/api", () => ({ api: apiMock }));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: "user-1" } }),
}));

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `Agent ${id}`,
    getActorInitials: () => "AG",
    getActorAvatarUrl: () => null,
  }),
}));

const editorFocus = vi.hoisted(() => vi.fn());

vi.mock("../../editor", async () => ({
  // The composer's lazy-mount, upload gate and submit flow are pure React:
  // keep them real, so shell → editor → focus runs as in production.
  ...(await vi.importActual<typeof import("../../editor/use-lazy-editor")>(
    "../../editor/use-lazy-editor",
  )),
  ...(await vi.importActual<typeof import("../../editor/use-upload-gate")>(
    "../../editor/use-upload-gate",
  )),
  ...(await vi.importActual<typeof import("../../editor/use-composer-submit")>(
    "../../editor/use-composer-submit",
  )),
  useFileDropZone: () => ({ isDragOver: false, dropZoneProps: {} }),
  FileDropOverlay: () => null,
  ContentEditor: forwardRef(function MockContentEditor(
    { value, onReady }: { value?: string; onReady?: () => void },
    ref: Ref<unknown>,
  ) {
    useEffect(() => {
      onReady?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useImperativeHandle(ref, () => ({
      focus: editorFocus,
      focusAtCoords: () => {},
      getMarkdown: () => value ?? "",
      hasActiveUploads: () => false,
    }));
    return <textarea data-testid="comment-editor" readOnly value={value ?? ""} />;
  }),
}));

import { AgentAvatarStack } from "../../agents/components/agent-avatar-stack";
import { CommentInput } from "../../issues/components/comment-input";

function IssuePage() {
  return (
    <>
      <div data-test-rect="1000,40,60,20">
        <AgentAvatarStack
          agentIds={["agent-1"]}
          tipAnchor={{ level: "detail_header", issueId: "issue-1" }}
        />
      </div>
      <CommentInput issueId="issue-1" onSubmit={vi.fn()} />
    </>
  );
}

async function discussFromCard() {
  fireEvent.click(getBubble()!.querySelector("button[aria-expanded]")!);
  fireEvent.click(within(getBubble()!).getByRole("button", { name: "Learn more" }));
  fireEvent.click(within(getBubble()!).getByRole("button", { name: "Discuss in comments" }));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  mockLayout();
  for (const fn of Object.values(apiMock)) fn.mockReset();
  apiMock.listActiveTips.mockResolvedValue({
    tips: [
      makeTip({
        id: "first",
        issue_id: "issue-1",
        line: "Kept the old API",
        explanation: "Clients still call it.",
      }),
    ],
  });
  apiMock.listQuickActions.mockResolvedValue([]);
  apiMock.listTasksByIssue.mockResolvedValue([]);
  editorFocus.mockReset();
  localStorage.clear();
  tipDisplayLedger.setState({ users: {} });
  useCommentDraftStore.setState({ drafts: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Discuss in comments, with the issue's comment box on the page", () => {
  it("opens the comment box on the quoted tip and focuses it", async () => {
    const { navigation } = renderWithYsk(<IssuePage />);
    await settle();
    expect(screen.getByTestId("comment-composer-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("comment-editor")).not.toBeInTheDocument();

    await discussFromCard();

    expect(screen.getByTestId("comment-editor")).toHaveValue(
      ["> ✦ You should know · Kept the old API", ">", "> Clients still call it."].join("\n"),
    );
    expect(editorFocus).toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(apiMock.setTipState).not.toHaveBeenCalled();
  });

  it("adds the quote after what is already in the comment box", async () => {
    useCommentDraftStore.getState().setDraft("new:issue-1", "My notes");
    renderWithYsk(<IssuePage />);
    await settle();
    expect(screen.getByTestId("comment-editor")).toHaveValue("My notes");

    await discussFromCard();

    expect(screen.getByTestId("comment-editor")).toHaveValue(
      [
        "My notes",
        "",
        "> ✦ You should know · Kept the old API",
        ">",
        "> Clients still call it.",
      ].join("\n"),
    );
    expect(editorFocus).toHaveBeenCalled();
  });
});
