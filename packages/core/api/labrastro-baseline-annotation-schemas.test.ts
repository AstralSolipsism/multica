// @vitest-environment node
import { expect, it } from "vitest";
import { parseWithFallback } from "./schema";
import { BaselineAnnotationBatchClosedSchema, BaselineAnnotationBatchesSchema, BaselineAnnotationDetailSchema, BaselineAnnotationSchema, BaselineAnnotationsUpdatedSchema, BaselineReviewSubmittedSchema } from "./labrastro-baseline-annotation-schemas";

const id = "00000000-0000-4000-8000-000000000001";
const batch = { id, workspace_id: id, project_id: id, chapter: "domain_rules", carrier_kind: "revision_issue", agent_id: id, created_by_id: id, created_at: "2026-11-06T00:00:00Z", state: "active", carrier: { kind: "revision_issue", issue_id: id }, counts: { open: 1, resolved: 0 } };
const annotation = { id, ordinal: 1, review_id: id, anchor_kind: "section", section_anchor: "RULE-1", target_revision_id: id, target_revision_number: 1, note: "Revise", created_by_id: id, created_at: batch.created_at, state: "open", location: "exact", side: "after" };

it("keeps unknown states explicit and absent optional location fields nullable", () => {
  const parsed = BaselineAnnotationSchema.parse({ ...annotation, location: "future", state: "future" });
  expect(parsed.location).toBe("unknown");
  expect(parsed.state).toBe("unknown");
  expect(parsed.parentAnnotationId).toBeNull();
  expect(parsed.response).toBeNull();
  expect(parsed.located).toBeNull();
  expect(BaselineAnnotationDetailSchema.parse({ batch, reviews: [], annotations: [annotation] }).sections).toEqual([]);
});

it("rejects missing or malformed response contracts", () => {
  expect(parseWithFallback({ batches: [{ ...batch, counts: { open: "1", resolved: 0 } }] }, BaselineAnnotationBatchesSchema, null, { endpoint: "baseline annotations" })).toBeNull();
  expect(parseWithFallback({ batch, reviews: [], annotations: [{ ...annotation, ordinal: 51 }] }, BaselineAnnotationDetailSchema, null, { endpoint: "baseline annotations" })).toBeNull();
  expect(parseWithFallback({ batch, review: {}, carrier: batch.carrier, woke: { agent_id: id, via: "assign" } }, BaselineReviewSubmittedSchema, null, { endpoint: "baseline annotations" })).toBeNull();
  expect(parseWithFallback({ batch: { ...batch, agent_id: "invalid" } }, BaselineAnnotationBatchClosedSchema, null, { endpoint: "baseline annotations" })).toBeNull();
  expect(parseWithFallback({ updated: 0 }, BaselineAnnotationsUpdatedSchema, null, { endpoint: "baseline annotations" })).toBeNull();
});
