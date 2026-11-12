// Wiki link resolution reference implementation (OL-1329 contract §7.2).
//
// This module is the vitest-side mirror of the server's WikiIndex semantics
// and is locked against the same golden fixture as the Go tests
// (server/internal/engineering/testdata/wikilinks.json). The shipped views
// keep using the server-provided `links` data; this module exists so the
// resolution rules (slug > title > section, ambiguity, stage links, backlink
// invariant) are pinned by an executable implementation instead of prose.

export interface WikiLinkPageInput {
  slug: string;
  title: string;
  content: string;
  archived?: boolean;
}

export interface WikiLinkSection {
  anchor: string;
  title: string;
}

export type WikiLinkKind = "page" | "stage";
export type WikiLinkState = "missing" | "resolved" | "ambiguous";

export interface WikiLinkResolution {
  kind: WikiLinkKind;
  state: WikiLinkState;
  targetSlug: string;
  sectionAnchor: string;
  display: string;
}

export interface WikiForwardLink extends WikiLinkResolution {
  raw: string;
}

export interface WikiBacklink {
  slug: string;
  sectionAnchor: string;
}

export interface WikiLinkIndex {
  /** Unarchived pages in the order they were supplied. */
  readonly pages: readonly WikiLinkPageInput[];
  resolve(fromSlug: string, raw: string): WikiLinkResolution;
  linksFor(slug: string): WikiForwardLink[];
  backlinksFor(slug: string): WikiBacklink[];
}

/**
 * Section anchors: explicit [KEY] prefix wins; H3 nests under its parent
 * (parent / child); duplicates get " (2)". Fences are skipped, mirroring the
 * server's scanHeadings.
 */
export function scanSections(content: string): WikiLinkSection[] {
  const out: WikiLinkSection[] = [];
  const seen = new Set<string>();
  let parent = "";
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
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

/**
 * Goldmark-AST-equivalent extraction: `[[…]]` outside inline code and fences,
 * in document order.
 */
export function extractLinks(content: string): string[] {
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

interface WikiLinkLookup {
  bySlug: Map<string, number>;
  byTitle: Map<string, number[]>;
  byAnchor: Map<string, { page: number; anchor: string }[]>;
}

const lookupCache = new WeakMap<readonly WikiLinkPageInput[], WikiLinkLookup>();

function buildLookup(pages: readonly WikiLinkPageInput[]): WikiLinkLookup {
  const cached = lookupCache.get(pages);
  if (cached) return cached;
  const bySlug = new Map(pages.map((page, i) => [page.slug, i]));
  const byTitle = new Map<string, number[]>();
  const byAnchor = new Map<string, { page: number; anchor: string }[]>();
  pages.forEach((page, i) => {
    const titles = byTitle.get(page.title.toLowerCase()) ?? [];
    titles.push(i);
    byTitle.set(page.title.toLowerCase(), titles);
    const seen = new Set<string>();
    for (const sec of scanSections(page.content)) {
      for (const key of [sec.anchor.toLowerCase(), sec.title.toLowerCase()]) {
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const addrs: { page: number; anchor: string }[] = byAnchor.get(key) ?? [];
        addrs.push({ page: i, anchor: sec.anchor });
        byAnchor.set(key, addrs);
      }
    }
  });
  const lookup = { bySlug, byTitle, byAnchor };
  lookupCache.set(pages, lookup);
  return lookup;
}

/** Resolve `[[raw]]` written on the page identified by `fromSlug`. */
export function resolveWikiLink(index: WikiLinkIndex, fromSlug: string, raw: string): WikiLinkResolution {
  const pages = index.pages;
  const fromPage = pages.findIndex((page) => page.slug === fromSlug);
  const [targetWithSection, rawDisplay] = raw.split("|") as [string, string | undefined];
  const display = rawDisplay !== undefined && rawDisplay.trim() !== "" ? rawDisplay : targetWithSection;
  const hash = targetWithSection.indexOf("#");
  const target = (hash === -1 ? targetWithSection : targetWithSection.slice(0, hash)).trim();
  const section = hash === -1 ? "" : targetWithSection.slice(hash + 1).trim();
  const result: WikiLinkResolution = { kind: "page", state: "missing", targetSlug: "", sectionAnchor: "", display };
  if (/^stage:[1-9][0-9]*$/.test(raw)) return { ...result, kind: "stage", state: "resolved" };
  const { bySlug, byTitle, byAnchor } = buildLookup(pages);
  const resolveSection = (pageIndex: number): WikiLinkResolution => {
    const page = pages[pageIndex];
    if (!page) return result;
    for (const sec of scanSections(page.content)) {
      if (sec.anchor.toLowerCase() === section.toLowerCase() || sec.title.toLowerCase() === section.toLowerCase()) {
        return { ...result, state: "resolved", targetSlug: page.slug, sectionAnchor: sec.anchor };
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

/** Build the resolution index over the unarchived pages of a wiki. */
export function buildWikiLinkIndex(allPages: readonly WikiLinkPageInput[]): WikiLinkIndex {
  const pages = allPages.filter((page) => !page.archived);
  const index: WikiLinkIndex = {
    pages,
    resolve: (fromSlug, raw) => resolveWikiLink(index, fromSlug, raw),
    linksFor(slug: string): WikiForwardLink[] {
      const page = pages.find((item) => item.slug === slug);
      if (!page) return [];
      return extractLinks(page.content).map((raw) => ({ raw, ...index.resolve(slug, raw) }));
    },
    backlinksFor(slug: string): WikiBacklink[] {
      const out: WikiBacklink[] = [];
      pages.forEach((page) => {
        if (page.slug === slug || !page.content.includes("[[")) return;
        for (const link of index.linksFor(page.slug)) {
          if (link.kind === "page" && link.state === "resolved" && link.targetSlug === slug) {
            out.push({ slug: page.slug, sectionAnchor: link.sectionAnchor });
          }
        }
      });
      return out;
    },
  };
  return index;
}
