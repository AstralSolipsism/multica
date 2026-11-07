import { useCallback, useMemo } from "react";
import type { BaselineAnnotation, BaselineChapter } from "@multica/core/api";
import {
  addBaselineAnnotationDraft,
  BASELINE_ANNOTATION_DRAFT_LIMIT,
  deleteBaselineAnnotationDraft,
  updateBaselineAnnotationDraft,
  useBaselineAnnotationDraftStore,
} from "@multica/core/projects/baseline-annotation-draft-store";
import { createSafeId } from "@multica/core/utils";
import {
  chapterDraftItems,
  newBaselineAnnotation,
  newBaselineAnnotationReply,
  type BaselineComposerAnchor,
} from "./engineering-baseline-annotation-model";

export function useBaselineAnnotationDrafts(options: {
  projectId: string;
  chapter: BaselineChapter;
  ownerId: string;
  canDecide: boolean;
}) {
  const { projectId, chapter, ownerId, canDecide } = options;
  const draft = useBaselineAnnotationDraftStore((state) => state.draft);
  const items = useMemo(
    () => chapterDraftItems(draft, projectId, chapter, ownerId, canDecide),
    [draft, projectId, chapter, ownerId, canDecide],
  );
  const total = draft.annotations.length + draft.replies.length;
  const limitReached = total >= BASELINE_ANNOTATION_DRAFT_LIMIT;

  const addAnnotation = useCallback((anchor: BaselineComposerAnchor, note: string) => {
    const store = useBaselineAnnotationDraftStore.getState();
    if (!ownerId || !canDecide || store.draft.annotations.length + store.draft.replies.length >= BASELINE_ANNOTATION_DRAFT_LIMIT) return false;
    const { side: _side, targetLabel: _targetLabel, endRowIndex: _endRowIndex, ...draftAnchor } = anchor;
    const item = newBaselineAnnotation(draftAnchor, note.trim(), {
      id: createSafeId(), ownerId, projectId, chapter, createdAt: new Date().toISOString(),
    });
    store.setDraft(addBaselineAnnotationDraft(store.draft, item));
    return true;
  }, [canDecide, chapter, ownerId, projectId]);

  const addReply = useCallback((parent: BaselineAnnotation, note: string) => {
    const store = useBaselineAnnotationDraftStore.getState();
    if (!ownerId || !canDecide || store.draft.annotations.length + store.draft.replies.length >= BASELINE_ANNOTATION_DRAFT_LIMIT) return false;
    const item = newBaselineAnnotationReply(parent, note.trim(), {
      id: createSafeId(), ownerId, projectId, chapter, createdAt: new Date().toISOString(),
    });
    store.setDraft(addBaselineAnnotationDraft(store.draft, item));
    return true;
  }, [canDecide, chapter, ownerId, projectId]);

  const update = useCallback((id: string, note: string) => {
    const store = useBaselineAnnotationDraftStore.getState();
    store.setDraft(updateBaselineAnnotationDraft(store.draft, id, { note: note.trim() }));
  }, []);

  const remove = useCallback((id: string) => {
    const store = useBaselineAnnotationDraftStore.getState();
    store.setDraft(deleteBaselineAnnotationDraft(store.draft, id));
  }, []);

  const clear = useCallback((ids: ReadonlySet<string>) => {
    const store = useBaselineAnnotationDraftStore.getState();
    store.setDraft({
      annotations: store.draft.annotations.filter((item) => !ids.has(item.id)),
      replies: store.draft.replies.filter((item) => !ids.has(item.id)),
    });
  }, []);

  return { items, total, limitReached, addAnnotation, addReply, update, remove, clear };
}
