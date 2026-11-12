// @vitest-environment node
// Go + vitest load the same golden fixture (server/internal/engineering/
// testdata/wikilinks.json) to lock forward-link resolution and the backlink
// invariant (OL-1329 contract §7.2). The resolver under test is the exported
// reference module ./wikilink-resolution — the TypeScript mirror of the
// server's WikiIndex semantics.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildWikiLinkIndex,
  extractLinks,
  scanSections,
  type WikiLinkPageInput,
} from "./wikilink-resolution";

interface FixtureCase {
  page: string;
  raw: string;
  kind: string;
  state: string;
  target_slug?: string;
  section_anchor?: string;
}

interface FixtureBacklinks {
  target: string;
  expect: { slug: string; section_anchor: string }[];
}

interface Fixture {
  pages: WikiLinkPageInput[];
  extract: Record<string, string[]>;
  cases: FixtureCase[];
  backlinks: FixtureBacklinks[];
}

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../server/internal/engineering/testdata/wikilinks.json",
);
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const pages = fixture.pages.filter((page) => !page.archived);
const index = buildWikiLinkIndex(fixture.pages);
const bySlug = new Map(pages.map((page, i) => [page.slug, i]));

describe("wiki links golden fixture", () => {
  it("extracts links in order, ignoring code", () => {
    for (const [slug, expected] of Object.entries(fixture.extract)) {
      const pageIndex = bySlug.get(slug);
      expect(pageIndex, `fixture page ${slug}`).toBeDefined();
      expect(extractLinks((pages[pageIndex as number] as WikiLinkPageInput).content)).toEqual(expected);
    }
  });

  it("derives section anchors like the server (explicit keys, H3 nesting, dedupe)", () => {
    expect(scanSections("## Alpha\n\n### Beta\n\n## Alpha\n\n## [key] Shown Title\n")).toEqual([
      { anchor: "Alpha", title: "Alpha" },
      { anchor: "Alpha / Beta", title: "Beta" },
      { anchor: "Alpha (2)", title: "Alpha" },
      { anchor: "key", title: "Shown Title" },
    ]);
    // Fences are skipped and H1 participates like the server's scanHeadings.
    expect(scanSections("# Top\n\n```md\n## In Fence\n```\n\n## Real\n").map((s) => s.title)).toEqual(["Top", "Real"]);
  });

  it("resolves every case like the server", () => {
    for (const testCase of fixture.cases) {
      const pageIndex = bySlug.get(testCase.page);
      expect(pageIndex, `fixture page ${testCase.page}`).toBeDefined();
      const link = index.resolve((pages[pageIndex as number] as WikiLinkPageInput).slug, testCase.raw);
      expect(
        {
          page: testCase.page, raw: testCase.raw, kind: link.kind, state: link.state,
          target_slug: link.targetSlug, section_anchor: link.sectionAnchor,
        },
        `[[${testCase.raw}]] on ${testCase.page}`,
      ).toEqual({
        page: testCase.page, raw: testCase.raw, kind: testCase.kind, state: testCase.state,
        target_slug: testCase.target_slug ?? "", section_anchor: testCase.section_anchor ?? "",
      });
    }
  });

  it("matches the expected backlink lists", () => {
    for (const expected of fixture.backlinks) {
      expect(index.backlinksFor(expected.target), `backlinks(${expected.target})`).toEqual(
        expected.expect.map((entry) => ({ slug: entry.slug, sectionAnchor: entry.section_anchor })),
      );
    }
  });

  it("keeps the backlink invariant: inbound equals resolved forward links from other pages", () => {
    for (const page of fixture.pages) {
      let forward = 0;
      pages.forEach((other: WikiLinkPageInput) => {
        if (other.slug === page.slug) return;
        for (const link of index.linksFor(other.slug)) {
          if (link.kind === "page" && link.state === "resolved" && link.targetSlug === page.slug) forward++;
        }
      });
      expect(index.backlinksFor(page.slug).length, `backlinks(${page.slug})`).toBe(forward);
    }
  });
});
