// Fork-owned re-exports for the engineering module's API schemas, payload
// types and client option types. `./index.ts` re-exports this file wholesale
// so consumers keep importing from "@multica/core/api"
// (see docs/engineering/upstream-sync-checklist.md).

import type {
  BaselineDecision,
  BaselineDiff,
  EngineeringOverview,
} from "./labrastro-engineering-schemas";

export {
  BaselineChapterSchema,
  BaselineDecisionSchema,
  BaselineDiffSchema,
  BaselineHistorySchema,
  BaselineRevisionSchema,
  EngineeringConfigSchema,
  EngineeringStageSchema,
  EngineeringOverviewSchema,
  EngineeringUpdatedSchema,
} from "./labrastro-engineering-schemas";
export type {
  BaselineChapter,
  BaselineDecision,
  BaselineDiff,
  BaselineHistory,
  BaselineRevision,
  EngineeringConfig,
  EngineeringStage,
  EngineeringOverview,
} from "./labrastro-engineering-schemas";
export type {
  BaselineAnnotationBatchRow,
  BaselineAnnotationBatch,
  BaselineAnnotationBatches,
  BaselineReview,
  BaselineAnnotation,
  BaselineAnnotationDetail,
  BaselineAnnotationSection,
  BaselineReviewSubmitted,
  BaselineAnnotationsUpdated,
  BaselineAnnotationBatchClosed,
} from "./labrastro-baseline-annotation-schemas";
export type { BaselineHistoryOptions } from "./labrastro-engineering-api";
export type {
  BaselineAnnotationBatchListState,
  BaselineAnnotationDetailState,
  GetProjectBaselineAnnotationBatchesOptions,
  GetProjectBaselineAnnotationBatchOptions,
  BaselineReviewAnnotationInput,
  SubmitProjectBaselineReviewInput,
  ResolveProjectBaselineAnnotationsInput,
} from "./labrastro-baseline-annotation-api";
export type BaselineChange = BaselineDiff["added"][number];
export type ChapterState = EngineeringOverview["chapters"][number];
export type OpenIssue = BaselineDecision["openIssues"]["inFlight"][number];
