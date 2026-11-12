import { describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";
import { WikiDiffView } from "./engineering-baseline-diff";

vi.mock("../../rich-content/rich-code-block", () => ({
  isRichFenceLanguage: (language: string) => language === "mermaid" || language === "html",
  RichFenceBlock: ({ body }: { body: string }) => <div data-testid="rich-fence">{body}</div>,
  CodeBlockShell: ({ code }: { code: string }) => <pre data-testid="code-shell">{code}</pre>,
  StaticCodeBody: ({ body }: { body: string }) => <code>{body}</code>,
}));

describe("WikiDiffView rendered diff", () => {
  it("renders a heading-level change as a real heading with the attr badge", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"## 标题\n正文"} after={"### 标题\n正文"} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]");
    expect(mod).not.toBeNull();
    const heading = mod!.querySelector("h3");
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toContain("标题");
    expect(mod!.textContent).not.toContain("## ");
    expect(mod!.textContent).not.toContain("### ");
    expect(mod!.querySelector("span[class*='rounded-full']")).not.toBeNull();
  });

  it("maps word changes onto the rendered paragraph with spaces intact", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"The quick fox."} after={"The quick cat."} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]");
    expect(mod).not.toBeNull();
    expect(mod!.querySelector("ins")).not.toBeNull();
    expect(mod!.querySelector("del")).not.toBeNull();
    expect(mod!.textContent).toContain("The quick");
    expect(mod!.textContent).not.toContain("Thequick");
  });

  it("keeps a modified table rendered as a real table", () => {
    const { container } = renderWithI18n(
      <WikiDiffView
        before={"| a | b |\n| --- | --- |\n| 1 | 2 |"}
        after={"| a | b |\n| --- | --- |\n| 1 | 3 |"}
      />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]");
    expect(mod).not.toBeNull();
    expect(mod!.querySelector("th")).not.toBeNull();
    expect(mod!.querySelector("td")).not.toBeNull();
  });

  it("still renders added and removed blocks as markdown", () => {
    const added = renderWithI18n(<WikiDiffView before={"保留"} after={"保留\n\n## 新标题"} />);
    const addedBlock = added.container.querySelector("[data-wiki-diff-add]");
    expect(addedBlock).not.toBeNull();
    expect(addedBlock!.querySelector("h2")).not.toBeNull();

    const removed = renderWithI18n(<WikiDiffView before={"保留\n\n## 旧标题"} after={"保留"} />);
    const removedBlock = removed.container.querySelector("[data-wiki-diff-del]");
    expect(removedBlock).not.toBeNull();
    expect(removedBlock!.querySelector("h2")).not.toBeNull();
  });

  it("falls back to stacked rendered views when the DOM cannot reproduce the after source", () => {
    // Mostly-shared text keeps the pairing threshold happy (a mod, not
    // del+add), but the trailing image renders no text nodes: the add run
    // cannot be mapped past the exhausted DOM, so the view must fall back.
    const { container } = renderWithI18n(
      <WikiDiffView before={"说明文字 ![旧图](old.png)"} after={"说明文字 ![新图](new.png)"} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]");
    expect(mod).not.toBeNull();
    expect(mod!.querySelector("[data-wiki-diff-mod-fallback]")).not.toBeNull();
    // Both sides still render as markdown (images), never as a source dump.
    expect(mod!.querySelectorAll("img")).toHaveLength(2);
    expect(mod!.textContent).not.toContain("`");
    expect(mod!.textContent).not.toContain("![旧图](old.png)");
  });
});
