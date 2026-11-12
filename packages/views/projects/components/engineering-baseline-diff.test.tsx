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
