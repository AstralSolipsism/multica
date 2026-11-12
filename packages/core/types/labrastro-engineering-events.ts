// Fork-owned WebSocket payload types for the engineering module
// (project engineering overview / baseline wiki / wiki comments). Declared in
// a fork file so upstream `events.ts` only carries the event names and the
// payload-map entries (see docs/engineering/upstream-sync-checklist.md).

export interface ProjectEngineeringUpdatedPayload {
  project_id: string;
}

export interface ProjectBaselineChangedPayload {
  project_id: string;
  page_id: string;
  slug: string;
  change: "content" | "tree" | "archive";
  revision_number?: number;
}

export interface ProjectBaselineCommentChangedPayload {
  project_id: string;
  page_id: string;
  thread_id: string;
}
