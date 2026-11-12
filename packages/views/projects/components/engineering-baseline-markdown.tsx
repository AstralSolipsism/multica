"use client";

// WikiMarkdown: the tree-wiki markdown renderer (OL-1329).
//
// Renders one page body with react-markdown + remark-gfm. On top of plain
// markdown it adds:
// - heading ids `s-<anchor>` taken from the tree sections data, so the outline
//   rail and search jumps address the exact nodes the server indexed;
// - `[[双链]]` chips resolved through the page's `links` data (resolved links
//   render as chips with a hover preview card; ambiguous/missing targets render
//   as dashed chips and missing ones offer one-click creation);
// - fenced code blocks with a copy button, and mermaid/html fences upgraded to
//   the shared rich fence block.
// It deliberately does NOT autolink natural words or annotate source lines —
// those were retired with the chapter baseline.

import { Children, cloneElement, isValidElement, useMemo, useRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@multica/ui/lib/utils";
import type { WikiLink, WikiTreeSection } from "@multica/core/api";
import { scanSections } from "@multica/core/projects/wikilink-resolution";
import { CodeBlockShell, isRichFenceLanguage, RichFenceBlock, StaticCodeBody } from "../../rich-content/rich-code-block";
import { useT } from "../../i18n";

export interface WikiLinkTarget {
  slug: string;
  anchor?: string;
}

export interface WikiPageMeta {
  title: string;
  path: string;
  version: number;
  updatedAt: string;
  /** First paragraph of the target page for the hover preview card. */
  snippet?: string;
}

export interface WikiMarkdownProps {
  markdown: string;
  /** Section anchors from the wiki tree, in document order. */
  sections?: readonly WikiTreeSection[];
  /** Link resolution data from getProjectWikiPage with:["links"]. */
  links?: readonly WikiLink[];
  /** Extra chip data for the hover preview card, keyed by target slug. */
  pageMeta?: ReadonlyMap<string, WikiPageMeta>;
  onNavigate?: (target: WikiLinkTarget) => void;
  /** Missing target clicked: create a page with the link text as its title. */
  onCreateMissing?: (title: string) => void;
  className?: string;
}

const WIKI_LINK_PATTERN = /\[\[([^\]]+)\]\]/g;

function WikiLinkChip({ link, raw, meta, onNavigate, onCreateMissing }: {
  link: WikiLink | undefined;
  raw: string;
  meta?: ReadonlyMap<string, WikiPageMeta>;
  onNavigate?: (target: WikiLinkTarget) => void;
  onCreateMissing?: (title: string) => void;
}) {
  const { t } = useT("engineering");
  if (!link) {
    return <code className="rounded-sm bg-muted px-1 py-0.5 text-[0.9em]">[[{raw}]]</code>;
  }
  const label = link.section ? `${link.display} › ${link.section}` : link.display;
  if (link.state === "missing") {
    return (
      <button
        type="button"
        data-wiki-link={link.targetSlug ?? link.target}
        className="rounded-sm border border-dashed border-destructive/60 px-1.5 py-0.5 text-[0.9em] text-destructive hover:bg-destructive/10"
        title={t(($) => $.wiki.linkCreate)}
        onClick={() => onCreateMissing?.(link.target || link.display)}
      >
        {label}
      </button>
    );
  }
  if (link.state !== "resolved") {
    return <span data-wiki-link={link.targetSlug ?? link.target} className="rounded-sm border border-dashed border-muted-foreground/50 px-1.5 py-0.5 text-[0.9em] text-muted-foreground">{label}</span>;
  }
  const info = link.targetSlug ? meta?.get(link.targetSlug) : undefined;
  const chipClass = "wiki-link-chip rounded-sm bg-brand/10 px-1.5 py-0.5 text-[0.9em] text-brand hover:bg-brand/20";
  const navigate = () => onNavigate?.({ slug: link.targetSlug ?? link.target, ...(link.sectionAnchor ? { anchor: link.sectionAnchor } : {}) });
  if (!info) {
    return <button type="button" data-wiki-link={link.targetSlug ?? link.target} className={chipClass} onClick={navigate}>{label}</button>;
  }
  // Preview card: ~220ms appear delay via transition-delay, stays while the
  // pointer is on the group (chip or card), and opens on keyboard focus too.
  return (
    <span className="group/wiki-link relative inline-block">
      <button type="button" data-wiki-link={link.targetSlug ?? link.target} className={chipClass} onClick={navigate}>{label}</button>
      <span
        className="pointer-events-none absolute bottom-full left-0 z-30 w-72 -translate-y-1 rounded-md border bg-canvas p-2 text-body opacity-0 shadow-md transition-opacity delay-200 group-hover/wiki-link:pointer-events-auto group-hover/wiki-link:opacity-100 group-focus-within/wiki-link:pointer-events-auto group-focus-within/wiki-link:opacity-100"
        data-wiki-link-preview
      >
        <span className="block text-micro text-muted-foreground">{info.path}</span>
        <span className="mt-0.5 block font-medium">{info.title}{link.section ? ` › ${link.section}` : ""}</span>
        {info.snippet ? <span className="mt-1 line-clamp-4 block text-caption text-muted-foreground" data-wiki-link-preview-snippet>{info.snippet}</span> : null}
        <span className="mt-1 block text-caption text-muted-foreground">
          {t(($) => $.wiki.previewVersion, { number: info.version })} · {info.updatedAt}
        </span>
      </span>
    </span>
  );
}

/** Inline/fenced code renderer; hoisted so wikilink resolution can skip it. */
function WikiMarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  const language = typeof className === "string" ? /language-([\w-]+)/.exec(className)?.[1] : undefined;
  const body = Children.toArray(children).filter((part): part is string => typeof part === "string").join("");
  if (language && isRichFenceLanguage(language)) {
    return <div data-wiki-comment-source={body}><RichFenceBlock language={language} body={body} /></div>;
  }
  if (language) {
    return <CodeBlockShell language={language} code={body}><StaticCodeBody language={language} body={body} /></CodeBlockShell>;
  }
  return <code className={className}>{children}</code>;
}

function isPropsWithChildren(value: unknown): value is { children?: unknown } {
  return typeof value === "object" && value !== null && "children" in value;
}

/** Replace `[[…]]` inside plain text children with wiki link chips. */
function withWikiLinks(
  children: ReactNode,
  links: Map<string, WikiLink>,
  props: Pick<WikiMarkdownProps, "pageMeta" | "onNavigate" | "onCreateMissing">,
): ReactNode {
  const replaceText = (text: string): ReactNode => {
    if (!text.includes("[[")) return text;
    const parts = text.split(WIKI_LINK_PATTERN);
    if (parts.length === 1) return text;
    return parts.map((part, index) => index % 2 === 0
      ? part
      : <WikiLinkChip key={`${index}-${part}`} raw={part} link={links.get(part)} meta={props.pageMeta} onNavigate={props.onNavigate} onCreateMissing={props.onCreateMissing} />);
  };
  return Children.map(children, (child) => {
    if (typeof child === "string") return replaceText(child);
    if (isValidElement(child)) {
      // Inline code: `[[x]]` inside backticks stays literal code, even when a
      // same-name link resolves elsewhere on the page.
      if (child.type === "code" || child.type === WikiMarkdownCode) return child;
      if (isPropsWithChildren(child.props)) {
        const inner = child.props.children;
        if (typeof inner === "string") return cloneElement(child, {}, replaceText(inner));
      }
    }
    return child;
  });
}


export function WikiMarkdown({ markdown, sections, links, pageMeta, onNavigate, onCreateMissing, className }: WikiMarkdownProps) {
  const { t } = useT("engineering");
  const linkMap = useMemo(() => new Map((links ?? []).map((link) => [link.raw, link])), [links]);

  // Heading anchors mirror the server's scanHeadings exactly: H1–H3 only,
  // explicit [KEY] prefixes, H3 nesting under its parent, " (2)" dedupe —
  // computed locally with the shared reference implementation. When the tree
  // supplies section data, its anchors win (same values, server-authoritative).
  const headingAnchors = useMemo(() => {
    const local = scanSections(markdown).map((section) => section.anchor);
    const list = sections ?? [];
    return local.map((anchor, index) => list[index]?.anchor ?? anchor);
  }, [markdown, sections]);

  // Heading anchors consume the h1–h3 list in document order. The cursor is a
  // ref RESET ON EVERY RENDER: heading components may re-run without the
  // components map being rebuilt (unchanged props), and a closure counter
  // would over-advance there and drop every later id. h4–h6 mirror the
  // server's scanHeadings (H1–H3 only): no id, and they never consume an
  // anchor — otherwise `#### Detail` between two H2s steals the next H2's
  // anchor and creates s-… collisions.
  const headingCursor = useRef(0);
  headingCursor.current = 0;
  const components = useMemo<Components>(() => {
    const wrap = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6", indexed: boolean) =>
      function WikiMarkdownHeading({ children }: { children?: ReactNode }) {
        const anchor = indexed ? headingAnchors[headingCursor.current++] : undefined;
        return <Tag id={anchor ? `s-${anchor}` : undefined} className="scroll-mt-16">{withWikiLinks(children, linkMap, { pageMeta, onNavigate, onCreateMissing })}</Tag>;
      };
    const inline = (Tag: "p" | "li" | "blockquote" | "td" | "th") =>
      function WikiMarkdownInline({ children }: { children?: ReactNode }) {
        return <Tag>{withWikiLinks(children, linkMap, { pageMeta, onNavigate, onCreateMissing })}</Tag>;
      };
    return {
      h1: wrap("h1", true), h2: wrap("h2", true), h3: wrap("h3", true),
      h4: wrap("h4", false), h5: wrap("h5", false), h6: wrap("h6", false),
      p: inline("p"), li: inline("li"), blockquote: inline("blockquote"), td: inline("td"), th: inline("th"),
      code: WikiMarkdownCode,
    };
  }, [headingAnchors, linkMap, pageMeta, onNavigate, onCreateMissing]);

  if (!markdown.trim()) return null;
  return (
    <div
      className={cn("rich-text-editor readonly text-body leading-7 [&_li]:my-1 [&_p]:my-2 [&_strong]:font-medium", className)}
      data-wiki-markdown
      aria-label={t(($) => $.wiki.bodyLabel)}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{markdown}</ReactMarkdown>
    </div>
  );
}
