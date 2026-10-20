import { createRef } from "react";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithI18n } from "../test/i18n";
import { NavigationProvider } from "../navigation/context";
import { ContentEditor, type ContentEditorRef } from "./content-editor";
import { mathParagraphs } from "./math-fixtures";

vi.mock("@multica/core/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/paths")>()),
  useWorkspaceSlug: () => "",
}));

function mountEditor(markdown: string, controlled = false) {
  const ref = createRef<ContentEditorRef>();
  const onUpdate = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const result = renderWithI18n(
    <NavigationProvider value={{
      push: vi.fn(), replace: vi.fn(), back: vi.fn(), pathname: "/",
      searchParams: new URLSearchParams(), hash: "",
      getShareableUrl: (path) => `https://app.example${path}`,
    }}>
      <QueryClientProvider client={queryClient}>
        <ContentEditor
          ref={ref}
          {...(controlled ? { value: markdown } : { defaultValue: markdown })}
          onUpdate={onUpdate}
          debounceMs={0}
          disableMentions
          showBubbleMenu={false}
        />
      </QueryClientProvider>
    </NavigationProvider>,
  );
  return { ...result, ref, onUpdate };
}

describe("ContentEditor math", () => {
  it.each([false, true])("renders and saves real issue formulas (controlled=%s)", async (controlled) => {
    const markdown = [
      ...mathParagraphs.map((fixture) => fixture.markdown),
      String.raw`**阈值为 $< 1\sim 5\text{ms}$** and $$ x_i * y_j $$`,
    ].join("\n\n");
    const { container, ref, onUpdate } = mountEditor(markdown, controlled);
    const count = mathParagraphs.reduce((sum, fixture) => sum + fixture.expressions.length, 2);
    await waitFor(() => {
      expect(container.querySelectorAll(".math-node.inline .katex")).toHaveLength(count);
    });
    expect(container.querySelectorAll("strong .math-node.inline .katex")).toHaveLength(1);
    expect(ref.current?.getMarkdown()).toBe(markdown);

    act(() => { expect(ref.current?.insertMarkdownAtEnd("补充说明")).toBe(true); });
    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(`${markdown}\n\n补充说明`, markdown);
    });
    expect(container.querySelectorAll(".math-node.inline .katex")).toHaveLength(count);
  });

  it("parses pasted Markdown through the production extensions", async () => {
    const { container, ref } = mountEditor("");
    await waitFor(() => expect(container.querySelector(".ProseMirror")).not.toBeNull());
    const markdown = mathParagraphs[0]!.markdown;
    fireEvent.paste(container.querySelector(".ProseMirror")!, {
      clipboardData: {
        files: [],
        getData: (type: string) => type === "text/plain" ? markdown : "",
      },
    });
    await waitFor(() => {
      expect(container.querySelectorAll(".math-node.inline .katex")).toHaveLength(2);
    });
    expect(ref.current?.getMarkdown()).toBe(markdown);
  });

  it("keeps amounts, environment variables and code/link dollars literal", async () => {
    const markdown = [
      "Revenue ≈ $120/mo gross (~$85 net of fees)",
      "$100 and $200", "$100~$200", "100$ and 200$", "a$x$",
      String.raw`\$x$`, "$HOME/a to /$USER/b",
      "`$x$` and [$x$](https://example.com)",
    ].join("\n\n");
    const { container, ref } = mountEditor(markdown);
    await waitFor(() => expect(ref.current?.getMarkdown()).toContain("$120/mo"));
    expect(container.querySelector(".katex")).toBeNull();
  });
});
