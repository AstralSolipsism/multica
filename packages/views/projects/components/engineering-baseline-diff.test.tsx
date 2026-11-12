import { describe, expect, it, vi } from "vitest";
import { renderWithI18n } from "../../test/i18n";
import { WikiDiffView } from "./engineering-baseline-diff";
import type { WikiLink } from "@multica/core/api";

function link(overrides: Partial<WikiLink>): WikiLink {
  return {
    raw: "", display: "", target: "", section: "", kind: "page", state: "resolved",
    targetSlug: "", sectionAnchor: null, candidates: [], ...overrides,
  };
}
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
  it("marks image changes with rendered del/ins images instead of falling back", () => {
    // Both sides render through the pipeline; images are atomic tokens, so a
    // src change becomes an inline del of the old rendered image plus the new
    // image wrapped in ins — never a source dump.
    const { container } = renderWithI18n(
      <WikiDiffView before={"说明文字 ![旧图](old.png)"} after={"说明文字 ![新图](new.png)"} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]");
    expect(mod).not.toBeNull();
    expect(mod!.querySelector("[data-wiki-diff-mod-fallback]")).toBeNull();
    const marks = mod!.querySelectorAll("del, ins");
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(mod!.querySelectorAll("img")).toHaveLength(3); // hidden before render + del clone + new
    const del = mod!.querySelector("del");
    expect(del!.querySelector("img")!.getAttribute("src")).toBe("old.png");
    const ins = mod!.querySelector("ins");
    expect(ins!.querySelector("img")!.getAttribute("src")).toBe("new.png");
    expect(mod!.textContent).not.toContain("![旧图](old.png)");
    expect(mod!.textContent).not.toContain("`");
  });

  it("marks an inserted word inside a rendered heading with <ins>", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"## Hello world"} after={"## Hello brave world"} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]");
    expect(mod).not.toBeNull();
    const ins = mod!.querySelector("h2 ins");
    expect(ins).not.toBeNull();
    expect(ins!.textContent).toContain("brave");
  });

  it("deletes a bold word as rendered <del><strong>, never literal **", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"Keep **strict** rules here."} after={"Keep rules here."} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]");
    expect(mod).not.toBeNull();
    const del = mod!.querySelector("del");
    expect(del).not.toBeNull();
    expect(del!.querySelector("strong")!.textContent).toBe("strict");
    const marked = Array.from(mod!.querySelectorAll("ins, del")).map((el) => el.textContent).join("");
    expect(marked).not.toContain("**");
  });

  it("dels/inses rendered link text on a target change, no ](/ source", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"See [规范](/old) now."} after={"See [规范](/new) now."} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]");
    expect(mod).not.toBeNull();
    const del = mod!.querySelector("del");
    expect(del).not.toBeNull();
    expect(del!.querySelector('a[href="/old"]')!.textContent).toBe("规范");
    const ins = mod!.querySelector("a ins") ?? mod!.querySelector("ins");
    expect(ins).not.toBeNull();
    expect(ins!.textContent).toContain("规范");
    const marked = Array.from(mod!.querySelectorAll("ins, del")).map((el) => el.textContent).join("");
    expect(marked).not.toContain("](/");
  });

  it("dels/inses wiki-link chips on a target change, no [[…]] source", () => {
    const links = [
      link({ raw: "auth|认证", display: "认证", target: "auth", targetSlug: "auth" }),
      link({ raw: "auth2|认证", display: "认证", target: "auth2", targetSlug: "auth2" }),
    ];
    const { container } = renderWithI18n(
      <WikiDiffView before={"See [[auth|认证]] now."} after={"See [[auth2|认证]] now."} links={links} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]");
    expect(mod).not.toBeNull();
    const del = mod!.querySelector("del");
    expect(del).not.toBeNull();
    const delChip = del!.querySelector('[data-wiki-link="auth"]');
    expect(delChip).not.toBeNull();
    expect(delChip!.textContent).toBe("认证");
    const ins = mod!.querySelector('[data-wiki-link="auth2"] ins') ?? mod!.querySelector("ins");
    expect(ins).not.toBeNull();
    expect(ins!.textContent).toContain("认证");
    const marked = Array.from(mod!.querySelectorAll("ins, del")).map((el) => el.textContent).join("");
    expect(marked).not.toContain("[[");
  });

  it("shows inline-code changes as rendered code inside ins/del, no backticks", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"Run `make test` first."} after={"Run `make check` first."} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]");
    expect(mod).not.toBeNull();
    const del = mod!.querySelector("del");
    expect(del).not.toBeNull();
    expect(del!.querySelector("code")!.textContent).toBe("test");
    const ins = mod!.querySelector("code ins") ?? mod!.querySelector("ins");
    expect(ins).not.toBeNull();
    expect(ins!.textContent).toContain("check");
    const marked = Array.from(mod!.querySelectorAll("ins, del")).map((el) => el.textContent).join("");
    expect(marked).not.toContain("`");
  });
});

describe("WikiDiffView deletion placement", () => {
  it("places a mid-paragraph deletion at its original position", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"Use **strict** mode now please."} after={"Use mode now please."} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]")!;
    // Scope to the visible after container; the hidden before copy also holds
    // the old text and would skew raw innerHTML indexes.
    const after = mod.querySelector(":scope > div:not([hidden])")!;
    const html = after.innerHTML;
    // The <del> sits between "Use " and "mode", never inside "now".
    expect(html.indexOf("<del")).toBeGreaterThan(html.indexOf("Use"));
    expect(html.indexOf("<del")).toBeLessThan(html.indexOf("mode"));
    expect(after.querySelector("del strong")?.textContent).toContain("strict");
    expect(html.indexOf("now")).toBeGreaterThan(html.indexOf("</del>"));
  });

  it("places a mid-sentence CJK deletion before the surviving tail, inside the paragraph", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"第一句。第二句要删除。第三句保留。"} after={"第一句。第三句保留。"} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]")!;
    const paragraph = mod.querySelector(":scope > div:not([hidden]) p")!;
    expect(paragraph.innerHTML).toContain("第二句要删除。");
    expect(paragraph.innerHTML.indexOf("<del")).toBeGreaterThan(paragraph.innerHTML.indexOf("第一句"));
    expect(paragraph.innerHTML.indexOf("<del")).toBeLessThan(paragraph.innerHTML.indexOf("第三句"));
  });

  it("keeps a trailing deletion at the paragraph end", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"Keep this line always. Delete this tail."} after={"Keep this line always."} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]")!;
    const paragraph = mod.querySelector(":scope > div:not([hidden]) p")!;
    const html = paragraph.innerHTML;
    expect(paragraph.querySelector("del")?.textContent).toContain("Delete this tail.");
    // The del mark comes after the surviving text, still inside the <p>.
    expect(html.indexOf("<del")).toBeGreaterThan(html.indexOf("Keep this."));
  });
});

describe("WikiDiffView fenced blocks", () => {
  it("renders whole-block stacked compare for a mermaid fence change", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"```mermaid\nflowchart LR\nA-->B\n```"} after={"```mermaid\nflowchart LR\nA-->C\n```"} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]")!;
    expect(mod.querySelector("[data-wiki-diff-mod-fallback]")).not.toBeNull();
    const fences = mod.querySelectorAll("[data-testid='rich-fence']");
    expect(fences.length).toBe(2);
    expect(fences[0]!.textContent).toContain("A-->B");
    expect(fences[1]!.textContent).toContain("A-->C");
    // The hidden before copy never mounts for fence blocks.
    expect(mod.querySelector("[data-wiki-diff-mod-before]")).toBeNull();
  });

  it("renders whole-block stacked compare for a plain code fence change", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"```ts\nfoo()\n```"} after={"```ts\nbar()\n```"} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]")!;
    expect(mod.querySelector("[data-wiki-diff-mod-fallback]")).not.toBeNull();
    expect(mod.querySelectorAll("[data-testid='code-shell']").length).toBe(2);
  });

  it("re-running the overlay keeps exactly one set of marks", () => {
    const initial = renderWithI18n(<WikiDiffView before={"Use **strict** mode now."} after={"Use mode now."} />);
    const mod = initial.container.querySelector("[data-wiki-diff-mod]")!;
    expect(mod.querySelectorAll("del").length).toBe(1);
    // Re-run the effect path by moving through another revision and back:
    // clearDiffMarks must leave a single clean set of marks.
    initial.rerender(<WikiDiffView before={"Use **loose** mode now."} after={"Use mode now."} />);
    initial.rerender(<WikiDiffView before={"Use **strict** mode now."} after={"Use mode now."} />);
    const finalMod = initial.container.querySelector("[data-wiki-diff-mod]")!;
    expect(finalMod.querySelectorAll("del").length).toBe(1);
    expect(finalMod.querySelectorAll("ins").length).toBe(0);
    expect(finalMod.innerHTML).toContain("<strong>strict</strong>");
    expect(finalMod.innerHTML).not.toContain("loose");
  });
});

describe("WikiDiffView native strikethrough", () => {
  it("keeps GFM strikethrough content in a modified paragraph", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"旧接口 ~~v1~~ 已废弃，请用 v2。"} after={"旧接口 ~~v1~~ 已废弃，请改用 v2。"} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]")!;
    const after = mod.querySelector(":scope > div:not([hidden])")!;
    // The native <del>v1</del> survives as content, distinct from diff marks.
    const native = after.querySelector(`p > del:not([data-wiki-diff-mark])`);
    expect(native?.textContent).toBe("v1");
    expect(after.textContent).toContain("旧接口");
    // The word change still marks: 请用 del'd, 请改用 ins'd.
    expect(after.querySelector(`del[data-wiki-diff-mark]`)?.textContent).toContain("请用");
    expect(after.querySelector(`ins[data-wiki-diff-mark]`)?.textContent).toContain("请改用");
  });

  it("marks adding strikethrough as a deletion of the struck word and vice versa", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"接口 v1 已废弃。"} after={"接口 ~~v1~~ 已废弃。"} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]")!;
    const after = mod.querySelector(":scope > div:not([hidden])")!;
    // Signature change: plain "v1" del-marked, struck "v1" ins-marked.
    expect(after.querySelector(`del[data-wiki-diff-mark]`)?.textContent).toContain("v1");
    expect(after.querySelector(`ins[data-wiki-diff-mark]`)?.textContent).toContain("v1");

    const removed = renderWithI18n(
      <WikiDiffView before={"接口 ~~v1~~ 已废弃。"} after={"接口 v1 已废弃。"} />,
    );
    const mod2 = removed.container.querySelector("[data-wiki-diff-mod]")!;
    const after2 = mod2.querySelector(":scope > div:not([hidden])")!;
    expect(after2.querySelector(`del[data-wiki-diff-mark]`)?.textContent).toContain("v1");
    expect(after2.querySelector(`ins[data-wiki-diff-mark]`)?.textContent).toContain("v1");
  });

  it("falls back to stacked renders when only an escape differs in the source", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"价格 10\\*2 元"} after={"价格 10*2 元"} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]")!;
    expect(mod.querySelector("[data-wiki-diff-mod-fallback]")).not.toBeNull();
  });

  it("keeps a deletion next to bold text out of the strong element", () => {
    const { container } = renderWithI18n(
      <WikiDiffView before={"Use plain **bold** end"} after={"Use **bold** end"} />,
    );
    const mod = container.querySelector("[data-wiki-diff-mod]")!;
    const after = mod.querySelector(":scope > div:not([hidden])")!;
    const strong = after.querySelector("strong")!;
    expect(strong.textContent).toBe("bold");
    const delMark = after.querySelector(`del[data-wiki-diff-mark]`)!;
    expect(delMark.textContent).toContain("plain");
    // The mark is a sibling before the strong, not inside it.
    expect(delMark.parentElement?.tagName).toBe("P");
    expect(strong.parentElement?.tagName).toBe("P");
    expect(after.innerHTML.indexOf("<del")).toBeLessThan(after.innerHTML.indexOf("<strong"));
  });
});
