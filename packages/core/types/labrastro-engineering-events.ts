// Fork-owned WebSocket payload types for the engineering module
// (project engineering overview / baseline wiki / baseline annotations).
// Declared in a fork file so upstream `events.ts` only carries the event
// names and the payload-map entries (see docs/engineering/upstream-sync-checklist.md).

import type { BaselineChapter } from "../api/labrastro-engineering-schemas";

export interface ProjectEngineeringUpdatedPayload {
  project_id: string;
}

export interface ProjectBaselineChangedPayload {
  project_id: string;
  chapter: BaselineChapter;
}

export interface ProjectBaselineAnnotationChangedPayload {
  project_id: string;
  chapter: BaselineChapter;
  batch_id: string;
}
