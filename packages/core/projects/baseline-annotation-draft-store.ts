import { BaselineChapterSchema, type BaselineChapter } from "../api/labrastro-engineering-schemas";
import { createDraftStore } from "../drafts/create-draft-store";

export const BASELINE_ANNOTATION_DRAFT_LIMIT = 20;
// Storage hygiene bound for the whole workspace store; the enforceable
// per-review limit (project + chapter + owner) is BASELINE_ANNOTATION_DRAFT_LIMIT.
export const BASELINE_ANNOTATION_STORE_LIMIT = BASELINE_ANNOTATION_DRAFT_LIMIT * 10;
export const BASELINE_ANNOTATION_NOTE_LIMIT = 1000;
export const BASELINE_ANNOTATION_QUOTE_LIMIT = 500;
export const BASELINE_ANNOTATION_LINE_LIMIT = 50;

export interface BaselineAnnotationDraftAnchor {
  anchorKind: "text" | "lines" | "section";
  targetRevisionId: string;
  sectionAnchor: string;
  sectionTitle: string;
  lineStart?: number;
  lineEnd?: number;
  quote?: string;
  prefix?: string;
  suffix?: string;
  start?: number;
}

export interface BaselineAnnotationDraft extends BaselineAnnotationDraftAnchor {
  id: string;
  ownerId: string;
  projectId: string;
  chapter: BaselineChapter;
  note: string;
  createdAt: string;
}

export interface BaselineAnnotationReplyDraft extends BaselineAnnotationDraftAnchor {
  id: string;
  ownerId: string;
  projectId: string;
  chapter: BaselineChapter;
  parentAnnotationId: string;
  note: string;
  createdAt: string;
}

export type BaselineAnnotationDraftItem = BaselineAnnotationDraft | BaselineAnnotationReplyDraft;

export interface BaselineAnnotationDraftData {
  annotations: BaselineAnnotationDraft[];
  replies: BaselineAnnotationReplyDraft[];
}

export type BaselineAnnotationDraftUpdate = Partial<
  BaselineAnnotationDraftAnchor & { note: string; parentAnnotationId: string }
>;

export const EMPTY_BASELINE_ANNOTATION_DRAFT: BaselineAnnotationDraftData = {
  annotations: [],
  replies: [],
};

const codePointLength = (value: string) => Array.from(value).length;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function normalizeAnchor(value: Record<string, unknown>): BaselineAnnotationDraftAnchor | null {
  if (
    (value.anchorKind !== "text" && value.anchorKind !== "lines" && value.anchorKind !== "section") ||
    !isNonEmptyString(value.targetRevisionId) ||
    !isNonEmptyString(value.sectionAnchor) ||
    codePointLength(value.sectionAnchor) > 300 ||
    typeof value.sectionTitle !== "string"
  ) return null;

  for (const [field, limit] of [["quote", 500], ["prefix", 64], ["suffix", 64]] as const) {
    const fieldValue = value[field];
    if (
      fieldValue !== undefined && fieldValue !== null &&
      (typeof fieldValue !== "string" || codePointLength(fieldValue) > limit)
    ) return null;
  }
  if (
    value.start !== undefined && value.start !== null &&
    (typeof value.start !== "number" || !Number.isInteger(value.start) || value.start < 0)
  ) return null;

  const hasLineStart = value.lineStart !== undefined && value.lineStart !== null;
  const hasLineEnd = value.lineEnd !== undefined && value.lineEnd !== null;
  if (value.anchorKind === "lines") {
    if (
      !hasLineStart || !hasLineEnd ||
      typeof value.lineStart !== "number" || !Number.isInteger(value.lineStart) || value.lineStart < 1 ||
      typeof value.lineEnd !== "number" || !Number.isInteger(value.lineEnd) ||
      value.lineEnd < value.lineStart ||
      value.lineEnd - value.lineStart >= BASELINE_ANNOTATION_LINE_LIMIT
    ) return null;
  } else if (hasLineStart || hasLineEnd) return null;

  return {
    anchorKind: value.anchorKind,
    targetRevisionId: value.targetRevisionId,
    sectionAnchor: value.sectionAnchor,
    sectionTitle: value.sectionTitle,
    ...(hasLineStart ? { lineStart: value.lineStart as number } : {}),
    ...(hasLineEnd ? { lineEnd: value.lineEnd as number } : {}),
    ...(typeof value.quote === "string" ? { quote: value.quote } : {}),
    ...(typeof value.prefix === "string" ? { prefix: value.prefix } : {}),
    ...(typeof value.suffix === "string" ? { suffix: value.suffix } : {}),
    ...(typeof value.start === "number" ? { start: value.start } : {}),
  };
}

function normalizeItem(
  value: unknown,
  kind: "annotation" | "reply",
): BaselineAnnotationDraftItem | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.ownerId) ||
    !isNonEmptyString(value.projectId) ||
    !isNonEmptyString(value.createdAt) ||
    typeof value.note !== "string"
  ) return null;
  const chapter = BaselineChapterSchema.safeParse(value.chapter);
  if (!chapter.success) return null;
  const note = value.note.trim();
  if (!note || codePointLength(note) > BASELINE_ANNOTATION_NOTE_LIMIT) return null;
  if (kind === "reply" && !isNonEmptyString(value.parentAnnotationId)) return null;
  if (kind === "annotation" && value.parentAnnotationId !== undefined && value.parentAnnotationId !== null) return null;
  const anchor = normalizeAnchor(value);
  if (!anchor) return null;
  return {
    id: value.id,
    ownerId: value.ownerId,
    projectId: value.projectId,
    chapter: chapter.data,
    note,
    createdAt: value.createdAt,
    ...anchor,
    ...(kind === "reply" ? { parentAnnotationId: value.parentAnnotationId as string } : {}),
  };
}

export function normalizeBaselineAnnotationDraft(value: unknown): BaselineAnnotationDraft | null {
  return normalizeItem(value, "annotation") as BaselineAnnotationDraft | null;
}

export function normalizeBaselineAnnotationReplyDraft(value: unknown): BaselineAnnotationReplyDraft | null {
  return normalizeItem(value, "reply") as BaselineAnnotationReplyDraft | null;
}

export function normalizeBaselineAnnotationDraftData(value: unknown): BaselineAnnotationDraftData {
  if (!isRecord(value)) return { annotations: [], replies: [] };
  const annotations: BaselineAnnotationDraft[] = [];
  const replies: BaselineAnnotationReplyDraft[] = [];
  const ids = new Set<string>();
  const rawAnnotations = Array.isArray(value.annotations) ? value.annotations : [];
  const rawReplies = Array.isArray(value.replies) ? value.replies : [];
  for (const raw of rawAnnotations) {
    if (annotations.length + replies.length >= BASELINE_ANNOTATION_STORE_LIMIT) break;
    const item = normalizeBaselineAnnotationDraft(raw);
    if (!item || ids.has(item.id)) continue;
    ids.add(item.id);
    annotations.push(item);
  }
  for (const raw of rawReplies) {
    if (annotations.length + replies.length >= BASELINE_ANNOTATION_STORE_LIMIT) break;
    const item = normalizeBaselineAnnotationReplyDraft(raw);
    if (!item || ids.has(item.id)) continue;
    ids.add(item.id);
    replies.push(item);
  }
  return { annotations, replies };
}

export function addBaselineAnnotationDraft(
  data: BaselineAnnotationDraftData,
  item: BaselineAnnotationDraftItem,
): BaselineAnnotationDraftData {
  const current = normalizeBaselineAnnotationDraftData(data);
  if (current.annotations.length + current.replies.length >= BASELINE_ANNOTATION_STORE_LIMIT) return current;
  if ("parentAnnotationId" in item) {
    const reply = normalizeBaselineAnnotationReplyDraft(item);
    if (!reply || current.annotations.some((entry) => entry.id === reply.id) || current.replies.some((entry) => entry.id === reply.id)) return current;
    return { ...current, replies: [...current.replies, reply] };
  }
  const annotation = normalizeBaselineAnnotationDraft(item);
  if (!annotation || current.annotations.some((entry) => entry.id === annotation.id) || current.replies.some((entry) => entry.id === annotation.id)) return current;
  return { ...current, annotations: [...current.annotations, annotation] };
}

export function updateBaselineAnnotationDraft(
  data: BaselineAnnotationDraftData,
  id: string,
  patch: BaselineAnnotationDraftUpdate,
): BaselineAnnotationDraftData {
  const current = normalizeBaselineAnnotationDraftData(data);
  const annotation = current.annotations.find((entry) => entry.id === id);
  if (annotation) {
    const updated = normalizeBaselineAnnotationDraft({ ...annotation, ...patch, id });
    if (!updated) return current;
    return {
      ...current,
      annotations: current.annotations.map((entry) => entry.id === id ? updated : entry),
    };
  }
  const reply = current.replies.find((entry) => entry.id === id);
  if (!reply) return current;
  const updated = normalizeBaselineAnnotationReplyDraft({ ...reply, ...patch, id });
  if (!updated) return current;
  return {
    ...current,
    replies: current.replies.map((entry) => entry.id === id ? updated : entry),
  };
}

export function deleteBaselineAnnotationDraft(
  data: BaselineAnnotationDraftData,
  id: string,
): BaselineAnnotationDraftData {
  const current = normalizeBaselineAnnotationDraftData(data);
  return {
    annotations: current.annotations.filter((entry) => entry.id !== id),
    replies: current.replies.filter((entry) => entry.id !== id),
  };
}

export const useBaselineAnnotationDraftStore = createDraftStore<BaselineAnnotationDraftData>({
  storageKey: "multica_baseline_annotation_draft",
  emptyData: EMPTY_BASELINE_ANNOTATION_DRAFT,
  hasMeaningful: (data) => data.annotations.length > 0 || data.replies.length > 0,
  migrateData: normalizeBaselineAnnotationDraftData,
});
