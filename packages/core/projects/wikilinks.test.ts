// @vitest-environment node
// Go + vitest load the same golden fixture (server/internal/engineering/testdata/
// wikilinks.json) to lock forward-link resolution and the backlink invariant
// (OL-1329 contract §7.2). The resolver here is an independent TypeScript
// mirror of the server's WikiIndex semantics.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

interface FixturePage {
  slug: string;
  title: string;
  content: string;
  archived?: boolean;
}
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
  pages: FixturePage[];
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

/** Section anchors: explicit [KEY] prefix wins; H3 nests under its parent; duplicates get " (2)". */
function scanSections(content: string): { anchor: string; title: string }[] {
  const out: { anchor: string; title: string }[] = [];
  const seen = new Set<string>();
  let parent = "";
  const lines = content.split(/\r?\n/);
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence || !trimmed.match(/^(```|~~~)\s*$/);
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    let key = (match[2] ?? "").replace(/\s+/g, " ").trim();
    const explicit = /^\[([^\]]+)\]\s*(.*)$/.exec(key);
    let title = key;
    const level = match[1]?.length ?? 2;
    if (explicit) {
      key = explicit[1] ?? key;
      title = explicit[2] ?? title;
    } else if (level === 3 && parent) {
      key = `${parent} / ${key}`;
    }
    const base = key;
    for (let n = 2; seen.has(key); n++) key = `${base} (${n})`;
    seen.add(key);
    if (level < 3) parent = key;
    out.push({ anchor: key, title });
  }
  return out;
}

const bySlug = new Map(pages.map((page, i) => [page.slug, i]));
const byTitle = new Map<string, number[]>();
const byAnchor = new Map<string, { page: number; anchor: string }[]>();
pages.forEach((page: FixturePage, i: number) => {
  const titles = byTitle.get(page.title.toLowerCase()) ?? [];
  titles.push(i);
  byTitle.set(page.title.toLowerCase(), titles);
  const seen = new Set<string>();
  for (const section of scanSections(page.content)) {
    for (const key of [section.anchor.toLowerCase(), section.title.toLowerCase()]) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const addrs: { page: number; anchor: string }[] = byAnchor.get(key) ?? [];
      addrs.push({ page: i, anchor: section.anchor });
      byAnchor.set(key, addrs);
    }
  }
});

function resolveLink(fromPage: number, raw: string) {
  const [targetWithSection, rawDisplay] = raw.split("|") as [string, string?];
  const display = rawDisplay !== undefined && rawDisplay.trim() !== "" ? rawDisplay : targetWithSection;
  const hash = targetWithSection.indexOf("#");
  const target = (hash === -1 ? targetWithSection : targetWithSection.slice(0, hash)).trim();
  const section = hash === -1 ? "" : targetWithSection.slice(hash + 1).trim();
  const result = { kind: "page", state: "missing", targetSlug: "", sectionAnchor: "", display };
  if (/^stage:[1-9][0-9]*$/.test(raw)) return { ...result, kind: "stage", state: "resolved" };
  const resolveSection = (pageIndex: number) => {
    const page = pages[pageIndex];
    if (!page) return result;
    for (const s of scanSections(page.content)) {
      if (s.anchor.toLowerCase() === section.toLowerCase() || s.title.toLowerCase() === section.toLowerCase()) {
        return { ...result, state: "resolved", targetSlug: page.slug, sectionAnchor: s.anchor };
      }
    }
    return { ...result, state: "missing", targetSlug: page.slug };
  };
  if (target === "") return fromPage >= 0 && fromPage < pages.length ? resolveSection(fromPage) : result;
  const slugIndex = bySlug.get(target);
  if (slugIndex !== undefined) {
    const slugPage = pages[slugIndex];
    if (slugPage) {
      return section === "" ? { ...result, state: "resolved", targetSlug: slugPage.slug } : resolveSection(slugIndex);
    }
  }
  const titleMatches: number[] = byTitle.get(target.toLowerCase()) ?? [];
  if (titleMatches.length > 1) return { ...result, state: "ambiguous" };
  const titleIndex = titleMatches[0];
  if (titleMatches.length === 1 && titleIndex !== undefined) {
    const titlePage = pages[titleIndex];
    if (titlePage) {
      return section === "" ? { ...result, state: "resolved", targetSlug: titlePage.slug } : resolveSection(titleIndex);
    }
  }
  if (section === "") {
    const addrs: { page: number; anchor: string }[] = byAnchor.get(target.toLowerCase()) ?? [];
    const only = addrs[0];
    if (addrs.length === 1 && only) {
      return { ...result, state: "resolved", targetSlug: pages[only.page]?.slug ?? "", sectionAnchor: only.anchor };
    }
    if (addrs.length > 1) {
      const uniqueSlugs = new Set(addrs.map((addr) => pages[addr.page]?.slug ?? ""));
      if (uniqueSlugs.size > 1) return { ...result, state: "ambiguous" };
    }
  }
  return result;
}

/** Goldmark-AST-equivalent extraction: `[[…]]` outside inline code and fences, in order. */
function extractLinks(content: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence || !trimmed.match(/^(```|~~~)\s*$/);
      continue;
    }
    if (inFence) continue;
    // Strip inline code spans before scanning, mirroring the AST skip.
    const withoutCode = line.replace(/`[^`\n]*`/g, " ");
    for (const match of withoutCode.matchAll(/\[\[([^\][\r\n]+)\]\]/g)) {
      out.push(match[1] as string);
    }
  }
  return out;
}

function linksFor(pageIndex: number) {
  const page = pages[pageIndex];
  if (!page) return [];
  return extractLinks(page.content).map((raw) => ({ raw, ...resolveLink(pageIndex, raw) }));
}

function backlinksFor(slug: string) {
  const target = bySlug.get(slug) ?? -1;
  if (target === undefined) return [];
  const out: { slug: string; sectionAnchor: string }[] = [];
  pages.forEach((page: FixturePage, i: number) => {
    if (i === target || !page.content.includes("[[")) return;
    for (const link of linksFor(i)) {
      if (link.kind === "page" && link.state === "resolved" && link.targetSlug === slug) {
        out.push({ slug: page.slug, sectionAnchor: link.sectionAnchor });
      }
    }
  });
  return out;
}

describe("wiki links golden fixture", () => {
  it("extracts links in order, ignoring code", () => {
    for (const [slug, expected] of Object.entries(fixture.extract)) {
      const pageIndex = bySlug.get(slug);
      expect(pageIndex, `fixture page ${slug}`).toBeDefined();
      expect(extractLinks((pages[pageIndex as number] as FixturePage).content)).toEqual(expected);
    }
  });

  it("resolves every case like the server", () => {
    for (const testCase of fixture.cases) {
      const pageIndex = bySlug.get(testCase.page);
      expect(pageIndex, `fixture page ${testCase.page}`).toBeDefined();
      const link = resolveLink(pageIndex as number, testCase.raw);
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
      expect(backlinksFor(expected.target), `backlinks(${expected.target})`).toEqual(
        expected.expect.map((entry) => ({ slug: entry.slug, sectionAnchor: entry.section_anchor })),
      );
    }
  });

  it("keeps the backlink invariant: inbound equals resolved forward links from other pages", () => {
    for (const page of fixture.pages) {
      let forward = 0;
      pages.forEach((other: FixturePage, i: number) => {
        if (other.slug === page.slug) return;
        for (const link of linksFor(i)) {
          if (link.kind === "page" && link.state === "resolved" && link.targetSlug === page.slug) forward++;
        }
      });
      expect(backlinksFor(page.slug).length, `backlinks(${page.slug})`).toBe(forward);
    }
  });
});
