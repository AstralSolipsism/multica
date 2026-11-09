import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
import { baselineTextAnnotationAtPoint, captureBaselineTextRange, locateBaselineTextAnnotation } from "./engineering-baseline-text-annotations";

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
  reviewRequested?: boolean;
  adoptedContent?: string;
  onSubmitReview?: SubmitReviewMock;
  onResolveAnnotations?: ResolveAnnotationsMock;
  onCloseBatch?: CloseBatchMock;
  onDecision?: DecisionMock;
} = {}) {
  const onSubmitReview = options.onSubmitReview ?? vi.fn(async () => reviewResult());
  const onResolveAnnotations = options.onResolveAnnotations ?? vi.fn(async () => ({ updated: 1 }));
  const onCloseBatch = options.onCloseBatch ?? vi.fn(async () => ({ batch: reviewResult().batch }));
  const onDecision = options.onDecision ?? vi.fn(async () => true);
  const chapterState = options.adoptedContent === undefined ? chapter : { ...chapter, adopted: { ...adopted, contentMarkdown: options.adoptedContent } };
  const result = renderWithI18n(
    <NavigationProvider value={navigation}>
      <EngineeringBaseline
        workspaceSlug="acme"
        workspaceId="ws-1"
        projectId="project-1"
        projectTitle="Project"
        chapters={[chapterState]}
        selectedChapter="domain_rules"
        onChapterChange={vi.fn()}
        revision={candidate}
        currentCandidate
        candidateLoading={false}
        candidateNotFound={false}
        canDecide={options.canDecide ?? true}
        decisionPending={false}
        decisionError={false}
        decisionErrorMessage=""
        onClearDecisionError={vi.fn()}
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
        reviewRequested={options.reviewRequested ?? true}
        pendingCandidates={[candidate]}
        batchIds={[candidate.id]}
        processedRevisionIds={new Set<string>()}
        processedCount={0}
        returnLabel="Back to overview"
        onReturnFromReview={vi.fn()}
        onSelectCandidate={vi.fn()}
        onOpenProcessed={vi.fn()}
        onReviewCandidate={vi.fn()}
        restorePosition={null}
        lens="manage"
        onOpenStage={vi.fn()}
      />
    </NavigationProvider>,
  );
  if (options.reviewRequested === false) {
    const tab = screen.queryByRole("tab", { name: /Annotations \(\d+\)/ });
    if (tab) fireEvent.click(tab);
  }
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
  HTMLElement.prototype.scrollTo = vi.fn();
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1440 });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 900 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 600, 400));
  Range.prototype.getBoundingClientRect = vi.fn(() => new DOMRect(10, 10, 100, 20));
  Range.prototype.getClientRects = vi.fn(() => [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
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
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Review comment (required)" }), "Please revise the candidate");
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
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Review comment (required)" }), "Keep this summary");
    await user.click(within(dialog).getByRole("button", { name: "Request changes" }));
    expect(await within(dialog).findByText("The review was not submitted")).toBeInTheDocument();
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toHaveLength(1);
    expect(within(dialog).getByRole("textbox", { name: "Review comment (required)" })).toHaveValue("Keep this summary");
    const firstKey = onSubmitReview.mock.calls[0]![0].clientKey;
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onSubmitReview).toHaveBeenCalledTimes(2));
    expect(onSubmitReview.mock.calls[1]![0].clientKey).toBe(firstKey);
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toEqual([]);
  });

  it("treats a malformed null review result as an error without clearing drafts", async () => {
    const user = userEvent.setup();
    seed([pending()]);
    const onSubmitReview = vi.fn(async () => null);
    renderBaseline({ batches: [batch()], details: [detail()], onSubmitReview });
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Review comment (required)" }), "Revise this section");
    await user.click(within(dialog).getByRole("button", { name: "Request changes" }));
    expect(await screen.findByText("The review was not submitted")).toBeInTheDocument();
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toHaveLength(1);
  });

  it.each([
    { action: "Adopt", pending: true, batchAction: "keep", confirm: "Discard and adopt" },
    { action: "Reject", pending: false, batchAction: "close", confirm: "Reject" },
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
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Review comment (required)" }), "Resolve the candidate conflict");
    await user.click(within(dialog).getByRole("button", { name: "Request changes" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
    if (code === "baseline_review_conflict") expect(screen.getByRole("link", { name: "OL-42" })).toBeInTheDocument();
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toHaveLength(1);
  });

  it("reject with pending items requires the discard confirmation before deciding", async () => {
    const user = userEvent.setup();
    seed([pending()]);
    const onDecision = vi.fn(async () => true);
    renderBaseline({ batches: [batch()], details: [detail()], onDecision });
    await user.click(screen.getByRole("button", { name: "Reject" }));
    let dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Reject" }));
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Discard 1 pending items?")).toBeInTheDocument();
    expect(onDecision).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Discard and reject" }));
    await waitFor(() => expect(onDecision).toHaveBeenCalledWith("reject", candidate, "close"));
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toEqual([]);
  });

  it("submits a required overall comment as a section annotation when no inline drafts exist", async () => {
    const user = userEvent.setup();
    const onSubmitReview = vi.fn<BaselineAnnotationActions["onSubmitReview"]>(async () => reviewResult());
    renderBaseline({ onSubmitReview });
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    const dialog = screen.getByRole("dialog");
    const comment = within(dialog).getByRole("textbox", { name: "Review comment (required)" });
    expect(within(dialog).getByRole("button", { name: "Request changes" })).toBeDisabled();
    await user.type(comment, "Summary only");
    const submit = within(dialog).getByRole("button", { name: "Request changes" });
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(onSubmitReview).toHaveBeenCalledTimes(1));
    const input = onSubmitReview.mock.calls[0]![0];
    expect(input.summary).toBe("Summary only");
    expect(input.annotations).toEqual([{
      anchorKind: "section",
      targetRevisionId: "rev-candidate",
      sectionAnchor: "domain_rules",
      sectionTitle: "Domain and rules",
      note: "Summary only",
    }]);
  });

  it("places working-version annotations on their original diff lines and marks foreign targets outdated", () => {
    // Trigger A: candidate-numbered located lines must not leak into the
    // before side; the thread stays on its original before line.
    const moved = rootAnnotation({
      id: "annotation-moved",
      targetRevisionId: "rev-base", targetRevisionNumber: 2,
      side: "before", location: "moved",
      located: { revisionNumber: 3, lineStart: 3, lineEnd: 3, start: undefined },
      lineStart: 2, lineEnd: 2, quote: "所有写接口应该携带幂等键。",
    });
    // Trigger B: deleted lines (outdated in the working version) keep their
    // original before-side placement — no badge while the version is unchanged.
    const outdated = rootAnnotation({
      id: "annotation-outdated",
      targetRevisionId: "rev-base", targetRevisionNumber: 2,
      side: "before", location: "outdated", located: null,
      lineStart: 3, lineEnd: 3,
    });
    // Trigger C: revision-task path targets the adopted revision only.
    const foreign = rootAnnotation({
      id: "annotation-foreign",
      targetRevisionId: "rev-old", targetRevisionNumber: 1,
      side: "unknown", location: "outdated", located: null,
      lineStart: 1, lineEnd: 1,
    });
    renderBaseline({ batches: [batch()], details: [detail([moved, outdated, foreign])] });
    const placed = document.querySelector("[data-annotation-thread='annotation-moved']")!;
    expect(placed.closest("tr")).toBeTruthy();
    expect(placed).toHaveTextContent("Line 2 within section · Before");
    expect(placed).not.toHaveTextContent("Outdated");
    const outdatedCard = document.querySelector("[data-annotation-thread='annotation-outdated']") as HTMLElement;
    expect(within(outdatedCard).queryByText("Outdated")).not.toBeInTheDocument();
    const foreignCard = document.querySelector("[data-annotation-thread='annotation-foreign']") as HTMLElement;
    expect(within(foreignCard).getByText("Outdated")).toBeInTheDocument();
  });

  it("keeps exact threads targeting the working candidate current in reading mode", () => {
    // Reading mode renders the adopted baseline, but a thread targeting the
    // chapter's working candidate is still current (server location "exact")
    // and must not be badged outdated.
    const exact = rootAnnotation();
    renderBaseline({ reviewRequested: false, batches: [batch()], details: [detail([exact])] });
    const card = document.querySelector("[data-annotation-thread='annotation-1']") as HTMLElement;
    expect(within(card).getByText("Clarify retries")).toBeInTheDocument();
    expect(within(card).queryByText("Outdated")).not.toBeInTheDocument();
  });

  it("marks replaced-candidate threads outdated in reading mode", () => {
    const replaced = rootAnnotation({
      targetRevisionId: "rev-replaced", targetRevisionNumber: 2, location: "outdated", located: null,
    });
    renderBaseline({ reviewRequested: false, batches: [batch()], details: [detail([replaced])] });
    const card = document.querySelector("[data-annotation-thread='annotation-1']") as HTMLElement;
    expect(within(card).getByText("Outdated")).toBeInTheDocument();
  });

  it("keeps same-side drag quote free of the opposite side when crossing the change block", async () => {
    const user = userEvent.setup();
    renderBaseline();
    // Drag from the context title (before 1) across the removed/added block to
    // the trailing context row (before 3): the selection spans the opposite-side
    // added row, which must stay out of the quote and line range.
    const first = screen.getByRole("button", { name: "Annotate Before line 1 in 幂等键" });
    fireEvent.mouseDown(first, { button: 0 });
    fireEvent.mouseEnter(document.querySelector('[data-before-line="3"]')!);
    fireEvent.mouseUp(window);
    const composer = document.querySelector("[data-annotation-composer]")!;
    expect(composer).toHaveTextContent("Line 1–3 within section");
    expect(composer).toHaveTextContent("Before");
    const quote = composer.querySelector("blockquote")!.textContent;
    expect(quote).not.toContain("必须");
    expect(quote).toContain("应该");
    await user.type(within(composer as HTMLElement).getByRole("textbox"), "Cross-block note");
    await user.click(within(composer as HTMLElement).getByRole("button", { name: "Add to review" }));
    const draft = useBaselineAnnotationDraftStore.getState().draft.annotations[0]!;
    expect(draft.targetRevisionId).toBe("rev-base");
    expect(draft.lineStart).toBe(1);
    expect(draft.lineEnd).toBe(3);
    expect(draft.quote).not.toContain("必须");
  });
});

describe("baseline Word-style reading annotations", () => {
  it("marks blocks with original section lines across blank lines and extracted rationale", () => {
    renderBaseline({
      reviewRequested: false,
      adoptedContent: [
        "### [Rule-1] 幂等键",
        "",
        "第一段。",
        "",
        "为什么：这段只在小节说明里展开。",
        "",
        "",
        "第二段。",
        "",
        "### 保留小节",
        "保留内容。",
      ].join("\n"),
    });
    const article = document.querySelector('[data-baseline-section-key="domain_rules:Rule-1"]')!;
    const blocks = article.querySelectorAll("p[data-source-start]");
    expect(Array.from(blocks).map((block) => [block.textContent, block.getAttribute("data-source-start")])).toEqual([
      ["第一段。", "3"],
      ["第二段。", "8"],
    ]);
    const retained = document.querySelector<HTMLElement>('[data-baseline-section-key="domain_rules:保留小节"]')!;
    const retainedBlock = retained.querySelector<HTMLElement>("p[data-source-start]")!;
    expect(retainedBlock).toHaveAttribute("data-source-start", "2");
    const range = document.createRange();
    range.selectNodeContents(retainedBlock);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(captureBaselineTextRange(retained, selection)).toMatchObject({ lineStart: 2, lineEnd: 2, quote: "保留内容。" });
    selection.removeAllRanges();
  });

  it("annotates rendered block lines through a selection bubble without a single-send action", async () => {
    const user = userEvent.setup();
    const { onSubmitReview } = renderBaseline({ reviewRequested: false });
    const article = document.querySelector<HTMLElement>('[data-baseline-section-key="domain_rules:Rule-1"]')!;
    const block = article.querySelector<HTMLElement>('p[data-source-start="2"][data-source-end="2"]')!;
    expect(block).toHaveTextContent("所有写接口应该携带幂等键。");
    const text = block.firstChild!;
    const start = (text.textContent ?? "").indexOf("应该");
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + 2);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(captureBaselineTextRange(article, selection)).toMatchObject({ quote: "应该", lineStart: 2, lineEnd: 2 });
    fireEvent.mouseUp(article);

    expect(document.querySelector("[data-annotation-composer]")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Annotate" }));
    const composer = document.querySelector("[data-annotation-composer]") as HTMLElement;
    expect(composer).toHaveTextContent("Annotate selected text");
    expect(within(composer).queryByRole("button", { name: /Send/ })).not.toBeInTheDocument();
    await user.type(within(composer).getByRole("textbox"), "Clarify the baseline wording");
    await user.click(within(composer).getByRole("button", { name: "Add to review" }));

    const draft = useBaselineAnnotationDraftStore.getState().draft.annotations[0]!;
    expect(draft).toMatchObject({ anchorKind: "text", targetRevisionId: "rev-base", lineStart: 2, lineEnd: 2, quote: "应该" });
    expect(onSubmitReview).not.toHaveBeenCalled();
  });

  it("shows and hides the aligned rail and emphasizes a card on hover", async () => {
    const user = userEvent.setup();
    const root = rootAnnotation({
      anchorKind: "text", targetRevisionId: "rev-base", targetRevisionNumber: 2, side: "before",
      lineStart: 2, lineEnd: 2, quote: "所有写接口应该携带幂等键。", prefix: "", suffix: "", start: 0,
    });
    renderBaseline({ reviewRequested: false, batches: [batch()], details: [detail([root])] });
    expect(document.querySelector("[data-reading-rail]")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Annotations (1)" })).toHaveAttribute("aria-selected", "true");
    const card = document.querySelector<HTMLElement>('[data-reading-annotation="annotation-1"]')!;
    fireEvent.mouseEnter(card);
    expect(card).toHaveAttribute("data-annotation-hovered");
    fireEvent.mouseLeave(card);
    expect(card).not.toHaveAttribute("data-annotation-hovered");

    await user.click(screen.getByRole("tab", { name: "Read" }));
    expect(screen.queryByRole("tab", { name: "Annotations (1)" })).toHaveAttribute("aria-selected", "false");
    expect(document.querySelector("[data-reading-rail]")).not.toBeInTheDocument();
    expect(screen.queryByText("Clarify retries")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Annotations (1)" }));
    expect(document.querySelector("[data-reading-rail]")).toBeInTheDocument();
    expect(document.querySelector("[data-reading-rail]")).toHaveTextContent("Clarify retries");
  });

  it("counts unresolved threads and pending items but not resolved threads", () => {
    seed([pending({ id: "reading-pending", targetRevisionId: "rev-base" })]);
    const resolved = rootAnnotation({ state: "resolved", targetRevisionId: "rev-base" });
    renderBaseline({ reviewRequested: false, batches: [batch()], details: [detail([resolved])] });
    expect(screen.getByRole("tab", { name: "Annotations (1)" })).toBeInTheDocument();
    const rail = document.querySelector("[data-reading-rail]")!;
    expect(rail.querySelectorAll("[data-reading-annotation]")).toHaveLength(2);
  });

  it("emphasizes the card when the pointer hits its highlighted source text", async () => {
    const root = rootAnnotation({
      anchorKind: "text", targetRevisionId: "rev-base", targetRevisionNumber: 2, side: "before",
      lineStart: 2, lineEnd: 2, quote: "所有写接口应该携带幂等键。", prefix: "", suffix: "", start: 0,
    });
    renderBaseline({ reviewRequested: false, batches: [batch()], details: [detail([root])] });
    const card = document.querySelector<HTMLElement>('[data-reading-annotation="annotation-1"]')!;
    const block = document.querySelector<HTMLElement>('p[data-source-start="2"]')!;
    const originalCaret = document.caretPositionFromPoint;
    document.caretPositionFromPoint = () => ({ offsetNode: block.firstChild!, offset: 2, getClientRect: () => new DOMRect() });
    try {
      expect(baselineTextAnnotationAtPoint(block.closest<HTMLElement>("[data-baseline-markdown]")!, 10, 10, [root])).toBe("annotation-1");
      fireEvent.mouseMove(block, { clientX: 10, clientY: 10 });
      await waitFor(() => expect(card).toHaveAttribute("data-annotation-hovered"));
    } finally {
      document.caretPositionFromPoint = originalCaret;
    }
  });

  it("opens an overlay drawer and preserves both scroll positions across mask, close, and Escape", async () => {
    const user = userEvent.setup();
    const root = rootAnnotation({
      anchorKind: "text", targetRevisionId: "rev-base", targetRevisionNumber: 2, side: "before",
      lineStart: 2, lineEnd: 2, quote: "所有写接口应该携带幂等键。", prefix: "", suffix: "", start: 0,
    });
    renderBaseline({ reviewRequested: false, batches: [batch()], details: [detail([root])] });
    const reader = document.querySelector<HTMLElement>("[data-baseline-reader]")!;
    const toc = document.querySelector<HTMLElement>("[data-baseline-toc]")!;
    reader.scrollTop = 120;
    toc.scrollTop = 36;

    const drawer = document.querySelector<HTMLElement>("[data-annotation-drawer]")!;
    expect(drawer).toHaveClass("@min-[960px]:hidden");
    expect(drawer.querySelector("button")).toHaveClass("bg-black/35");
    expect(drawer.textContent).toContain("Clarify retries");
    await user.keyboard("{Escape}");
    expect(document.querySelector("[data-annotation-drawer]")).not.toBeInTheDocument();
    expect(reader.scrollTop).toBe(120);
    expect(toc.scrollTop).toBe(36);

    await user.click(screen.getByRole("tab", { name: "Annotations (1)" }));
    const mask = document.querySelector<HTMLElement>("[data-annotation-drawer] > button")!;
    await user.click(mask);
    expect(document.querySelector("[data-annotation-drawer]")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Annotations (1)" }));
    const reopened = document.querySelector<HTMLElement>("[data-annotation-drawer]")!;
    const closeButtons = within(reopened).getAllByRole("button", { name: "Close" });
    await user.click(closeButtons[closeButtons.length - 1]!);
    expect(document.querySelector("[data-annotation-drawer]")).not.toBeInTheDocument();
    expect(reader.scrollTop).toBe(120);
    expect(toc.scrollTop).toBe(36);
  });

  it("keeps text anchors, later selections, and card hover isolated from drawer content", async () => {
    const originalCaret = document.caretPositionFromPoint;
    try {
      const annotation = rootAnnotation({
        anchorKind: "text", targetRevisionId: "rev-base", targetRevisionNumber: 2, side: "before",
        lineStart: 3, lineEnd: 5, quote: "重试。\n\n第二段", prefix: "第一段", suffix: "。\n\n第三段定位。\n", start: 3,
      });
      renderBaseline({
        reviewRequested: false,
        batches: [batch()],
        details: [detail([annotation])],
        adoptedContent: "### [Rule-1] 幂等键\n\n第一段重试。\n\n第二段。\n\n第三段定位。\n\n### 保留小节\n保留内容。",
      });
      await waitFor(() => expect(document.querySelector("[data-annotation-drawer]")).toBeInTheDocument());
      const article = document.querySelector<HTMLElement>('[data-baseline-section-key="domain_rules:Rule-1"]')!;
      const markdown = article.querySelector<HTMLElement>("[data-baseline-markdown]")!;
      const location = locateBaselineTextAnnotation(markdown, annotation);
      expect(location.location).toBe("exact");
      expect(location.range?.toString()).toBe("重试。\n第二段");

      const later = article.querySelector<HTMLElement>('p[data-source-start="7"]')!;
      const text = later.firstChild!;
      const range = document.createRange();
      range.setStart(text, 3);
      range.setEnd(text, 5);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      expect(captureBaselineTextRange(article, selection)).toMatchObject({
        quote: "定位",
        start: 17,
        prefix: "第一段重试。\n\n第二段。\n\n第三段",
        lineStart: 7,
        lineEnd: 7,
      });

      const drawer = document.querySelector<HTMLElement>("[data-annotation-drawer]")!;
      const card = drawer.querySelector<HTMLElement>('[data-reading-annotation="annotation-1"]')!;
      const firstBlock = article.querySelector<HTMLElement>('p[data-source-start="3"]')!;
      document.caretPositionFromPoint = () => ({ offsetNode: firstBlock.firstChild!, offset: 3, getClientRect: () => new DOMRect() });
      const flushFrame = () => act(async () => {
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
      });
      fireEvent.mouseMove(firstBlock);
      await flushFrame();
      expect(card).toHaveAttribute("data-annotation-hovered");

      document.caretPositionFromPoint = () => null;
      fireEvent.mouseEnter(card);
      fireEvent.mouseMove(drawer);
      await flushFrame();
      expect(card).toHaveAttribute("data-annotation-hovered");
    } finally {
      document.caretPositionFromPoint = originalCaret;
      window.getSelection()?.removeAllRanges();
    }
  });

  it("carries baseline drafts through candidate guidance into one Diff review submission", async () => {
    const user = userEvent.setup();
    seed([pending({
      id: "reading-text", anchorKind: "text", targetRevisionId: "rev-base", lineStart: 2, lineEnd: 2,
      quote: "所有写接口应该携带幂等键。", prefix: "", suffix: "", start: 0, note: "Reading pending",
    })]);
    const onSubmitReview = vi.fn<BaselineAnnotationActions["onSubmitReview"]>(async () => reviewResult());
    renderBaseline({ reviewRequested: false, onSubmitReview });

    await user.click(screen.getByRole("button", { name: "Finish review" }));
    const guidance = screen.getByRole("dialog");
    expect(within(guidance).getByText("Review the pending candidate first")).toBeInTheDocument();
    expect(onSubmitReview).not.toHaveBeenCalled();
    await user.click(within(guidance).getByRole("button", { name: "Review candidate" }));

    expect(document.querySelector("[data-baseline-source-diff]")).toBeInTheDocument();
    expect(screen.getByText("Reading pending")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finish review" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Reading pending")).toBeInTheDocument();
    await user.type(within(dialog).getByRole("textbox", { name: "Review comment (required)" }), "Revise the baseline draft");
    await user.click(within(dialog).getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(onSubmitReview).toHaveBeenCalledTimes(1));
    expect(onSubmitReview.mock.calls[0]![0]).toMatchObject({ reviewedRevisionId: "rev-candidate" });
    expect(onSubmitReview.mock.calls[0]![0].annotations).toHaveLength(1);
    expect(onSubmitReview.mock.calls[0]![0].annotations[0]).toMatchObject({ anchorKind: "text", targetRevisionId: "rev-base", lineStart: 2, lineEnd: 2 });
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toEqual([]);
  });
});
