import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, type BaselineAnnotation, type BaselineAnnotationBatch, type BaselineAnnotationDetail, type BaselineChapter, type BaselineReviewSubmitted, type BaselineRevision, type ChapterState, type IssueGraphNode } from "@multica/core/api";
import {
  useBaselineAnnotationDraftStore,
  type BaselineAnnotationDraft,
  type BaselineAnnotationDraftItem,
  type BaselineAnnotationReplyDraft,
} from "@multica/core/projects/baseline-annotation-draft-store";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";
import { EngineeringBaseline } from "./engineering-baseline";
import { buildEngineeringRoadmap } from "./engineering-utils";
import type { BaselineAnnotationActions } from "./engineering-baseline-annotation-model";

type SubmitReviewMock = ReturnType<typeof vi.fn<BaselineAnnotationActions["onSubmitReview"]>>;
type ResolveAnnotationsMock = ReturnType<typeof vi.fn<BaselineAnnotationActions["onResolveAnnotations"]>>;
type CloseBatchMock = ReturnType<typeof vi.fn<BaselineAnnotationActions["onCloseBatch"]>>;
type DecisionMock = ReturnType<typeof vi.fn<(action: "adopt" | "reject", revision: BaselineRevision, annotationBatchAction?: "close" | "keep") => Promise<boolean>>>;

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (type: string, id: string) => type === "agent" ? `Agent ${id}` : `Actor ${id}` }),
}));
vi.mock("../../issues/utils/status-label", () => ({ useStatusLabel: () => (status: string) => status }));

const navigation = {
  push: vi.fn(), replace: vi.fn(), back: vi.fn(), pathname: "/acme/projects/project-1/engineering",
  searchParams: new URLSearchParams(), hash: "", openInNewTab: vi.fn(), getShareableUrl: (path: string) => path,
} as unknown as NavigationAdapter;

const candidate: BaselineRevision = {
  id: "rev-candidate",
  workspaceId: "ws-1",
  projectId: "project-1",
  chapter: "domain_rules",
  revisionNumber: 3,
  status: "candidate",
  contentMarkdown: "### [Rule-1] 幂等键\n所有写接口必须携带幂等键。\n\n### 新增小节\n新增内容。",
  changeSummary: "Review wording",
  baseRevisionId: "rev-base",
  replacesRevisionId: null,
  sourceIssueId: "issue-42",
  anchorsDiff: {
    chapter: "domain_rules", baseRevisionNumber: 2, added: [], modified: [], removed: [], unchangedCount: 0, warnings: [],
  },
  createdByType: "agent",
  createdById: "agent-1",
  createdByTaskId: null,
  createdAt: "2026-01-01T00:00:00Z",
  decidedByType: null,
  decidedById: null,
  decidedByTaskId: null,
  decidedAt: null,
  decisionCredential: null,
};
const adopted: BaselineRevision = {
  ...candidate,
  id: "rev-base",
  revisionNumber: 2,
  status: "adopted",
  contentMarkdown: "### [Rule-1] 幂等键\n所有写接口应该携带幂等键。\n\n### 保留小节\n保留内容。",
  sourceIssueId: null,
};
const chapter: ChapterState = { chapter: "domain_rules", title: "", position: 0, adopted, candidate };
const nodes = [{ id: "issue-42", identifier: "OL-42", title: "Implement idempotency", stage: 6, status: "in_progress", statusCategory: "started" }] as IssueGraphNode[];
const roadmap = buildEngineeringRoadmap(nodes, [{ stage: 6, title: "Backend", goal: "Ship it" }], 6);

function batch(overrides: Partial<BaselineAnnotationBatch> = {}): BaselineAnnotationBatch {
  return {
    id: "batch-1", workspaceId: "ws-1", projectId: "project-1", chapter: "domain_rules",
    carrierKind: "source_issue", issueId: "issue-42", agentId: "agent-1", createdById: "user-1",
    createdAt: "2026-01-01T00:00:00Z", closedAt: null, closeReason: null, closedById: null, closedRevisionId: null,
    state: "active", carrier: { kind: "source_issue", issueId: "issue-42", identifier: "OL-42" },
    working: { revisionId: "rev-candidate", revisionNumber: 3, status: "candidate" },
    counts: { open: 1, resolved: 0 }, ...overrides,
  };
}

function rootAnnotation(overrides: Partial<BaselineAnnotation> = {}): BaselineAnnotation {
  return {
    id: "annotation-1", ordinal: 1, reviewId: "review-1", parentAnnotationId: null,
    anchorKind: "lines", sectionAnchor: "Rule-1", sectionTitle: "幂等键",
    targetRevisionId: "rev-candidate", targetRevisionNumber: 3, side: "after",
    lineStart: 2, lineEnd: 2, quote: "所有写接口必须携带幂等键。", prefix: "", suffix: "", start: 0,
    note: "Clarify retries", response: "Updated the wording", respondedAt: "2026-01-02T00:00:00Z", respondedByTaskId: "task-1",
    createdById: "user-1", createdAt: "2026-01-01T00:00:00Z", resolvedAt: null, resolvedById: null,
    state: "open", location: "exact", located: { revisionNumber: 3, lineStart: 2, lineEnd: 2, start: undefined }, ...overrides,
  };
}

function detail(annotations: BaselineAnnotation[] = [], related = true): BaselineAnnotationDetail {
  return {
    batch: batch(),
    reviews: related ? [{
      id: "review-1", batchId: "batch-1", clientKey: "client-1", reviewedRevisionId: "rev-candidate",
      summary: "", wakeCommentId: null, createdById: "user-1", createdAt: "2026-01-01T00:00:00Z",
    }] : [],
    annotations,
    sections: [],
  };
}

function reviewResult(): BaselineReviewSubmitted {
  const current = batch();
  return {
    batch: {
      id: current.id, workspaceId: current.workspaceId, projectId: current.projectId, chapter: current.chapter,
      carrierKind: current.carrierKind, issueId: current.issueId, agentId: current.agentId, createdById: current.createdById,
      createdAt: current.createdAt, closedAt: null, closeReason: null, closedById: null, closedRevisionId: null,
    },
    review: {
      id: "review-new", batchId: current.id, clientKey: "client-new", reviewedRevisionId: "rev-candidate",
      summary: "", wakeCommentId: null, createdById: "user-1", createdAt: "2026-01-03T00:00:00Z",
    },
    carrier: current.carrier,
    woke: { agentId: "agent-1", via: "mention" },
  };
}

function pending(overrides: Partial<BaselineAnnotationDraft> = {}): BaselineAnnotationDraft {
  return {
    id: "local-1", ownerId: "user-1", projectId: "project-1", chapter: "domain_rules",
    anchorKind: "lines", targetRevisionId: "rev-candidate", sectionAnchor: "Rule-1", sectionTitle: "幂等键",
    lineStart: 2, lineEnd: 2, quote: "所有写接口必须携带幂等键。", note: "Pending note", createdAt: "2026-01-03T00:00:00Z",
    ...overrides,
  };
}

function pendingReply(overrides: Partial<BaselineAnnotationReplyDraft> = {}): BaselineAnnotationReplyDraft {
  return {
    ...pending({ id: "local-reply", targetRevisionId: "rev-old", note: "Pending reply" }),
    parentAnnotationId: "annotation-1", ...overrides,
  };
}

function seed(items: BaselineAnnotationDraftItem[]) {
  useBaselineAnnotationDraftStore.getState().setDraft({
    annotations: items.filter((item): item is BaselineAnnotationDraft => !("parentAnnotationId" in item)),
    replies: items.filter((item): item is BaselineAnnotationReplyDraft => "parentAnnotationId" in item),
  });
}

function renderBaseline(options: {
  canDecide?: boolean;
  batches?: BaselineAnnotationBatch[];
  details?: BaselineAnnotationDetail[];
  onSubmitReview?: SubmitReviewMock;
  onResolveAnnotations?: ResolveAnnotationsMock;
  onCloseBatch?: CloseBatchMock;
  onDecision?: DecisionMock;
} = {}) {
  const onSubmitReview = options.onSubmitReview ?? vi.fn(async () => reviewResult());
  const onResolveAnnotations = options.onResolveAnnotations ?? vi.fn(async () => ({ updated: 1 }));
  const onCloseBatch = options.onCloseBatch ?? vi.fn(async () => ({ batch: reviewResult().batch }));
  const onDecision = options.onDecision ?? vi.fn(async () => true);
  const result = renderWithI18n(
    <NavigationProvider value={navigation}>
      <EngineeringBaseline
        workspaceSlug="acme"
        workspaceId="ws-1"
        projectId="project-1"
        projectTitle="Project"
        chapters={[chapter]}
        selectedChapter="domain_rules"
        onChapterChange={vi.fn()}
        revision={candidate}
        currentCandidate
        candidateLoading={false}
        candidateNotFound={false}
        canDecide={options.canDecide ?? true}
        decisionPending={false}
        decisionError={false}
        decisionResult={null}
        onDecision={onDecision}
        annotations={{
          batches: options.batches ?? [], details: options.details ?? [], loading: false, error: false,
          actions: { ownerId: "user-1", agents: [], onSubmitReview, onResolveAnnotations, onCloseBatch },
        }}
        savePending={false}
        onSave={vi.fn()}
        history={null}
        historyLoading={false}
        historyError={false}
        onHistoryMore={vi.fn()}
        chapterRevisions={{}}
        roadmap={roadmap}
        reviewRequested
        lens="manage"
        onOpenStage={vi.fn()}
      />
    </NavigationProvider>,
  );
  return { ...result, onSubmitReview, onResolveAnnotations, onCloseBatch, onDecision };
}

async function addLineAnnotation(user: ReturnType<typeof userEvent.setup>, name: string, note: string) {
  await user.click(screen.getByRole("button", { name: `${name} in 幂等键` }));
  const composer = document.querySelector("[data-annotation-composer]")!;
  await user.type(within(composer as HTMLElement).getByRole("textbox"), note);
  await user.click(within(composer as HTMLElement).getByRole("button", { name: "Add to review" }));
}

beforeEach(() => {
  useBaselineAnnotationDraftStore.getState().clearDraft();
  window.localStorage.clear();
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("baseline source annotations", () => {
  it("uses raw section Markdown with title line numbers and supports before, after, and context without network calls", async () => {
    const user = userEvent.setup();
    const { onSubmitReview, onDecision } = renderBaseline();
    expect(document.querySelector("[data-baseline-source-diff]")).toBeInTheDocument();
    expect(document.querySelector("[data-diff-before]")).not.toBeInTheDocument();
    expect(document.querySelector('[data-diff-row="0"]')).toHaveTextContent("### [Rule-1] 幂等键");

    await addLineAnnotation(user, "Annotate Before line 2", "Before note");
    await addLineAnnotation(user, "Annotate After line 2", "After note");
    await addLineAnnotation(user, "Annotate Before line 1", "Context before");
    await addLineAnnotation(user, "Annotate After line 1", "Context after");

    const drafts = useBaselineAnnotationDraftStore.getState().draft.annotations;
    expect(drafts).toHaveLength(4);
    expect(drafts.map((item) => [item.targetRevisionId, item.lineStart])).toEqual([
      ["rev-base", 2], ["rev-candidate", 2], ["rev-base", 1], ["rev-candidate", 1],
    ]);
    expect(onSubmitReview).not.toHaveBeenCalled();
    expect(onDecision).not.toHaveBeenCalled();
    expect(screen.getAllByText("Pending · Only visible to you")).toHaveLength(4);
  });

  it("edits and deletes local annotations without submitting them", async () => {
    const user = userEvent.setup();
    const { onSubmitReview } = renderBaseline();
    await addLineAnnotation(user, "Annotate After line 2", "Original");
    const card = document.querySelector("[data-pending-annotation]") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Edit" }));
    const input = within(card).getByRole("textbox", { name: "Edit annotation" });
    await user.clear(input);
    await user.type(input, "Updated locally");
    await user.click(within(card).getByRole("button", { name: "Save" }));
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations[0]?.note).toBe("Updated locally");
    await user.click(within(card).getByRole("button", { name: "Delete" }));
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toEqual([]);
    expect(onSubmitReview).not.toHaveBeenCalled();
  });

  it("keeps a drag on its starting side and selects multiple lines only on that side", async () => {
    const user = userEvent.setup();
    renderBaseline();
    const before = screen.getByRole("button", { name: "Annotate Before line 2 in 幂等键" });
    fireEvent.mouseDown(before, { button: 0 });
    const afterRow = document.querySelector('[data-after-line="2"]')!;
    fireEvent.mouseEnter(afterRow);
    fireEvent.mouseUp(window);
    expect(document.querySelector("[data-annotation-composer]")).toHaveTextContent("所有写接口应该携带幂等键。");
    expect(document.querySelector("[data-annotation-composer]")).toHaveTextContent("Before");
    expect(document.querySelector("[data-annotation-composer]")).toHaveTextContent("Line 2 within section");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const first = screen.getByRole("button", { name: "Annotate Before line 1 in 幂等键" });
    fireEvent.mouseDown(first, { button: 0 });
    fireEvent.mouseEnter(document.querySelector('[data-before-line="2"]')!);
    fireEvent.mouseUp(window);
    expect(document.querySelector("[data-annotation-composer]")).toHaveTextContent("Line 1–2 within section");
  });

  it("shows submitted threads to read-only members while hiding all pending and mutation controls", () => {
    seed([pending()]);
    const outdated = rootAnnotation({ location: "outdated", located: null, lineStart: 99, lineEnd: 99 });
    renderBaseline({ canDecide: false, batches: [batch()], details: [detail([outdated])] });
    expect(screen.getByText("Clarify retries")).toBeInTheDocument();
    expect(screen.getByText("Updated the wording")).toBeInTheDocument();
    expect(screen.getByText("Outdated")).toBeInTheDocument();
    expect(screen.queryByText("Pending note")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Annotate/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adopt" })).not.toBeInTheDocument();
  });

  it("links baseline pending lines to the before side, groups unlocatable items, and counts active replies", () => {
    const root = rootAnnotation();
    seed([
      pending({ id: "base-line", targetRevisionId: "rev-base", lineStart: 2, lineEnd: 2, quote: "所有写接口应该携带幂等键。", note: "Baseline line" }),
      pending({ id: "base-orphan", targetRevisionId: "rev-base", anchorKind: "section", sectionAnchor: "Missing", lineStart: undefined, lineEnd: undefined, quote: undefined, note: "Baseline orphan" }),
      pending({ id: "other-revision", targetRevisionId: "rev-other", note: "Do not submit" }),
      pendingReply(),
    ]);
    renderBaseline({ batches: [batch()], details: [detail([root])] });
    expect(screen.getByText("Baseline line")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-pending-annotation='base-line']")).toHaveLength(1);
    expect(screen.getByText("Baseline annotations")).toBeInTheDocument();
    expect(screen.getByText("Baseline orphan")).toBeInTheDocument();
    expect(screen.queryByText("Do not submit")).not.toBeInTheDocument();
    expect(screen.getByText("Reviewing · 3 pending items")).toBeInTheDocument();
    expect(screen.getByText("Pending reply")).toBeInTheDocument();
  });

  it("submits one review with candidate, baseline, and reply items, then clears only those IDs", async () => {
    const user = userEvent.setup();
    const root = rootAnnotation();
    seed([
      pending({ id: "candidate-item" }),
      pending({ id: "base-item", targetRevisionId: "rev-base", quote: "所有写接口应该携带幂等键。" }),
      pending({ id: "other-item", targetRevisionId: "rev-other", note: "Keep this" }),
      pending({ id: "other-chapter", chapter: "architecture" as BaselineChapter, note: "Keep chapter" }),
      pendingReply(),
    ]);
    const onSubmitReview = vi.fn<BaselineAnnotationActions["onSubmitReview"]>(async () => reviewResult());
    renderBaseline({ batches: [batch()], details: [detail([root])], onSubmitReview });
    await user.click(screen.getByRole("button", { name: "Finish review" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(onSubmitReview).toHaveBeenCalledTimes(1));
    const input = onSubmitReview.mock.calls[0]![0];
    expect(input.reviewedRevisionId).toBe("rev-candidate");
    expect(input.annotations.map((item: { note: string }) => item.note)).toEqual(["Pending note", "Pending note", "Pending reply"]);
    expect(input.annotations.map((item: { targetRevisionId: string }) => item.targetRevisionId)).toEqual(["rev-candidate", "rev-base", "rev-old"]);
    expect(input.assignee).toBeUndefined();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations.map((item) => item.id)).toEqual(["other-item", "other-chapter"]);
    expect(useBaselineAnnotationDraftStore.getState().draft.replies).toEqual([]);
  });

  it("preserves drafts and summary on failure and reuses the clientKey on retry", async () => {
    const user = userEvent.setup();
    seed([pending()]);
    const onSubmitReview = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(reviewResult());
    renderBaseline({ batches: [batch()], details: [detail()], onSubmitReview });
    await user.click(screen.getByRole("button", { name: "Finish review" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Overall note (optional)" }), "Keep this summary");
    await user.click(within(dialog).getByRole("button", { name: "Request changes" }));
    expect(await within(dialog).findByText("The review was not submitted")).toBeInTheDocument();
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toHaveLength(1);
    expect(within(dialog).getByRole("textbox", { name: "Overall note (optional)" })).toHaveValue("Keep this summary");
    const firstKey = onSubmitReview.mock.calls[0]![0].clientKey;
    await user.click(within(dialog).getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(onSubmitReview).toHaveBeenCalledTimes(2));
    expect(onSubmitReview.mock.calls[1]![0].clientKey).toBe(firstKey);
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toEqual([]);
  });

  it("treats a malformed null review result as an error without clearing drafts", async () => {
    const user = userEvent.setup();
    seed([pending()]);
    const onSubmitReview = vi.fn(async () => null);
    renderBaseline({ batches: [batch()], details: [detail()], onSubmitReview });
    await user.click(screen.getByRole("button", { name: "Finish review" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Request changes" }));
    expect(await screen.findByText("The review was not submitted")).toBeInTheDocument();
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toHaveLength(1);
  });

  it.each([
    { action: "Adopt", pending: true, batchAction: "keep", confirm: "Discard and adopt" },
    { action: "Return for changes", pending: false, batchAction: "close", confirm: "Return for changes" },
  ])("confirms $action and passes $batchAction for the related batch", async ({ action, pending: hasPending, batchAction, confirm }) => {
    const user = userEvent.setup();
    if (hasPending) seed([pending()]);
    const onDecision = vi.fn(async () => true);
    renderBaseline({ batches: [batch()], details: [detail()], onDecision });
    await user.click(screen.getByRole("button", { name: action }));
    let dialog = screen.getByRole("dialog");
    if (hasPending) {
      await user.selectOptions(within(dialog).getByLabelText(/Related batch/), "keep");
      await user.click(within(dialog).getByRole("button", { name: action }));
      dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("Discard 1 pending items?")).toBeInTheDocument();
      expect(onDecision).not.toHaveBeenCalled();
      await user.click(within(dialog).getByRole("button", { name: "Back" }));
      expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toHaveLength(1);
      dialog = screen.getByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: action }));
      dialog = screen.getByRole("dialog");
    }
    await user.click(within(dialog).getByRole("button", { name: confirm }));
    await waitFor(() => expect(onDecision).toHaveBeenCalledWith(hasPending ? "adopt" : "reject", candidate, batchAction));
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toEqual([]);
  });

  it("resolves active threads and creates pending replies without a review request", async () => {
    const user = userEvent.setup();
    const onResolveAnnotations = vi.fn(async () => ({ updated: 1 }));
    const onSubmitReview = vi.fn(async () => reviewResult());
    renderBaseline({ batches: [batch()], details: [detail([rootAnnotation()])], onResolveAnnotations, onSubmitReview });
    const thread = document.querySelector("[data-annotation-thread='annotation-1']") as HTMLElement;
    await user.click(within(thread).getByRole("button", { name: "Resolve" }));
    expect(onResolveAnnotations).toHaveBeenCalledWith(["annotation-1"], true);
    await user.click(within(thread).getByRole("button", { name: "Reply" }));
    await user.type(within(thread).getByRole("textbox", { name: "Add context for the next review submission" }), "Local reply");
    await user.click(within(thread).getByRole("button", { name: "Add to review" }));
    expect(useBaselineAnnotationDraftStore.getState().draft.replies[0]?.parentAnnotationId).toBe("annotation-1");
    expect(onSubmitReview).not.toHaveBeenCalled();
  });

  it("keeps the close-batch dialog open on failure and closes it only after success", async () => {
    const user = userEvent.setup();
    const onCloseBatch = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ batch: reviewResult().batch });
    renderBaseline({ batches: [batch()], details: [detail()], onCloseBatch });
    await user.click(screen.getByRole("button", { name: "Active batch · OL-42" }));
    await user.click(screen.getByRole("button", { name: "Close batch" }));
    await user.click(screen.getByRole("button", { name: "Close batch" }));
    expect(await screen.findByText("The batch could not be closed. Your drafts are unchanged.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close batch" }));
    await waitFor(() => expect(onCloseBatch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([
    { code: "baseline_review_conflict", message: "Reject this unrelated candidate or close the active batch before requesting changes.", action: "Reject this candidate" },
    { code: "baseline_candidate_open", message: "This chapter already has a candidate. Review it in the source Diff before requesting changes to the baseline.", action: "Review candidate" },
  ])("shows dedicated guidance for $code and preserves drafts", async ({ code, message, action }) => {
    const user = userEvent.setup();
    seed([pending()]);
    const onSubmitReview = vi.fn(async () => { throw new ApiError("Conflict", 409, "Conflict", { code }); });
    renderBaseline({ onSubmitReview });
    await user.click(screen.getByRole("button", { name: "Finish review" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Request changes" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
    if (code === "baseline_review_conflict") expect(screen.getByRole("link", { name: "OL-42" })).toBeInTheDocument();
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toHaveLength(1);
  });
});
