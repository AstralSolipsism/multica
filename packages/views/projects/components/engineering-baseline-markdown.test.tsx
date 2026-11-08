import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithI18n } from "../../test/i18n";
import { BaselineMarkdown, BaselineWikiProvider } from "./engineering-baseline-markdown";
import { parseBaselineChapter } from "./engineering-baseline-utils";

const markdownRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("react-markdown", async (load) => {
  const actual = await load<typeof import("react-markdown")>();
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      markdownRenders.count += 1;
      return actual.default(props);
    },
  };
});
vi.mock("../../issues/utils/status-label", () => ({
  useStatusLabel: () => (status: string) => status,
}));

const sections = parseBaselineChapter("architecture", "## Billing Ledger\n\nOwns invoices.\n\n## Checkout\n\nUses the Billing Ledger.").sections;

function wiki(lens: "understand" | "manage" = "manage") {
  return {
    lens,
    workspaceId: "ws-1",
    chapters: [{ chapter: "architecture" as const, title: "" }],
    sections,
    nodes: [],
    stages: [],
    relations: new Map(),
    referenceCounts: new Map(),
    onNavigate: () => {},
  };
}

function page(value: ReturnType<typeof wiki>, contents: readonly string[], tick: number) {
  return (
    <BaselineWikiProvider value={value}>
      <div data-tick={tick}>
        {sections.map((section, index) => (
          <BaselineMarkdown key={section.key} content={contents[index] ?? section.body} currentSection={section} />
        ))}
      </div>
    </BaselineWikiProvider>
  );
}

describe("BaselineMarkdown", () => {
  it("does not re-parse unchanged sections when the wiki re-renders", () => {
    markdownRenders.count = 0;
    const value = wiki();
    const contents = sections.map((section) => section.body);
    const view = renderWithI18n(page(value, contents, 0));
    expect(markdownRenders.count).toBe(2);
    expect(screen.getByRole("button", { name: "Billing Ledger" })).toBeInTheDocument();

    // Search input, hover and read tracking re-render the whole wiki with a
    // fresh provider object carrying the same data.
    view.rerender(page({ ...value }, contents, 1));
    view.rerender(page(value, contents, 2));
    expect(markdownRenders.count).toBe(2);

    view.rerender(page(value, [contents[0]!, "Edited body."], 3));
    expect(markdownRenders.count).toBe(3);
    expect(screen.getByText("Edited body.")).toBeInTheDocument();

    view.rerender(page(wiki("understand"), [contents[0]!, "Edited body."], 4));
    expect(markdownRenders.count).toBe(5);
  });
});
