import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Attachment, SourceContextAttachment } from "@multica/core/types";
import { renderWithI18n } from "../test/i18n";
import {
  EntityAttachmentsProvider,
  type EntityAttachment,
  type EntityAttachmentsStatus,
} from "../rich-content/entity-attachments-context";
import { DYNAMIC_BLOCK_CHROME_PX, DYNAMIC_BLOCK_MIN_BODY_PX } from "./dynamic-block";
import { AttachmentHtmlBlock } from "./attachment-html-block";

const {
  getAttachmentTextContentMock,
  FakePreviewTooLargeError,
  FakePreviewUnsupportedError,
} = vi.hoisted(() => {
  class FakePreviewTooLargeError extends Error {}
  class FakePreviewUnsupportedError extends Error {}
  return {
    getAttachmentTextContentMock: vi.fn(),
    FakePreviewTooLargeError,
    FakePreviewUnsupportedError,
  };
});

vi.mock("@multica/core/api", () => ({
  api: { getAttachmentTextContent: getAttachmentTextContentMock },
  PreviewTooLargeError: FakePreviewTooLargeError,
  PreviewUnsupportedError: FakePreviewUnsupportedError,
}));

vi.mock("../rich-content/lazy-rich-block", () => ({
  LazyRichBlock: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("./html-block-preview", () => ({
  HtmlBlockPreview: ({ html, title }: { html: string; title?: string | null }) => (
    <div data-testid="html-preview" data-title={title ?? ""}>{html}</div>
  ),
}));

const FALLBACK = "<p>Open the attachment below.</p>";
const RESERVED_HEIGHT_PX = DYNAMIC_BLOCK_CHROME_PX + DYNAMIC_BLOCK_MIN_BODY_PX;

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att-1",
    workspace_id: "ws-1",
    issue_id: "issue-1",
    comment_id: "comment-1",
    chat_session_id: null,
    chat_message_id: null,
    uploader_type: "agent",
    uploader_id: "agent-1",
    filename: "decision.html",
    url: "/uploads/decision.html",
    download_url: "/api/attachments/att-1/download",
    markdown_url: "/api/attachments/att-1/download",
    content_type: "text/html",
    size_bytes: 100,
    created_at: "2026-11-09T01:00:00Z",
    ...overrides,
  };
}

function renderBlock(options: {
  attachments?: readonly EntityAttachment[];
  phase?: "streaming" | "settled";
  status?: EntityAttachmentsStatus;
  src?: string;
} = {}) {
  const attachments = "attachments" in options ? options.attachments : [makeAttachment()];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <EntityAttachmentsProvider
        attachments={attachments}
        phase={options.phase ?? "settled"}
        status={options.status ?? "ready"}
      >
        <AttachmentHtmlBlock
          src={options.src ?? "decision.html"}
          fallbackHtml={FALLBACK}
          title="Decision"
          reservedHeightPx={RESERVED_HEIGHT_PX}
        />
      </EntityAttachmentsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getAttachmentTextContentMock.mockReset();
});

describe("AttachmentHtmlBlock", () => {
  it("renders the attachment and ignores the inline fallback", async () => {
    getAttachmentTextContentMock.mockResolvedValue({
      text: "<h1>Attachment decision</h1>",
      originalContentType: "text/html",
    });
    renderBlock();

    const preview = await screen.findByTestId("html-preview");
    expect(preview).toHaveTextContent("Attachment decision");
    expect(preview).not.toHaveTextContent("Open the attachment below");
    expect(preview).toHaveAttribute("data-title", "Decision");
    expect(getAttachmentTextContentMock).toHaveBeenCalledExactlyOnceWith("att-1");
  });

  it("shows the loading skeleton while attachment text is pending", () => {
    getAttachmentTextContentMock.mockReturnValue(new Promise(() => {}));
    const { container } = renderBlock();

    expect(screen.getByText("Loading preview…")).toBeInTheDocument();
    expect(container.querySelector("[data-dynamic-block='html']")).not.toBeNull();
    expect(screen.queryByTestId("html-preview")).toBeNull();
  });

  it("waits for a streaming reply without requesting an unbound attachment", () => {
    renderBlock({ attachments: [], phase: "streaming" });

    expect(screen.getByText("The preview loads when the reply is complete.")).toBeInTheDocument();
    expect(getAttachmentTextContentMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("html-preview")).toBeNull();
  });

  it("keeps waiting while attachment metadata is pending beyond two seconds", () => {
    vi.useFakeTimers();
    try {
      renderBlock({ attachments: undefined, status: "loading" });
      expect(screen.getByText("Loading preview…")).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(2_100));
      expect(screen.getByText("Loading preview…")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByTestId("html-preview")).toBeNull();
      expect(getAttachmentTextContentMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports metadata read failure instead of a missing attachment", () => {
    renderBlock({ attachments: undefined, status: "error" });

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load preview");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Couldn't find HTML attachment");
    expect(screen.getByTestId("html-preview")).toHaveTextContent(FALLBACK);
    expect(getAttachmentTextContentMock).not.toHaveBeenCalled();
  });

  it("renders the fallback and explains a missing attachment", () => {
    renderBlock({ attachments: [] });

    expect(screen.getByTestId("html-preview")).toHaveTextContent(FALLBACK);
    expect(screen.getByRole("alert")).toHaveTextContent(
      'Couldn\'t find HTML attachment "decision.html" on this comment or reply.',
    );
    expect(getAttachmentTextContentMock).not.toHaveBeenCalled();
  });

  it.each([
    ["413", new FakePreviewTooLargeError(), "File is too large to preview. Please download."],
    ["415", new FakePreviewUnsupportedError(), "This file type can't be previewed."],
    ["other", new Error("offline"), "Couldn't load preview"],
  ])("renders the fallback with the %s error reason", async (_name, error, reason) => {
    getAttachmentTextContentMock.mockRejectedValue(error);
    renderBlock();

    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
    expect(screen.getByTestId("html-preview")).toHaveTextContent(FALLBACK);
  });

  it("selects the latest eligible HTML attachment with the exact filename", async () => {
    getAttachmentTextContentMock.mockResolvedValue({ text: "<p>Latest</p>" });
    renderBlock({
      attachments: [
        makeAttachment({ id: "old", created_at: "2026-11-09T00:00:00Z" }),
        makeAttachment({ id: "other-file", filename: "other.html", created_at: "2026-11-09T03:00:00Z" }),
        makeAttachment({ id: "latest", created_at: "2026-11-09T02:00:00Z" }),
        makeAttachment({ id: "not-html", filename: "decision.txt", content_type: "text/plain", created_at: "2026-11-09T04:00:00Z" }),
      ],
    });

    expect(await screen.findByTestId("html-preview")).toHaveTextContent("Latest");
    expect(getAttachmentTextContentMock).toHaveBeenCalledExactlyOnceWith("latest");
  });

  it("orders RFC3339 fractional seconds chronologically", async () => {
    getAttachmentTextContentMock.mockResolvedValue({ text: "<p>fractional</p>" });
    renderBlock({
      attachments: [
        makeAttachment({ id: "whole-second", created_at: "2026-11-09T01:00:00Z" }),
        makeAttachment({ id: "fractional-second", created_at: "2026-11-09T01:00:00.500Z" }),
      ],
    });

    expect(await screen.findByTestId("html-preview")).toHaveTextContent("fractional");
    expect(getAttachmentTextContentMock).toHaveBeenCalledExactlyOnceWith("fractional-second");
  });

  it("uses id order when same-named uploads share a timestamp", async () => {
    getAttachmentTextContentMock.mockResolvedValue({ text: "<p>newer</p>" });
    renderBlock({
      attachments: [
        makeAttachment({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
        makeAttachment({ id: "00000000-0000-4000-8000-000000000000" }),
      ],
    });

    expect(await screen.findByTestId("html-preview")).toHaveTextContent("newer");
    expect(getAttachmentTextContentMock).toHaveBeenCalledExactlyOnceWith(
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    );
  });

  it.each([
    ["HTML MIME without an extension", makeAttachment({ filename: "decision", content_type: "text/html; charset=utf-8" }), "decision"],
    ["HTM extension without an HTML MIME", makeAttachment({ filename: "decision.htm", content_type: "application/octet-stream" }), "decision.htm"],
  ])("accepts %s", async (_name, attachment, src) => {
    getAttachmentTextContentMock.mockResolvedValue({ text: "<p>ok</p>" });
    renderBlock({ attachments: [attachment], src });

    expect(await screen.findByTestId("html-preview")).toHaveTextContent("ok");
  });

  it("loads a source-context clone through its cloned attachment id", async () => {
    const attachment: SourceContextAttachment = {
      id: "clone-1",
      source_attachment_id: "original-1",
      owner_type: "comment",
      owner_id: "snapshot-comment-1",
      filename: "decision.html",
      content_type: "text/html",
      size_bytes: 100,
      created_at: "2026-11-09T01:00:00Z",
    };
    getAttachmentTextContentMock.mockResolvedValue({ text: "<p>snapshot</p>" });
    renderBlock({ attachments: [attachment] });

    expect(await screen.findByTestId("html-preview")).toHaveTextContent("snapshot");
    expect(getAttachmentTextContentMock).toHaveBeenCalledExactlyOnceWith("clone-1");
  });

  it.each([
    "https://example.test/decision.html",
    "https:decision.html",
    "/api/attachments/att-1/content",
    "../decision.html",
  ])("rejects URL or path reference %s even when a filename matches", (src) => {
    renderBlock({ src, attachments: [makeAttachment({ filename: src })] });

    expect(screen.getByTestId("html-preview")).toHaveTextContent(FALLBACK);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't find HTML attachment");
    expect(getAttachmentTextContentMock).not.toHaveBeenCalled();
  });

  it("does not reuse an error after the selected attachment changes", async () => {
    getAttachmentTextContentMock.mockRejectedValueOnce(new Error("offline"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (attachmentId: string) => (
      <QueryClientProvider client={client}>
        <EntityAttachmentsProvider
          attachments={[makeAttachment({ id: attachmentId })]}
          phase="settled"
        >
          <AttachmentHtmlBlock
            src="decision.html"
            fallbackHtml={FALLBACK}
            reservedHeightPx={RESERVED_HEIGHT_PX}
          />
        </EntityAttachmentsProvider>
      </QueryClientProvider>
    );
    const view = renderWithI18n(ui("old"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load preview");

    getAttachmentTextContentMock.mockResolvedValueOnce({ text: "<p>new</p>" });
    view.rerender(ui("new"));

    await waitFor(() => expect(screen.getByTestId("html-preview")).toHaveTextContent("new"));
    expect(getAttachmentTextContentMock).toHaveBeenNthCalledWith(2, "new");
  });
});
