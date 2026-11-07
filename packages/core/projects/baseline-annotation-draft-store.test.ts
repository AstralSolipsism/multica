// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  addBaselineAnnotationDraft,
  BASELINE_ANNOTATION_DRAFT_LIMIT,
  BASELINE_ANNOTATION_STORE_LIMIT,
  deleteBaselineAnnotationDraft,
  EMPTY_BASELINE_ANNOTATION_DRAFT,
  normalizeBaselineAnnotationDraft,
  normalizeBaselineAnnotationDraftData,
  updateBaselineAnnotationDraft,
  useBaselineAnnotationDraftStore,
  type BaselineAnnotationDraft,
  type BaselineAnnotationDraftData,
  type BaselineAnnotationReplyDraft,
} from "./baseline-annotation-draft-store";

const annotation = (overrides: Partial<BaselineAnnotationDraft> = {}): BaselineAnnotationDraft => ({
  id: "local-1",
  ownerId: "member-1",
  projectId: "project-1",
  chapter: "domain_rules",
  anchorKind: "lines",
  targetRevisionId: "revision-1",
  sectionAnchor: "RULE-1",
  sectionTitle: "Settlement",
  lineStart: 2,
  lineEnd: 3,
  quote: "one\ntwo",
  note: "Clarify this",
  createdAt: "2026-11-06T00:00:00Z",
  ...overrides,
});

const reply = (overrides: Partial<BaselineAnnotationReplyDraft> = {}): BaselineAnnotationReplyDraft => ({
  ...annotation({ id: "reply-1" }),
  parentAnnotationId: "server-annotation-1",
  note: "Additional context",
  ...overrides,
});

afterEach(() => useBaselineAnnotationDraftStore.getState().clearDraft());

describe("baseline annotation draft normalization", () => {
  it("trims notes and measures note and quote limits by Unicode code point", () => {
    expect(normalizeBaselineAnnotationDraft(annotation({ note: "  Clarify this  " }))?.note).toBe("Clarify this");
    expect(normalizeBaselineAnnotationDraft(annotation({ note: "😀".repeat(1000), quote: "😀".repeat(500) }))).not.toBeNull();
    expect(normalizeBaselineAnnotationDraft(annotation({ note: "😀".repeat(1001) }))).toBeNull();
    expect(normalizeBaselineAnnotationDraft(annotation({ quote: "😀".repeat(501) }))).toBeNull();
    expect(normalizeBaselineAnnotationDraft(annotation({ note: " \n " }))).toBeNull();
  });

  it("accepts valid Diff ranges and text block lines while rejecting malformed or section lines", () => {
    expect(normalizeBaselineAnnotationDraft(annotation({ lineStart: 1, lineEnd: 50 }))).not.toBeNull();
    expect(normalizeBaselineAnnotationDraft(annotation({ lineStart: 1, lineEnd: 51 }))).toBeNull();
    expect(normalizeBaselineAnnotationDraft(annotation({ lineStart: 0, lineEnd: 1 }))).toBeNull();
    expect(normalizeBaselineAnnotationDraft(annotation({ lineStart: 3, lineEnd: 2 }))).toBeNull();
    expect(normalizeBaselineAnnotationDraft(annotation({ anchorKind: "text", lineStart: 2, lineEnd: 4 }))).toMatchObject({ lineStart: 2, lineEnd: 4 });
    expect(normalizeBaselineAnnotationDraft(annotation({ anchorKind: "text", lineEnd: undefined }))).toBeNull();
    expect(normalizeBaselineAnnotationDraft(annotation({ anchorKind: "section" }))).toBeNull();
    expect(normalizeBaselineAnnotationDraft(annotation({ anchorKind: "section", lineStart: undefined, lineEnd: undefined }))).not.toBeNull();
  });

  it("filters malformed persisted entries and duplicate IDs", () => {
    const annotations = Array.from({ length: 19 }, (_, index) => annotation({ id: `annotation-${index}` }));
    const migrated = normalizeBaselineAnnotationDraftData({
      annotations: [
        ...annotations,
        annotation({ id: "annotation-0" }),
        annotation({ id: "broken", note: "" }),
        { id: "not-an-annotation" },
      ],
      replies: [reply(), reply({ id: "reply-2" })],
    });

    expect(migrated.annotations).toHaveLength(19);
    expect(migrated.replies).toHaveLength(2);
    expect(migrated.replies[0]?.parentAnnotationId).toBe("server-annotation-1");
    expect(normalizeBaselineAnnotationDraftData(null)).toEqual(EMPTY_BASELINE_ANNOTATION_DRAFT);
    expect(normalizeBaselineAnnotationDraftData({ annotations: {}, replies: "bad" })).toEqual(EMPTY_BASELINE_ANNOTATION_DRAFT);
  });
});

describe("baseline annotation draft helpers", () => {
  it("adds, updates, and deletes annotations and replies without losing reply anchors", () => {
    const empty: BaselineAnnotationDraftData = { annotations: [], replies: [] };
    const withAnnotation = addBaselineAnnotationDraft(empty, annotation({ note: "  First  " }));
    const withReply = addBaselineAnnotationDraft(withAnnotation, reply());

    expect(withAnnotation.annotations[0]?.note).toBe("First");
    expect(withReply.replies[0]).toMatchObject({
      parentAnnotationId: "server-annotation-1",
      targetRevisionId: "revision-1",
      sectionAnchor: "RULE-1",
      lineStart: 2,
      lineEnd: 3,
      quote: "one\ntwo",
    });

    const updated = updateBaselineAnnotationDraft(withReply, "reply-1", { note: "  Updated reply  " });
    expect(updated.replies[0]?.note).toBe("Updated reply");
    expect(updated.replies[0]?.sectionAnchor).toBe("RULE-1");
    expect(updateBaselineAnnotationDraft(updated, "reply-1", { note: " " }).replies[0]?.note).toBe("Updated reply");

    expect(deleteBaselineAnnotationDraft(updated, "local-1").annotations).toEqual([]);
    expect(deleteBaselineAnnotationDraft(updated, "reply-1").replies).toEqual([]);
  });

  it("enforces the shared store limit and duplicate IDs when adding", () => {
    let data = { annotations: [], replies: [] } as BaselineAnnotationDraftData;
    for (let index = 0; index < BASELINE_ANNOTATION_STORE_LIMIT; index++) {
      data = addBaselineAnnotationDraft(data, annotation({ id: `annotation-${index}` }));
    }
    expect(addBaselineAnnotationDraft(data, reply()).replies).toEqual([]);
    expect(addBaselineAnnotationDraft(
      { annotations: [annotation()], replies: [] },
      annotation(),
    ).annotations).toHaveLength(1);
  });

  it("keeps different projects and chapters under one workspace store independently addable", () => {
    let data = { annotations: [], replies: [] } as BaselineAnnotationDraftData;
    for (let index = 0; index < BASELINE_ANNOTATION_DRAFT_LIMIT; index++) {
      data = addBaselineAnnotationDraft(data, annotation({ id: `a-${index}` }));
    }
    const otherChapter = addBaselineAnnotationDraft(data, annotation({
      id: "other-chapter", chapter: "architecture" as never,
    }));
    expect(otherChapter.annotations).toHaveLength(BASELINE_ANNOTATION_DRAFT_LIMIT + 1);
  });
});

describe("useBaselineAnnotationDraftStore", () => {
  it("stores both pending arrays and clears all local review work", () => {
    const store = useBaselineAnnotationDraftStore.getState();
    expect(store.hasDraft()).toBe(false);
    store.setDraft({ annotations: [annotation()], replies: [reply()] });
    expect(useBaselineAnnotationDraftStore.getState().hasDraft()).toBe(true);
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toHaveLength(1);
    useBaselineAnnotationDraftStore.getState().clearDraft();
    expect(useBaselineAnnotationDraftStore.getState().draft).toEqual(EMPTY_BASELINE_ANNOTATION_DRAFT);
    expect(useBaselineAnnotationDraftStore.getState().hasDraft()).toBe(false);
  });
});
