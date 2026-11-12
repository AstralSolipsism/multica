import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";
import { WikiMarkdown } from "./engineering-baseline-markdown";
import type { WikiLink, WikiTreeSection } from "@multica/core/api";

vi.mock("../../rich-content/rich-code-block", () => ({
  isRichFenceLanguage: (language: string) => language === "mermaid" || language === "html",
  RichFenceBlock: ({ body }: { body: string }) => <div data-testid="rich-fence">{body}</div>,
  CodeBlockShell: ({ code, children }: { code: string; children?: React.ReactNode }) => <pre data-testid="code-shell">{code}{children}</pre>,
  StaticCodeBody: ({ body }: { body: string }) => <code>{body}</code>,
}));

const sections: WikiTreeSection[] = [
  { anchor: "billing-ledger", title: "Billing Ledger", level: 2 },
  { anchor: "checkout", title: "Checkout", level: 2 },
];

function link(overrides: Partial<WikiLink>): WikiLink {
  return {
    raw: "Billing Ledger", display: "Billing Ledger", target: "Billing Ledger", section: "",
    kind: "page", state: "resolved", targetSlug: "billing-ledger", sectionAnchor: null, candidates: [],
    ...overrides,
  };
}

describe("WikiMarkdown", () => {
  it("renders [[wikilinks]] as chips: resolved navigable, missing dashed with create, unknown literal", async () => {
    const onNavigate = vi.fn();
    const onCreateMissing = vi.fn();
    renderWithI18n(
      <WikiMarkdown
        markdown={"Intro with [[Billing Ledger]] and [[Ghost Page]] and [[Unresolved]] links.\n\n## Billing Ledger\n\nOwns invoices."}
        sections={sections}
        links={[
          link({}),
          link({ raw: "Ghost Page", display: "Ghost Page", target: "Ghost Page", state: "missing", targetSlug: null }),
        ]}
        onNavigate={onNavigate}
        onCreateMissing={onCreateMissing}
      />,
    );

    const resolved = screen.getByRole("button", { name: "Billing Ledger" });
    expect(resolved).toHaveClass("wiki-link-chip");
    fireEvent.click(resolved);
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ slug: "billing-ledger" });

    const missing = screen.getByRole("button", { name: "Ghost Page" });
    expect(missing.className).toContain("border-dashed");
    fireEvent.click(missing);
    expect(onCreateMissing).toHaveBeenCalledExactlyOnceWith("Ghost Page");

    // No links data → the raw syntax stays visible instead of a fake chip.
    expect(screen.getByText(/\[\[Unresolved\]\]/)).toBeInTheDocument();
  });

  it("derives heading ids from the tree section anchors", () => {
    renderWithI18n(
      <WikiMarkdown
        markdown={"## Billing Ledger\n\nBody.\n\n## Checkout\n\nBody two."}
        sections={sections}
      />,
    );
    expect(document.getElementById("s-billing-ledger")).not.toBeNull();
    expect(document.getElementById("s-checkout")).not.toBeNull();
  });

  it("upgrades mermaid fences to the rich fence block and keeps code fences copyable", () => {
    renderWithI18n(
      <WikiMarkdown markdown={"```mermaid\nA --> B\n```\n\n```go\nfmt.Println(1)\n```"} />,
    );
    expect(screen.getByTestId("rich-fence")).toHaveTextContent("A --> B");
    expect(screen.getByTestId("code-shell")).toHaveTextContent("fmt.Println(1)");
  });

  it("keeps inline code as code — [[…]] inside backticks never becomes a chip", () => {
    renderWithI18n(<WikiMarkdown markdown="Run `[[not-a-link]]` now." links={[]} />);
    const code = screen.getByText(/\[\[not-a-link\]\]/).closest("code");
    expect(code).not.toBeNull();
    expect(document.querySelector(".wiki-link-chip")).toBeNull();
  });

  it("derives heading anchors like the server: H1-H3, [KEY], H3 nesting, dedupe", () => {
    renderWithI18n(
      <WikiMarkdown
        markdown={"# Top\n\n## Alpha\n\n### Beta\n\n## Alpha\n\n## [key] Shown\n\n#### Ignored"}
      />,
    );
    expect(document.getElementById("s-Top")).not.toBeNull();
    expect(document.getElementById("s-Alpha")).not.toBeNull();
    expect(document.getElementById("s-Alpha / Beta")).not.toBeNull();
    expect(document.getElementById("s-Alpha (2)")).not.toBeNull();
    expect(document.getElementById("s-key")).not.toBeNull();
    // H4 is below the server's scanHeadings cutoff: no anchor.
    expect(document.querySelector("h4")?.getAttribute("id")).toBeNull();
  });

  it("h4-h6 never consume a heading anchor — ## / #### / ## keeps both H2 ids exact", () => {
    renderWithI18n(<WikiMarkdown markdown={"## Alpha\n\n#### Detail\n\n## Beta"} />);
    expect(document.getElementById("s-Alpha")).not.toBeNull();
    expect(document.getElementById("s-Beta")).not.toBeNull();
    const detail = document.querySelector("h4");
    expect(detail).not.toBeNull();
    expect(detail!.getAttribute("id")).toBeNull(); // no wrong s-… collision
  });

  it("keeps heading ids stable across rerenders with unchanged props", () => {
    const markdown = "## Alpha\n\n### Nested\n\n## Beta";
    const first = renderWithI18n(<WikiMarkdown markdown={markdown} />);
    const idsBefore = Array.from(document.querySelectorAll("h2, h3")).map((el) => el.getAttribute("id"));
    first.rerender(<WikiMarkdown markdown={markdown} />);
    const idsAfter = Array.from(document.querySelectorAll("h2, h3")).map((el) => el.getAttribute("id"));
    expect(idsAfter).toEqual(["s-Alpha", "s-Alpha / Nested", "s-Beta"]);
    expect(idsBefore).toEqual(idsAfter);
  });

  it("skips code entirely in wikilink resolution: same-name chip counted once", () => {
    renderWithI18n(
      <WikiMarkdown
        markdown="See [[架构]] and `[[架构]]`."
        links={[link({ raw: "架构", display: "架构", target: "架构", targetSlug: "architecture" })]}
      />,
    );
    expect(document.querySelectorAll(".wiki-link-chip")).toHaveLength(1);
    const code = screen.getByText("[[架构]]", { selector: "code" });
    expect(code.closest(".wiki-link-chip")).toBeNull();
  });

  it("highlights code fences through StaticCodeBody", () => {
    renderWithI18n(<WikiMarkdown markdown={"```go\nfmt.Println(1)\n```"} />);
    expect(screen.getByTestId("code-shell").querySelector("code")).toHaveTextContent("fmt.Println(1)");
  });

  it("shows the hover preview card with path, snippet and version", () => {
    renderWithI18n(
      <WikiMarkdown
        markdown="See [[架构]]."
        links={[link({ raw: "架构", display: "架构", target: "架构", targetSlug: "architecture" })]}
        pageMeta={new Map([["architecture", { title: "架构", path: "项目概览 / 架构", version: 3, updatedAt: "2026-11-01", snippet: "架构首段摘要" }]])}
      />,
    );
    const card = document.querySelector("[data-wiki-link-preview]") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent("项目概览 / 架构");
    expect(card).toHaveTextContent("架构首段摘要");
    expect(card).toHaveTextContent("v3");
  });
});
