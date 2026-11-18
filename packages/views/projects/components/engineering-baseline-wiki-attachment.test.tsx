import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Attachment } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { EntityAttachmentsProvider } from "../../rich-content/entity-attachments-context";
import { WikiMarkdown } from "./engineering-baseline-markdown";

const { getAttachmentTextContentMock } = vi.hoisted(() => {
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
  PreviewTooLargeError: class extends Error {},
  PreviewUnsupportedError: class extends Error {},
}));

vi.mock("../../editor/html-block-preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../editor/html-block-preview")>();
  return {
    ...actual,
    HtmlBlockPreview: ({ html, title }: { html: string; title?: string | null }) => (
      <div data-testid="wiki-html-preview" data-title={title ?? ""}>{html}</div>
    ),
  };
});

vi.mock("../../issues/hooks", () => ({ useResolveIssueIdentifier: () => null }));

function canvasAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att-canvas",
    workspace_id: "ws-1",
    issue_id: null,
    comment_id: null,
    chat_session_id: null,
    chat_message_id: null,
    uploader_type: "agent",
    uploader_id: "agent-1",
    filename: "architecture.html",
    url: "/uploads/architecture.html",
    download_url: "/api/attachments/att-canvas/download",
    markdown_url: "/api/attachments/att-canvas/download",
    content_type: "text/html",
    size_bytes: 4096,
    created_at: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

const MARKDOWN = "## 架构\n\n```html src=\"architecture.html\" title=\"架构画布\"\n交互画布见附件。\n```\n";

function renderWiki(attachments: Attachment[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return renderWithI18n(
    <QueryClientProvider client={client}>
      <EntityAttachmentsProvider attachments={attachments} phase="settled">
        <WikiMarkdown markdown={MARKDOWN} />
      </EntityAttachmentsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getAttachmentTextContentMock.mockReset();
});

describe("WikiMarkdown attachment canvas", () => {
  it("inlines a page-bound LikeC4 canvas through the shared HTML block", async () => {
    getAttachmentTextContentMock.mockResolvedValue({
      text: "<!doctype html><html><body>likec4 canvas</body></html>",
      originalContentType: "text/html",
    });
    renderWiki([canvasAttachment()]);

    const preview = await screen.findByTestId("wiki-html-preview");
    expect(preview).toHaveTextContent("likec4 canvas");
    expect(preview).toHaveAttribute("data-title", "架构画布");
    expect(getAttachmentTextContentMock).toHaveBeenCalledExactlyOnceWith("att-canvas");
  });

  it("resolves a same-named artifact to the newest upload", async () => {
    getAttachmentTextContentMock.mockResolvedValue({
      text: "<html><body>latest</body></html>",
      originalContentType: "text/html",
    });
    renderWiki([
      canvasAttachment({ id: "att-old", created_at: "2026-11-01T00:00:00Z" }),
      canvasAttachment({ id: "att-new", created_at: "2026-11-02T00:00:00Z" }),
    ]);

    await screen.findByTestId("wiki-html-preview");
    expect(getAttachmentTextContentMock).toHaveBeenCalledExactlyOnceWith("att-new");
  });

  it("does not fetch when the page has no matching artifact", async () => {
    renderWiki([canvasAttachment({ filename: "other.html" })]);

    expect(await screen.findByText(/attachment .*architecture\.html/i)).toBeInTheDocument();
    expect(getAttachmentTextContentMock).not.toHaveBeenCalled();
  });
});
