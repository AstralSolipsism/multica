import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";
import { WikiMarkdown } from "./engineering-baseline-markdown";
import type { WikiLink, WikiTreeSection } from "@multica/core/api";

vi.mock("../../rich-content/rich-code-block", () => ({
  isRichFenceLanguage: (language: string) => language === "mermaid" || language === "html",
  RichFenceBlock: ({ body }: { body: string }) => <div data-testid="rich-fence">{body}</div>,
  CodeBlockShell: ({ code }: { code: string }) => <pre data-testid="code-shell">{code}</pre>,
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
});
