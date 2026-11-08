import type {
  BaselineChapter,
  BaselineChange,
  BaselineRevision,
  ChapterState,
  IssueGraphNode,
} from "@multica/core/api";
import type { SupportedLocale } from "@multica/core/i18n";
import { nameToWorkspaceSlug } from "../../workspace/slug";
import { ENGINEERING_CHAPTERS, type EngineeringStageSummary } from "./engineering-utils";

export interface BaselineSection {
  key: string;
  chapter: BaselineChapter;
  anchor: string;
  title: string;
  level: number;
  markdown: string;
  body: string;
  sourceLineMap: readonly number[];
  firstParagraph: string;
  why: string;
  example: string;
}

export interface BaselineChapterDocument {
  chapter: BaselineChapter;
  sections: BaselineSection[];
}

export type BaselineSectionChange = "same" | "added" | "modified" | "removed";

export interface BaselineDisplaySection extends BaselineSection {
  change: BaselineSectionChange;
  beforeBody: string;
}

export interface BaselineDisplayChapter {
  chapter: BaselineChapter;
  sections: BaselineDisplaySection[];
}

export type BaselineReference =
  | { kind: "concept"; key: string; label: string; section: BaselineSection }
  | { kind: "issue"; key: string; label: string; node: IssueGraphNode }
  | { kind: "stage"; key: string; label: string; stage: EngineeringStageSummary };

export interface BaselineReferenceMatch {
  start: number;
  end: number;
  reference: BaselineReference;
}

export function orderedBaselineChapters(chapters: readonly ChapterState[]): BaselineChapter[] {
  const modules = chapters
    .filter((item) => item.chapter.startsWith("module:"))
    .sort((a, b) => a.position - b.position || a.chapter.localeCompare(b.chapter));
  return [
    ...ENGINEERING_CHAPTERS,
    ...modules.map((item) => item.chapter),
  ];
}

export function baselineModuleSlug(title: string, locale?: SupportedLocale): string {
  return nameToWorkspaceSlug(title, locale).slice(0, 63).replace(/[-_]+$/, "");
}

export function isBaselineModuleSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(slug);
}

const HEADING = /^ {0,3}(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const EXPLICIT_KEY = /^\[([\p{L}\p{N}_]+-[^\]\r\n]{1,64})\][ \t]*(.*)$/u;

function normalizeHeadingTitle(title: string): string {
  return title.split(/\s+/u).join(" ").trim();
}

function headingIdentity(rawTitle: string, level: number, parent: string): { anchor: string; title: string } {
  const explicit = EXPLICIT_KEY.exec(rawTitle.trim());
  const title = explicit ? explicit[2] ?? "" : normalizeHeadingTitle(rawTitle);
  let anchor = explicit?.[1] ?? title;
  if (!explicit && level === 3 && parent) anchor = `${parent} / ${anchor}`;
  return { anchor, title };
}

function cleanTitle(title: string): string {
  return headingIdentity(title, 2, "").title;
}

export function plainBaselineText(markdown: string): string {
  return markdown
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?]]/g, (_match, id: string, label: string | undefined) => label ?? (id.startsWith("#") ? id.slice(1) : id.startsWith("stage:") ? `Stage ${id.slice(6)}` : id))
    .replace(/!\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~`>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function labeledParagraphs(body: string, sourceLines: readonly number[]): { body: string; sourceLineMap: number[]; why: string; example: string } {
  const kept: { text: string; sourceLines: number[] }[] = [];
  let why = "";
  let example = "";
  let cursor = 0;
  for (const paragraph of body.split(/\n\s*\n/)) {
    const offset = body.indexOf(paragraph, cursor);
    cursor = offset + paragraph.length;
    const bodyLine = body.slice(0, offset).split("\n").length - 1;
    const match = paragraph.match(/^\s*(?:[-*]\s+)?(?:\*\*)?(为什么这样规定|为什么|Why|例|示例|Example)(?:\*\*)?\s*[:：]\s*([\s\S]*)$/i);
    if (match) {
      const value = match[2]?.trim() ?? "";
      if (/^(为什么这样规定|为什么|Why)$/i.test(match[1] ?? "")) why = value;
      else example = value;
    } else if (paragraph.trim()) {
      kept.push({
        text: paragraph,
        sourceLines: paragraph.split("\n").map((_, index) => sourceLines[bodyLine + index] ?? sourceLines[bodyLine] ?? 1),
      });
    }
  }
  const sourceLineMap: number[] = [];
  kept.forEach((paragraph, index) => {
    if (index) sourceLineMap.push(paragraph.sourceLines[0] ?? 1);
    sourceLineMap.push(...paragraph.sourceLines);
  });
  return { body: kept.map((paragraph) => paragraph.text).join("\n\n"), sourceLineMap, why, example };
}

export function parseBaselineChapter(chapter: BaselineChapter, markdown: string): BaselineChapterDocument {
  type PositionedSection = Omit<BaselineSection, "markdown"> & { startLine: number };
  const sections: PositionedSection[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let current = { title: "", anchor: "intro", level: 0, lines: [] as string[], startLine: 0 };
  let parent = "";
  let fence = "";
  let hasHeadings = false;
  const seen = new Set<string>();
  const flush = () => {
    const sourceBody = current.lines.join("\n");
    const rawBody = sourceBody.trim();
    if (!current.title && !rawBody) return;
    const leadingLines = sourceBody.slice(0, sourceBody.length - sourceBody.trimStart().length).split("\n").length - 1;
    const firstSourceLine = current.level > 0 ? 2 : 1;
    const sourceLines = rawBody.split("\n").map((_, index) => firstSourceLine + leadingLines + index);
    const labeled = labeledParagraphs(rawBody, sourceLines);
    sections.push({
      key: `${chapter}:${current.anchor}`,
      chapter,
      anchor: current.anchor,
      title: current.title,
      level: current.level,
      startLine: current.startLine,
      body: labeled.body,
      sourceLineMap: labeled.sourceLineMap,
      firstParagraph: plainBaselineText(labeled.body.split(/\n\s*\n/)[0] ?? ""),
      why: labeled.why,
      example: labeled.example,
    });
  };
  for (const [lineIndex, line] of lines.entries()) {
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (!fence) fence = marker;
      else if (marker.startsWith(fence) && line.slice(line.indexOf(marker) + marker.length).trim() === "") fence = "";
      current.lines.push(line);
      continue;
    }
    const heading = !fence ? line.match(HEADING) : null;
    if (heading) {
      if (!hasHeadings && current.lines.join("\n").trim()) seen.add("_preamble");
      flush();
      const level = heading[1]?.length ?? 0;
      const identity = headingIdentity(heading[2]?.trim() ?? "", level, parent);
      const base = identity.anchor;
      let anchor = base;
      for (let count = 2; seen.has(anchor); count += 1) anchor = `${base} (${count})`;
      seen.add(anchor);
      if (level < 3) parent = anchor;
      current = { title: identity.title, anchor, level, lines: [], startLine: lineIndex };
      hasHeadings = true;
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return {
    chapter,
    sections: sections.map((section, index) => {
      const next = sections.slice(index + 1).find((candidate) => candidate.level > 0 && (section.level === 0 || candidate.level <= section.level));
      const { startLine, ...rest } = section;
      return { ...rest, markdown: lines.slice(startLine, next?.startLine ?? lines.length).join("\n").trim() };
    }),
  };
}

export function canEditBaselineSection(section: BaselineSection, sections: readonly BaselineSection[]): boolean {
  if (section.level === 0) return false;
  return sections.filter((candidate) => candidate.level > 0 && (candidate.anchor === section.anchor || candidate.title === section.anchor)).length === 1;
}

function changeMatches(section: BaselineSection, change: BaselineChange): boolean {
  return section.anchor === change.anchor || section.title === cleanTitle(change.title);
}

function changeBody(chapter: BaselineChapter, change: BaselineChange, side: "before" | "after"): string {
  const value = change[side];
  const parsed = parseBaselineChapter(chapter, value);
  if (parsed.sections.length === 1 && parsed.sections[0]?.title) return parsed.sections[0].body;
  return value.trim();
}

export function mergeBaselineSections(
  chapter: BaselineChapter,
  adoptedMarkdown: string,
  revision: BaselineRevision | null,
  compare: boolean,
): BaselineDisplaySection[] {
  const adopted = parseBaselineChapter(chapter, adoptedMarkdown).sections;
  if (!compare || !revision || revision.chapter !== chapter) {
    return adopted.map((section) => ({ ...section, change: "same" as const, beforeBody: "" }));
  }
  const candidate = parseBaselineChapter(chapter, revision.contentMarkdown).sections;
  const changes = [
    ...revision.anchorsDiff.added.map((change) => ({ change, kind: "added" as const })),
    ...revision.anchorsDiff.modified.map((change) => ({ change, kind: "modified" as const })),
  ];
  const result: BaselineDisplaySection[] = candidate.map((section) => {
    const matched = changes.find(({ change }) => changeMatches(section, change));
    return {
      ...section,
      change: matched?.kind ?? "same",
      beforeBody: matched?.kind === "modified" ? changeBody(chapter, matched.change, "before") : "",
    };
  });
  for (const change of revision.anchorsDiff.removed) {
    if (result.some((section) => changeMatches(section, change))) continue;
    const original = adopted.find((section) => changeMatches(section, change));
    const fallback = original ?? parseBaselineChapter(chapter, `### ${change.title}\n\n${change.before}`).sections[0];
    if (!fallback) continue;
    const removed: BaselineDisplaySection = { ...fallback, change: "removed", beforeBody: "" };
    const originalIndex = original ? adopted.indexOf(original) : -1;
    const next = originalIndex >= 0
      ? adopted.slice(originalIndex + 1).find((section) => result.some((item) => item.key === section.key))
      : undefined;
    const previous = originalIndex >= 0
      ? [...adopted.slice(0, originalIndex)].reverse().find((section) => result.some((item) => item.key === section.key))
      : undefined;
    const insertAt = next
      ? result.findIndex((section) => section.key === next.key)
      : previous ? result.findIndex((section) => section.key === previous.key) + 1 : result.length;
    result.splice(insertAt < 0 ? result.length : insertAt, 0, removed);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function allowsNaturalConceptMatch(title: string): boolean {
  if (/^\p{Script=Han}+$/u.test(title)) return Array.from(title).length >= 3;
  if (/^[A-Za-z]+$/.test(title)) return title.length >= 4;
  return true;
}

interface BaselineReferenceOptions {
  sections: readonly BaselineSection[];
  currentSectionKey?: string;
  nodes?: readonly IssueGraphNode[];
  stages?: readonly EngineeringStageSummary[];
  conceptsOnly?: boolean;
}

export function matchBaselineReferences(
  text: string,
  options: BaselineReferenceOptions & { seenConcepts?: Set<string> },
): BaselineReferenceMatch[] {
  return createBaselineReferenceMatcher(options)(text, options.seenConcepts);
}

/** Builds the lookup maps and pattern once, for matching many text nodes of one section. */
export function createBaselineReferenceMatcher(
  options: BaselineReferenceOptions,
): (text: string, seenConcepts?: Set<string>) => BaselineReferenceMatch[] {
  const concepts = new Map<string, BaselineSection>();
  const conceptAnchors = new Map<string, BaselineSection>();
  const conceptKeys = new Map<string, BaselineSection>();
  for (const section of options.sections) {
    if (section.key === options.currentSectionKey || !section.title) continue;
    if (!concepts.has(section.title)) concepts.set(section.title, section);
    if (!conceptAnchors.has(section.anchor)) conceptAnchors.set(section.anchor, section);
    if (!conceptKeys.has(section.key)) conceptKeys.set(section.key, section);
  }
  const naturalConcepts = new Map([...concepts].filter(([title]) => allowsNaturalConceptMatch(title)));
  // The pattern is case-insensitive; resolve case variants to the first
  // concept with that spelling, preferring an exact-case title.
  const naturalConceptsByLowerTitle = new Map<string, BaselineSection>();
  for (const [title, section] of naturalConcepts) {
    const key = title.toLowerCase();
    if (!naturalConceptsByLowerTitle.has(key)) naturalConceptsByLowerTitle.set(key, section);
  }
  const nodes = new Map((options.nodes ?? []).map((node) => [node.identifier, node]));
  const stages = new Map((options.stages ?? []).map((stage) => [stage.stage, stage]));
  const alternatives = [
    ...[...naturalConcepts.keys()].map((title) => ({ value: title, kind: "concept" as const })),
    ...(options.conceptsOnly ? [] : [
      ...[...nodes.keys()].map((identifier) => ({ value: identifier, kind: "issue" as const })),
      ...[...stages.keys()].flatMap((stage) => [
        { value: `Stage ${stage}`, kind: "stage" as const },
        { value: `第 ${stage} 阶段`, kind: "stage" as const },
        { value: `第${stage}阶段`, kind: "stage" as const },
      ]),
    ]),
  ].sort((a, b) => b.value.length - a.value.length);
  const pattern = alternatives.length ? new RegExp(alternatives.map((item) => escapeRegExp(item.value)).join("|"), "gi") : null;
  return (text, seenConcepts) => {
    const matches: BaselineReferenceMatch[] = [];
    const explicitRanges: { start: number; end: number }[] = [];
    for (const match of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?]]/g)) {
      const start = match.index;
      const end = start + match[0].length;
      explicitRanges.push({ start, end });
      const target = match[1]?.trim() ?? "";
      const targetName = target.startsWith("#") ? target.slice(1).trim() : target;
      const concept = concepts.get(targetName) ?? conceptAnchors.get(targetName) ?? conceptKeys.get(targetName);
      const label = match[2]?.trim() || (target.startsWith("#") ? targetName : target.startsWith("stage:") ? `Stage ${target.slice(6)}` : target);
      let reference: BaselineReference | undefined;
      if (concept) {
        reference = { kind: "concept", key: concept.key, label, section: concept };
        seenConcepts?.add(concept.key);
      } else if (!options.conceptsOnly) {
        const node = nodes.get(targetName.toUpperCase());
        if (node) reference = { kind: "issue", key: node.identifier, label, node };
        const stageNumber = target.match(/^stage:(\d+)$/)?.[1];
        const stage = stageNumber ? stages.get(Number(stageNumber)) : undefined;
        if (!reference && stage) reference = { kind: "stage", key: String(stage.stage), label, stage };
      }
      if (reference) matches.push({ start, end, reference });
    }
    if (!pattern) return matches.sort((a, b) => a.start - b.start);
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const raw = match[0];
      const end = start + raw.length;
      if (explicitRanges.some((range) => start < range.end && end > range.start)) continue;
      const before = text[start - 1];
      const after = text[end];
      if (before && /[A-Za-z0-9_]/.test(before) && /^[A-Za-z0-9_]/.test(raw)) continue;
      if (after && /[A-Za-z0-9_]/.test(after) && /[A-Za-z0-9_]$/.test(raw)) continue;
      const concept = naturalConcepts.get(raw) ?? naturalConceptsByLowerTitle.get(raw.toLowerCase());
      let reference: BaselineReference | undefined;
      if (concept) {
        if (seenConcepts?.has(concept.key)) continue;
        reference = { kind: "concept", key: concept.key, label: raw, section: concept };
        seenConcepts?.add(concept.key);
      } else if (!options.conceptsOnly) {
        const node = nodes.get(raw.toUpperCase());
        if (node) reference = { kind: "issue", key: node.identifier, label: raw, node };
        const stageNumber = raw.match(/\d+/)?.[0];
        const stage = stageNumber ? stages.get(Number(stageNumber)) : undefined;
        if (!reference && stage) reference = { kind: "stage", key: String(stage.stage), label: raw, stage };
      }
      if (reference) matches.push({ start, end, reference });
    }
    return matches.sort((a, b) => a.start - b.start);
  };
}

export function scanBaselineReferences(
  section: BaselineSection,
  sections: readonly BaselineSection[],
  nodes: readonly IssueGraphNode[],
  stages: readonly EngineeringStageSummary[],
): BaselineReference[] {
  const seen = new Set<string>();
  return matchBaselineReferences(section.body, { sections, currentSectionKey: section.key, nodes, stages, seenConcepts: seen })
    .map((match) => match.reference);
}

export function latestBaselineSectionRevision(
  section: BaselineSection,
  revisions: readonly BaselineRevision[],
): BaselineRevision | null {
  return revisions.find((revision) => [
    ...revision.anchorsDiff.added,
    ...revision.anchorsDiff.modified,
    ...revision.anchorsDiff.removed,
  ].some((change) => changeMatches(section, change))) ?? null;
}
