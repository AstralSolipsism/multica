import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import type { SupportedLocale } from "@multica/core/i18n";
import { RESOURCES } from "../../locales";
import {
  setApiInstance,
  type BaselineChapter,
  type BaselineAnnotationBatch,
  type BaselineAnnotationDetail,
  type BaselineRevision,
  type ChapterState,
  type EngineeringConfig,
  type IssueGraphNode,
} from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import type { Agent, Issue, TimelineEntry } from "@multica/core/types";
import { useBaselineAnnotationDraftStore } from "@multica/core/projects/baseline-annotation-draft-store";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider, type NavigationAdapter } from "../../navigation";
import { EngineeringOverview } from "./engineering-overview";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "11111111-1111-4111-8111-111111111111" }));
vi.mock("@multica/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: currentUserId } }),
}));
vi.mock("@multica/core/issues/dag/use-dag-data", () => ({
  useDagGraph: () => ({ data: { nodes: graphNodes }, isLoading: false, isError: false }),
}));
vi.mock("@multica/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: (type: string, id: string) => type === "agent" ? `Agent ${id}` : "Owner" }) }));
vi.mock("../../issues/utils/status-label", () => ({ useStatusLabel: () => (status: string) => status }));
vi.mock("../../rich-content", () => ({ RichContent: ({ content }: { content: string }) => <div data-testid="decision-rich-content">{content}</div> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const MEMBER = "66666666-6666-4666-8666-666666666666";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const RULES_CANDIDATE = "44444444-4444-4444-8444-444444444444";
const ARCHITECTURE_CANDIDATE = "55555555-5555-4555-8555-555555555555";
const EXCLUSIONS_CANDIDATE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HISTORICAL = "77777777-7777-4777-8777-777777777777";
const MISSING = "88888888-8888-4888-8888-888888888888";
const WEB_CANDIDATE = "99999999-9999-4999-8999-999999999999";

let currentUserId = OWNER;
let config: EngineeringConfig;
let chapters: ChapterState[];
let histories: Record<BaselineChapter, BaselineRevision[]>;
let graphNodes: IssueGraphNode[];
let agents: Agent[];
let annotationBatches: BaselineAnnotationBatch[];
let annotationDetails: BaselineAnnotationDetail[];
let decisionIssues: Issue[];
let timelineEntries: TimelineEntry[];
let decideProjectBaseline: ReturnType<typeof vi.fn>;
let proposeProjectBaseline: ReturnType<typeof vi.fn>;
let updateProjectEngineering: ReturnType<typeof vi.fn>;
let submitProjectBaselineReview: ReturnType<typeof vi.fn>;
let queryClient: QueryClient;

function revision(
  id: string,
  chapter: BaselineChapter,
  revisionNumber: number,
  changeSummary: string,
  status: BaselineRevision["status"] = "candidate",
  decidedAt: string | null = null,
  decisionCredential: BaselineRevision["decisionCredential"] = null,
): BaselineRevision {
  return {
    id,
    workspaceId: WS,
    projectId: PROJECT,
    chapter,
    revisionNumber,
    status,
    contentMarkdown: `### [Rule-1] ${changeSummary}\n所有写接口必须携带幂等键。`,
    changeSummary,
    baseRevisionId: null,
    replacesRevisionId: null,
    sourceIssueId: null,
    anchorsDiff: {
      chapter,
      baseRevisionNumber: Math.max(0, revisionNumber - 1),
      added: [{ anchor: "Rule-1", title: changeSummary, before: "", after: changeSummary, beforeChars: 0, afterChars: changeSummary.length }],
      modified: [],
      removed: [],
      unchangedCount: 0,
      warnings: [],
    },
    createdByType: "agent",
    createdById: "agent-1",
    createdByTaskId: null,
    createdAt: "2026-10-29T00:00:00Z",
    decidedByType: decidedAt ? "member" : null,
    decidedById: decidedAt ? OWNER : null,
    decidedByTaskId: null,
    decidedAt,
    decisionCredential,
  };
}

function node(id: string, stage: number | null, options: {
  title?: string;
  status?: string;
  category?: string;
  parentId?: string | null;
} = {}): IssueGraphNode {
  return {
    id,
    identifier: `OL-${id}`,
    title: options.title ?? `Task ${id}`,
    status: options.status ?? "todo",
    statusCategory: options.category ?? "unstarted",
    revision: 1,
    parentIssueId: options.parentId ?? null,
    hasRestrictedParent: false,
    projectId: PROJECT,
    stage,
    priority: "none",
    assignee: null,
    role: "match",
    runSummary: null,
    dependencySummary: null,
  } as IssueGraphNode;
}

function emptyHistory() {
  return { revisions: [], hasMore: false, nextBefore: null };
}

beforeEach(() => {
  currentUserId = OWNER;
  graphNodes = [];
  agents = [];
  annotationBatches = [];
  annotationDetails = [];
  decisionIssues = [];
  timelineEntries = [];
  config = {
    projectId: PROJECT,
    workspaceId: WS,
    enabled: true,
    currentStage: 1,
    modeSummary: "Ship the smallest end-to-end path first.",
    deciderMemberIds: [],
    stages: [{ stage: 1, title: "Foundation", goal: "Core contracts" }],
  };
  chapters = [
    { chapter: "overview", title: "", position: 0, adopted: null, candidate: null },
    { chapter: "domain_rules", title: "", position: 0, adopted: null, candidate: null },
    { chapter: "architecture", title: "", position: 0, adopted: null, candidate: null },
    { chapter: "exclusions_and_risks", title: "", position: 0, adopted: null, candidate: null },
  ];
  histories = { overview: [], domain_rules: [], architecture: [], exclusions_and_risks: [] };
  proposeProjectBaseline = vi.fn(async (_ws: string, _project: string, data: {
    chapter: BaselineChapter;
    contentMarkdown: string;
    changeSummary: string;
    baseRevisionId: string | null;
    replacesCandidateId?: string;
    chapterTitle?: string;
  }) => {
    const current = chapters.find((chapter) => chapter.chapter === data.chapter);
    const candidate = {
      ...revision(WEB_CANDIDATE, data.chapter, Math.max(current?.adopted?.revisionNumber ?? 0, current?.candidate?.revisionNumber ?? 0) + 1, data.changeSummary),
      contentMarkdown: data.contentMarkdown,
      baseRevisionId: data.baseRevisionId,
      replacesRevisionId: data.replacesCandidateId ?? null,
      createdByType: "member" as const,
      createdById: currentUserId,
    };
    if (current?.candidate) histories[data.chapter] = [{ ...current.candidate, status: "superseded" as const }, ...(histories[data.chapter] ?? [])];
    const nextState: ChapterState = {
      chapter: data.chapter,
      title: data.chapterTitle ?? current?.title ?? "",
      position: current?.position ?? chapters.filter((chapter) => chapter.chapter.startsWith("module:")).length + 1,
      adopted: current?.adopted ?? null,
      candidate,
    };
    chapters = current
      ? chapters.map((chapter) => chapter.chapter === data.chapter ? nextState : chapter)
      : [...chapters, nextState];
    return candidate;
  });
  decideProjectBaseline = vi.fn(async (_ws: string, _project: string, action: "adopt" | "reject", revisions: { revisionId: string }[]) => {
    const id = revisions[0]?.revisionId;
    const candidate = chapters.map((chapter) => chapter.candidate).find((item) => item?.id === id);
    if (!candidate) throw new Error("Missing candidate");
    const decided = {
      ...candidate,
      status: (action === "adopt" ? "adopted" : "rejected") as BaselineRevision["status"],
      decidedAt: "2026-10-31T00:00:00Z",
      decisionCredential: "session" as const,
    };
    chapters = chapters.map((chapter) => chapter.candidate?.id === id ? { ...chapter, adopted: action === "adopt" ? decided : chapter.adopted, candidate: null } : chapter);
    histories[candidate.chapter] = [decided, ...(histories[candidate.chapter] ?? [])];
    return { chapters: [], openIssues: { inFlight: [], queued: [], truncated: false } };
  });
  updateProjectEngineering = vi.fn(async (_ws: string, _project: string, data: Partial<EngineeringConfig>) => {
    config = { ...config, ...data };
    return { engineering: config };
  });
  submitProjectBaselineReview = vi.fn(async () => ({ batch: {}, review: {}, carrier: {}, woke: {} }));
  setApiInstance({
    getProject: async () => ({ id: PROJECT, title: "Project", lead_type: null, lead_id: null }),
    listMembers: async () => [
      { id: "member-owner", user_id: OWNER, role: "owner", name: "Owner" },
      { id: "member-regular", user_id: MEMBER, role: "member", name: "Member" },
    ],
    listAgents: async () => agents,
    getProjectEngineering: async () => ({ engineering: config, chapters }),
    getProjectBaselineHistory: async (_ws: string, _project: string, chapter: BaselineChapter, options: { limit?: number } = {}) => ({
      ...emptyHistory(),
      revisions: (histories[chapter] ?? []).slice(0, options.limit ?? 50),
    }),
    getProjectBaselineAnnotationBatches: async () => ({ batches: annotationBatches }),
    getProjectBaselineAnnotationBatch: async (_ws: string, _project: string, id: string) => annotationDetails.find((detail) => detail.batch.id === id) ?? null,
    listIssues: async () => ({ issues: decisionIssues, total: decisionIssues.length }),
    listTimeline: async () => timelineEntries,
    proposeProjectBaseline,
    decideProjectBaseline,
    updateProjectEngineering,
    submitProjectBaselineReview,
  } as unknown as ApiClient);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  HTMLElement.prototype.scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number) {
    if (options && typeof options === "object") this.scrollTop = options.top ?? 0;
  });
  Element.prototype.scrollIntoView = vi.fn();
  window.localStorage.clear();
  useBaselineAnnotationDraftStore.getState().clearDraft();
});

afterEach(() => {
  queryClient.clear();
});

function renderOverview(search = "", currentLocale?: SupportedLocale) {
  const adapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: `/acme/projects/${PROJECT}/engineering`,
    searchParams: new URLSearchParams(search),
    hash: "",
    openInNewTab: vi.fn(),
    getShareableUrl: (path: string) => path,
  } as unknown as NavigationAdapter;
  const ui = (
    <QueryClientProvider client={queryClient}>
      <NavigationProvider value={adapter}>
        <EngineeringOverview workspaceSlug="acme" projectId={PROJECT} />
      </NavigationProvider>
    </QueryClientProvider>
  );
  if (currentLocale) {
    return render(<I18nProvider locale={currentLocale} resources={{ [currentLocale]: RESOURCES[currentLocale] }}>{ui}</I18nProvider>);
  }
  return renderWithI18n(ui);
}

describe("EngineeringOverview waiting decisions", () => {
  it("expands the selected decision card in place while retaining the issue link", async () => {
    const user = userEvent.setup();
    decisionIssues = [{ id: "issue-decision", identifier: "OL-316", title: "Refund policy", status: "blocked" } as Issue];
    timelineEntries = [{
      id: "decision-card",
      type: "comment",
      actor_type: "agent",
      actor_id: "agent-1",
      created_at: "2026-11-01T00:00:00Z",
      content: "```html title=\"决策卡：退款方案\"\n只支持整单退款，影响 Stage 2。",
      parent_id: null,
    } as TimelineEntry];
    renderOverview();

    await user.click(await screen.findByRole("button", { name: /Refund policy/ }));
    expect(await screen.findByTestId("decision-rich-content")).toHaveTextContent("只支持整单退款，影响 Stage 2");
    expect(screen.getByRole("link", { name: "Open OL-316" })).toBeInTheDocument();
  });
});

describe("EngineeringOverview roadmap", () => {
  it("renders dynamic stages beyond five and every task without truncation", async () => {
    config.currentStage = 7;
    config.stages = [{ stage: 7, title: "Frontend", goal: "All views" }];
    graphNodes = Array.from({ length: 7 }, (_, index) => node(String(index + 1), 7));
    renderOverview();

    expect((await screen.findAllByText("Frontend")).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-stage-node="7"]')).toHaveAttribute("data-stage-status", "current");
    expect(document.querySelector('[data-stage-node="6"]')).not.toBeInTheDocument();
    for (let index = 1; index <= 7; index += 1) expect(screen.getByText(`Task ${index}`)).toBeInTheDocument();
  });

  it("filters closed-parent history and folds unstaged work outside the mainline", async () => {
    graphNodes = [
      node("parent", null, { status: "done", category: "done" }),
      node("historical", 1, { parentId: "parent", title: "Historical child" }),
      node("outside", null, { title: "Unstaged task" }),
      ...Array.from({ length: 6 }, (_, index) => node(`open-${index}`, 1)),
    ];
    renderOverview();

    expect(await screen.findByText("Task open-0")).toBeInTheDocument();
    expect(screen.queryByText("Historical child")).not.toBeInTheDocument();
    expect(screen.queryByText("Unstaged task")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /Outside the mainline/ }));
    expect(screen.getByText("Unstaged task")).toBeInTheDocument();
    expect(screen.getAllByText(/Task open-/).length).toBeGreaterThanOrEqual(6);
  });

  it("expands every completed task without truncation", async () => {
    const user = userEvent.setup();
    graphNodes = Array.from({ length: 7 }, (_, index) => node(`done-${index}`, 1, { status: "done", category: "done" }));
    renderOverview();

    await user.click(await screen.findByRole("button", { name: "Show 7 completed tasks" }));
    expect(document.querySelectorAll("[data-completed-tasks] > li")).toHaveLength(7);
    for (let index = 0; index < 7; index += 1) expect(screen.getByText(`Task done-${index}`)).toBeInTheDocument();
  });

  it("expands every unstaged task outside the mainline without truncation", async () => {
    const user = userEvent.setup();
    graphNodes = Array.from({ length: 7 }, (_, index) => node(`outside-${index}`, null));
    renderOverview();

    await user.click(await screen.findByRole("button", { name: /Outside the mainline/ }));
    expect(document.querySelectorAll("[data-outside-tasks] > li")).toHaveLength(7);
    for (let index = 0; index < 7; index += 1) expect(screen.getByText(`Task outside-${index}`)).toBeInTheDocument();
  });

  it("saves stage name and goal through the engineering mutation", async () => {
    const user = userEvent.setup();
    renderOverview();
    await user.click(await screen.findByRole("button", { name: "Edit name and goal" }));
    const name = screen.getByRole("textbox", { name: "Stage name" });
    await user.clear(name);
    await user.type(name, "Discovery");
    const goal = screen.getByRole("textbox", { name: "Stage goal" });
    await user.clear(goal);
    await user.type(goal, "Confirm scope");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(updateProjectEngineering).toHaveBeenCalledWith(WS, PROJECT, {
      stages: [{ stage: 1, title: "Discovery", goal: "Confirm scope" }],
    });
  });

  it("reorders only empty future stages through the same whole-table mutation", async () => {
    const user = userEvent.setup();
    config.stages = [
      { stage: 1, title: "Current", goal: "Contracts" },
      { stage: 2, title: "Delivery", goal: "Views" },
      { stage: 3, title: "Acceptance", goal: "Launch" },
    ];
    renderOverview();
    await screen.findByText("Delivery stages");
    await user.click(document.querySelector('[data-stage-node="2"]')!);
    await waitFor(() => expect(document.querySelector('[data-engineering-region="stage"]')).toHaveAttribute("data-stage", "2"));
    expect(screen.getByRole("button", { name: "Move stage later" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Move stage later" }));
    await waitFor(() => expect(updateProjectEngineering).toHaveBeenCalledWith(WS, PROJECT, {
      stages: [
        { stage: 1, title: "Current", goal: "Contracts" },
        { stage: 2, title: "Acceptance", goal: "Launch" },
        { stage: 3, title: "Delivery", goal: "Views" },
      ],
    }));
  });

  it("disables reordering when either side has tasks", async () => {
    const user = userEvent.setup();
    config.stages = [
      { stage: 1, title: "Current", goal: "Contracts" },
      { stage: 2, title: "Backend", goal: "Views" },
      { stage: 3, title: "Acceptance", goal: "Launch" },
    ];
    graphNodes = [node("order-api", 2, { title: "Order API" })];
    renderOverview();
    await screen.findByText("Delivery stages");
    await user.click(document.querySelector('[data-stage-node="2"]')!);

    expect(screen.getByRole("button", { name: "Move stage later" })).toBeDisabled();
    expect(screen.getByText("Only empty stages after the current stage can be reordered.")).toBeInTheDocument();
    expect(updateProjectEngineering).not.toHaveBeenCalled();
  });

  it("adds a stage beyond the current maximum", async () => {
    const user = userEvent.setup();
    config.currentStage = 6;
    config.stages = [{ stage: 6, title: "Six", goal: "" }];
    renderOverview();
    await user.click(await screen.findByRole("button", { name: "Add stage" }));
    await user.type(screen.getByRole("textbox", { name: "Stage name" }), "Seven");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateProjectEngineering).toHaveBeenCalledWith(WS, PROJECT, {
      stages: [{ stage: 6, title: "Six", goal: "" }, { stage: 7, title: "Seven", goal: "" }],
    });
  });

  it("does not announce completion for a configured empty current stage", async () => {
    config.currentStage = 3;
    config.stages = [
      { stage: 1, title: "Foundation", goal: "" },
      { stage: 2, title: "Backend", goal: "" },
      { stage: 3, title: "Launch", goal: "Not started" },
    ];
    graphNodes = [
      node("done-1", 1, { status: "done", category: "done" }),
      node("done-2", 2, { status: "done", category: "done" }),
    ];
    renderOverview();

    expect(await screen.findByText(/You are in Stage 3/)).toHaveTextContent("0/0");
    expect(screen.queryByText(/All delivery stages are complete/)).not.toBeInTheDocument();
    expect(document.querySelector('[data-stage-node="3"]')).toHaveAttribute("data-stage-status", "current");
  });

  it("shows the number of unfinished tasks left on a completed stage", async () => {
    config.currentStage = 2;
    config.stages = [{ stage: 1, title: "Backend", goal: "" }, { stage: 2, title: "Frontend", goal: "" }];
    graphNodes = [
      node("done", 1, { status: "done", category: "done" }),
      node("open", 1),
    ];
    renderOverview();

    expect(await screen.findByText("Delivery stages")).toBeInTheDocument();
    expect(document.querySelector('[data-stage-node="1"]')).toHaveTextContent("Leftover 1");
  });

  it("offers stage review when all current tasks are closed", async () => {
    const user = userEvent.setup();
    graphNodes = [node("done", 1, { status: "done", category: "done" })];
    renderOverview();
    await user.click((await screen.findAllByRole("button", { name: /Review Stage 1 and unlock the next stage/ }))[0]!);
    await user.click(screen.getByRole("button", { name: "Unlock Stage 2" }));
    expect(updateProjectEngineering).toHaveBeenCalledWith(WS, PROJECT, { currentStage: 2 });
  });
});

describe("EngineeringOverview skills and permissions", () => {
  it("shows active agent bindings", async () => {
    agents = [{ id: "agent-1", name: "Frontend", archived_at: null, skills: [{ id: "skill-1", name: "strixnova-deck", description: "", enabled: true }] } as Agent];
    renderOverview();
    expect(await screen.findByText("Strixnova engineering skill bindings")).toBeInTheDocument();
    expect(screen.getByText("Frontend")).toBeInTheDocument();
    expect(screen.getByText("strixnova-deck")).toBeInTheDocument();
  });

  it("keeps engineering enabled and editable without any skill bindings", async () => {
    renderOverview();
    expect(await screen.findByText(/No active agent is bound to Strixnova engineering skills/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enable engineering overview" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Add stage" })).toBeEnabled();
  });

  it("lets an admin enable the overview", async () => {
    const user = userEvent.setup();
    config.enabled = false;
    renderOverview();
    await user.click(await screen.findByRole("button", { name: "Enable overview" }));
    expect(updateProjectEngineering).toHaveBeenCalledWith(WS, PROJECT, { enabled: true });
  });

  it("does not show enable, stage editing, review, or settings controls to a regular member", async () => {
    currentUserId = MEMBER;
    graphNodes = [node("done", 1, { status: "done", category: "done" })];
    renderOverview();
    expect(await screen.findByText("Delivery stages")).toBeInTheDocument();
    expect(screen.queryByText("Engineering settings")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add stage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit name and goal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Review Stage 1/ })).not.toBeInTheDocument();
  });
});

describe("EngineeringOverview baseline navigation", () => {
  beforeEach(() => {
    chapters = chapters.map((chapter) => chapter.chapter === "domain_rules"
      ? { ...chapter, candidate: revision(RULES_CANDIDATE, "domain_rules", 2, "RULES-CANDIDATE") }
      : chapter.chapter === "architecture"
        ? { ...chapter, candidate: revision(ARCHITECTURE_CANDIDATE, "architecture", 1, "ARCH-CANDIDATE") }
        : chapter);
  });

  const openRulesCandidate = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByText("Domain and rules", { selector: "[data-candidate-todo] *" }));
  };

  it("opens the candidate from the waiting list in compare and management mode", async () => {
    const user = userEvent.setup();
    renderOverview();
    await openRulesCandidate(user);
    expect(await screen.findByText("RULES-CANDIDATE", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Project baseline" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Project management" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Compare v2" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/Agent agent-1/)).toBeInTheDocument();
    expect(screen.getByText("Pending 1/2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adopt" })).toHaveClass("bg-success");
    expect(screen.getByRole("button", { name: "Reject" })).toHaveClass("text-destructive");
    await user.click(screen.getByRole("button", { name: "Pending review queue" }));
    const queuePopover = document.querySelector<HTMLElement>("[data-slot='popover-content']")!;
    expect(within(queuePopover).getByRole("button", { name: /1.*Domain and rules/ })).toHaveTextContent("1 changes");
    expect(within(queuePopover).getByRole("button", { name: /2.*Architecture and decisions/ })).toHaveTextContent("1 changes");
    expect(within(queuePopover).getByText("Processed records (0) · Read-only view")).toBeInTheDocument();
  });

  it("places the perspective switch at the top nav right and remembers the choice", async () => {
    const user = userEvent.setup();
    renderOverview();
    const baselineTab = await screen.findByRole("tab", { name: "Project baseline" });
    expect(screen.queryByRole("tab", { name: "Project understanding" })).not.toBeInTheDocument();
    await user.click(baselineTab);

    const understand = await screen.findByRole("tab", { name: "Project understanding" });
    expect(understand.closest("nav")).toBe(baselineTab.closest("nav"));
    expect(understand.parentElement).toHaveClass("ml-auto");
    expect(document.querySelector('[data-engineering-region="baseline"] > header [aria-label="Perspective"]')).not.toBeInTheDocument();
    const manage = screen.getByRole("tab", { name: "Project management" });
    await user.click(manage);

    expect(manage).toHaveAttribute("aria-selected", "true");
    expect(window.localStorage.getItem(`multica.engineering-baseline.lens.${PROJECT}`)).toBe("manage");
    await user.click(screen.getByRole("tab", { name: "Overview" }));
    expect(screen.queryByRole("tab", { name: "Project understanding" })).not.toBeInTheDocument();
  });

  it("adopts successfully and immediately opens the next pending candidate", async () => {
    const user = userEvent.setup();
    renderOverview();
    await openRulesCandidate(user);
    await user.click(await screen.findByRole("button", { name: "Adopt" }));

    expect(await screen.findByText("ARCH-CANDIDATE", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText("RULES-CANDIDATE", { selector: "p" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-baseline-revision-status]")).toHaveAttribute("data-baseline-revision-status", "candidate");
    expect(document.querySelector("[data-review-notice]")).toHaveTextContent("1 pending");
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(document.querySelector("[data-engineering-shell]")).toHaveProperty("scrollTop", 0);
  });

  it("moves forward from B to C and wraps from C to A", async () => {
    const user = userEvent.setup();
    chapters = chapters.map((chapter) => chapter.chapter === "exclusions_and_risks"
      ? { ...chapter, candidate: revision(EXCLUSIONS_CANDIDATE, "exclusions_and_risks", 3, "EXCLUSIONS-CANDIDATE") }
      : chapter);
    renderOverview();
    await waitFor(() => expect(document.querySelector(`[data-candidate-todo="${ARCHITECTURE_CANDIDATE}"]`)).toBeInTheDocument());
    await user.click(document.querySelector(`[data-candidate-todo="${ARCHITECTURE_CANDIDATE}"]`)!);
    await user.click(await screen.findByRole("button", { name: "Adopt" }));
    expect(await screen.findByText("EXCLUSIONS-CANDIDATE", { selector: "p" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Adopt" }));
    expect(await screen.findByText("RULES-CANDIDATE", { selector: "p" })).toBeInTheDocument();
  });

  it("uses J/K to move between pending candidates and Escape to return to the overview", async () => {
    const user = userEvent.setup();
    renderOverview();
    await openRulesCandidate(user);
    fireEvent.keyDown(document, { key: "j" });
    expect(await screen.findByText("ARCH-CANDIDATE", { selector: "p" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "k" });
    expect(await screen.findByText("RULES-CANDIDATE", { selector: "p" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("button", { name: "Start continuous review (2)" })).toBeInTheDocument();
    expect(document.querySelector("[data-baseline-revision-status]")).not.toBeInTheDocument();
  });

  it("opens a candidate deep link without adopting on navigation", async () => {
    renderOverview(`candidate=${RULES_CANDIDATE}`);
    expect(await screen.findByText("RULES-CANDIDATE", { selector: "p" })).toBeInTheDocument();
    expect(decideProjectBaseline).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Adopt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Request changes" })).toBeEnabled();
  });

  it("does not substitute the current candidate when the requested revision is missing", async () => {
    renderOverview(`candidate=${MISSING}`);
    expect(await screen.findByText("The requested revision was not found")).toBeInTheDocument();
    expect(screen.queryByText("RULES-CANDIDATE", { selector: "p" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adopt" })).not.toBeInTheDocument();
  });

  it("keeps a historical deep-linked revision read-only", async () => {
    histories.domain_rules = [revision(HISTORICAL, "domain_rules", 1, "OLD-RULES", "withdrawn", "2026-10-29T01:00:00Z", "session")];
    renderOverview(`candidate=${HISTORICAL}`);
    expect(await screen.findByText("OLD-RULES", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText(/historical revision is read-only/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adopt" })).not.toBeInTheDocument();
  });

  it("returns to the overview after the last decision and opens read-only records with hierarchical Escape", async () => {
    const user = userEvent.setup();
    renderOverview();
    await openRulesCandidate(user);
    await user.click(await screen.findByRole("button", { name: "Adopt" }));
    await user.click(await screen.findByRole("button", { name: "Adopt" }));

    expect(await screen.findByText("This review batch is complete")).toBeInTheDocument();
    expect(document.querySelector("[data-review-complete]")).toHaveTextContent("2 adopted · 0 rejected · 0 requested changes");
    await user.click(screen.getByRole("button", { name: "View processed records" }));
    expect(await screen.findAllByRole("button", { name: /Revision v/ })).toHaveLength(2);
    await user.click(document.querySelector("[data-processed-record]")!);
    expect(await screen.findByText("This revision cannot be decided again")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Adopt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request changes" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("heading", { name: "Processed records" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(await screen.findByText("This review batch is complete")).toBeInTheDocument();
  });

  it("keeps a failed decision in place and retries with the original parameters", async () => {
    const user = userEvent.setup();
    decideProjectBaseline.mockRejectedValueOnce(new Error("Service returned 502"));
    renderOverview();
    await openRulesCandidate(user);
    await user.click(await screen.findByRole("button", { name: "Adopt" }));

    expect(await screen.findByText("Service returned 502")).toBeInTheDocument();
    expect(screen.getByText("RULES-CANDIDATE", { selector: "p" })).toBeInTheDocument();
    const firstInput = decideProjectBaseline.mock.calls[0]!.slice(2);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("ARCH-CANDIDATE", { selector: "p" })).toBeInTheDocument();
    expect(decideProjectBaseline.mock.calls[1]!.slice(2)).toEqual(firstInput);
  });

  it("requires a change-request comment and submits a synthesized section annotation before advancing", async () => {
    const user = userEvent.setup();
    const sourceCandidate = { ...revision(RULES_CANDIDATE, "domain_rules", 2, "RULES-CANDIDATE"), sourceIssueId: "issue-source" };
    chapters = chapters.map((chapter) => chapter.chapter === "domain_rules" ? { ...chapter, candidate: sourceCandidate } : chapter);
    renderOverview();
    await openRulesCandidate(user);
    expect(await screen.findByText("Pending 1/2")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Request changes" }));
    const dialog = screen.getByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Submit and continue to next" });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox", { name: "Review comment (required)" }), "Clarify rollback handling");
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await screen.findByText("ARCH-CANDIDATE", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("Pending 1/1")).toBeInTheDocument();
    const input = submitProjectBaselineReview.mock.calls[0]![2];
    expect(input).toMatchObject({ reviewedRevisionId: RULES_CANDIDATE, summary: "Clarify rollback handling" });
    expect(input.annotations).toEqual([{
      anchorKind: "section",
      targetRevisionId: RULES_CANDIDATE,
      sectionAnchor: "Rule-1",
      sectionTitle: "RULES-CANDIDATE",
      note: "Clarify rollback handling",
    }]);
  });

  it("keeps a persistently reviewed candidate out of pending and exposes its read-only record", async () => {
    const user = userEvent.setup();
    const batch = { id: "batch-review", chapter: "domain_rules", state: "active" } as BaselineAnnotationBatch;
    annotationBatches = [batch];
    annotationDetails = [{
      batch,
      reviews: [{
        id: "review-1",
        batchId: batch.id,
        clientKey: "client-1",
        reviewedRevisionId: RULES_CANDIDATE,
        summary: "Persisted review comment",
        wakeCommentId: null,
        createdById: OWNER,
        createdAt: "2026-11-01T00:00:00Z",
      }],
      annotations: [],
      sections: [],
    }];
    renderOverview();

    await waitFor(() => expect(document.querySelector(`[data-candidate-todo="${ARCHITECTURE_CANDIDATE}"]`)).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector(`[data-candidate-todo="${RULES_CANDIDATE}"]`)).not.toBeInTheDocument());
    await user.click((await screen.findAllByRole("button", { name: "Processed records (1)" }))[0]!);
    expect(await screen.findByText("Changes requested")).toBeInTheDocument();
    expect(screen.getByText("Persisted review comment")).toBeInTheDocument();
  });

  it("keeps the Wiki entry chapter and restores both scroll positions after cross-chapter review navigation", async () => {
    const user = userEvent.setup();
    const domainBase = revision("adopted-rules", "domain_rules", 1, "Rules", "adopted", "2026-10-29T00:00:00Z", "session");
    const architectureBase = revision("adopted-architecture", "architecture", 1, "Architecture", "adopted", "2026-10-29T00:00:00Z", "session");
    chapters = chapters.map((chapter) => chapter.chapter === "domain_rules" ? { ...chapter, adopted: domainBase } : chapter.chapter === "architecture" ? { ...chapter, adopted: architectureBase } : chapter);
    renderOverview();
    await user.click(await screen.findByRole("tab", { name: "Project baseline" }));
    expect(await screen.findByRole("button", { name: /Compare candidate/ })).toBeInTheDocument();
    const reader = document.querySelector<HTMLElement>("[data-baseline-reader]")!;
    const toc = document.querySelector<HTMLElement>("[data-baseline-toc]")!;
    reader.scrollTop = 120;
    toc.scrollTop = 36;

    await user.click(screen.getByRole("button", { name: /Compare candidate/ }));
    expect(await screen.findByRole("button", { name: "Back to chapter 02" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next pending candidate" }));
    expect(await screen.findByText("ARCH-CANDIDATE", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to chapter 02" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector('[data-baseline-chapter="domain_rules"]')).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Compare candidate/ })).toBeInTheDocument();
    expect(reader.scrollTop).toBe(120);
    expect(toc.scrollTop).toBe(36);
    expect(document.querySelector("[data-baseline-revision-status]")).not.toBeInTheDocument();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("EngineeringOverview baseline editing", () => {
  it("creates a dynamic module and shows its first candidate", async () => {
    const user = userEvent.setup();
    renderOverview();
    await user.click(await screen.findByRole("tab", { name: "Project baseline" }));
    await user.click(await screen.findByRole("button", { name: "Add module chapter" }));
    const dialog = screen.getByRole("dialog", { name: "Add module chapter" });
    await user.type(within(dialog).getByRole("textbox", { name: "Module name" }), "Billing");
    expect(within(dialog).getByRole("textbox", { name: "Chapter slug" })).toHaveValue("billing");
    await user.type(within(dialog).getByRole("textbox", { name: "Markdown content" }), "## Billing rules\nCharge once.");
    await user.type(within(dialog).getByRole("textbox", { name: "Change summary" }), "Create billing module");
    await user.click(within(dialog).getByRole("button", { name: "Submit for review" }));

    await waitFor(() => expect(proposeProjectBaseline).toHaveBeenCalledWith(WS, PROJECT, {
      chapter: "module:billing",
      chapterTitle: "Billing",
      contentMarkdown: "## Billing rules\nCharge once.",
      changeSummary: "Create billing module",
      baseRevisionId: null,
      replacesCandidateId: undefined,
    }));
    await waitFor(() => expect(document.querySelector('[data-baseline-chapter="module:billing"]')).toHaveTextContent("Charge once."));
    expect(document.querySelector('[data-baseline-chapter="module:billing"]')).toHaveTextContent("Billing");
    expect(decideProjectBaseline).not.toHaveBeenCalled();
  });

  it("initializes an empty chapter and chains the proposal into adoption for a decider", async () => {
    const user = userEvent.setup();
    renderOverview();
    await user.click(await screen.findByRole("tab", { name: "Project baseline" }));
    await user.click(await screen.findByRole("button", { name: "Initialize chapter" }));
    await user.type(screen.getByRole("textbox", { name: "Markdown content" }), "## Goal\nShip safely.");
    await user.type(screen.getByRole("textbox", { name: "Change summary" }), "Initialize overview");

    expect(screen.getByRole("button", { name: "Submit for review" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save and adopt" }));

    await waitFor(() => expect(proposeProjectBaseline).toHaveBeenCalledWith(WS, PROJECT, {
      chapter: "overview",
      contentMarkdown: "## Goal\nShip safely.",
      changeSummary: "Initialize overview",
      baseRevisionId: null,
      replacesCandidateId: undefined,
    }));
    await waitFor(() => expect(decideProjectBaseline).toHaveBeenCalledWith(WS, PROJECT, "adopt", [{
      revisionId: WEB_CANDIDATE,
      expectedAdoptedRevisionId: null,
    }]));
    expect(proposeProjectBaseline.mock.invocationCallOrder[0]).toBeLessThan(decideProjectBaseline.mock.invocationCallOrder[0]!);
    expect(document.querySelector("[data-baseline-editor]")).not.toBeInTheDocument();
  });

  it("lets a non-decider replace the pending candidate without exposing direct adoption", async () => {
    const user = userEvent.setup();
    currentUserId = MEMBER;
    const current = revision("adopted-overview", "overview", 1, "ADOPTED", "adopted", "2026-10-29T00:00:00Z", "session");
    const pending = revision("old-candidate", "overview", 2, "OLD-CANDIDATE");
    chapters = chapters.map((chapter) => chapter.chapter === "overview" ? { chapter: "overview", title: chapter.title, position: chapter.position, adopted: current, candidate: pending } : chapter);
    renderOverview();
    await user.click(await screen.findByRole("tab", { name: "Project baseline" }));
    await user.click(await screen.findByRole("button", { name: "Edit chapter" }));
    const markdown = screen.getByRole("textbox", { name: "Markdown content" });
    await user.clear(markdown);
    await user.type(markdown, "## Revised\nMember edit.");
    await user.type(screen.getByRole("textbox", { name: "Change summary" }), "Member revision");

    expect(screen.queryByRole("button", { name: "Save and adopt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for review" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit revision candidate" }));

    await waitFor(() => expect(proposeProjectBaseline).toHaveBeenCalledWith(WS, PROJECT, {
      chapter: "overview",
      contentMarkdown: "## Revised\nMember edit.",
      changeSummary: "Member revision",
      baseRevisionId: "adopted-overview",
      replacesCandidateId: "old-candidate",
    }));
    expect(decideProjectBaseline).not.toHaveBeenCalled();
    expect(await screen.findByText("Member revision", { selector: "p" })).toBeInTheDocument();
    expect(document.querySelector("[data-baseline-editor]")).not.toBeInTheDocument();
  });

  it("keeps an unsaved draft while browsing another chapter and returning", async () => {
    const user = userEvent.setup();
    renderOverview();
    await user.click(await screen.findByRole("tab", { name: "Project baseline" }));
    await user.click(await screen.findByRole("button", { name: "Initialize chapter" }));
    const markdown = screen.getByRole("textbox", { name: "Markdown content" });
    await user.type(markdown, "Unsaved draft");
    const toc = document.querySelector('aside[aria-label="Baseline contents"]') as HTMLElement;

    await user.click(within(toc).getByRole("button", { name: "Domain and rules" }));
    expect(screen.queryByRole("textbox", { name: "Markdown content" })).not.toBeInTheDocument();
    await user.click(within(toc).getByRole("button", { name: "Project overview" }));
    expect(screen.getByRole("textbox", { name: "Markdown content" })).toHaveValue("Unsaved draft");
  });

  it("does not report a missing revision when changing chapters after direct adoption", async () => {
    const user = userEvent.setup();
    renderOverview();
    await user.click(await screen.findByRole("tab", { name: "Project baseline" }));
    await user.click(await screen.findByRole("button", { name: "Initialize chapter" }));
    await user.type(screen.getByRole("textbox", { name: "Markdown content" }), "## Goal\nShip safely.");
    await user.type(screen.getByRole("textbox", { name: "Change summary" }), "Initialize overview");
    await user.click(screen.getByRole("button", { name: "Save and adopt" }));
    await waitFor(() => expect(decideProjectBaseline).toHaveBeenCalled());
    const toc = document.querySelector('aside[aria-label="Baseline contents"]') as HTMLElement;

    await user.click(within(toc).getByRole("button", { name: "Domain and rules" }));

    expect(screen.queryByText("The requested revision was not found")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Initialize chapter" })).toBeEnabled();
  });

  it("returns to the edited chapter and keeps its candidate comparison after cross-chapter browsing", async () => {
    const user = userEvent.setup();
    renderOverview();
    await user.click(await screen.findByRole("tab", { name: "Project baseline" }));
    await user.click(await screen.findByRole("button", { name: "Initialize chapter" }));
    await user.type(screen.getByRole("textbox", { name: "Markdown content" }), "## Goal\nCross chapter.");
    await user.type(screen.getByRole("textbox", { name: "Change summary" }), "Cross chapter revision");
    const toc = document.querySelector('aside[aria-label="Baseline contents"]') as HTMLElement;
    await user.click(within(toc).getByRole("button", { name: "Domain and rules" }));
    expect(screen.queryByRole("button", { name: "Initialize chapter" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for review" })).not.toBeInTheDocument();
    await user.click(within(toc).getByRole("button", { name: "Project overview" }));

    await user.click(screen.getByRole("button", { name: "Submit for review" }));

    expect(await screen.findByText("Cross chapter revision", { selector: "p" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Compare candidate/ }));
    expect(screen.getByRole("button", { name: "Adopt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(screen.queryByText(/historical revision is read-only/)).not.toBeInTheDocument();
  });

  it("keeps a replacement candidate actionable after submitting from a candidate deep link", async () => {
    const user = userEvent.setup();
    chapters = chapters.map((chapter) => chapter.chapter === "domain_rules"
      ? { ...chapter, candidate: revision(RULES_CANDIDATE, "domain_rules", 2, "RULES-CANDIDATE") }
      : chapter);
    renderOverview(`candidate=${RULES_CANDIDATE}`);
    await user.click(await screen.findByRole("button", { name: "Edit chapter" }));
    const markdown = screen.getByRole("textbox", { name: "Markdown content" });
    await user.clear(markdown);
    await user.type(markdown, "## Replacement\nNew candidate.");
    await user.type(screen.getByRole("textbox", { name: "Change summary" }), "Deep link revision");
    await user.click(screen.getByRole("button", { name: "Submit for review" }));

    expect(await screen.findByText("Deep link revision", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adopt" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(screen.queryByText(/historical revision is read-only/)).not.toBeInTheDocument();
    expect(decideProjectBaseline).not.toHaveBeenCalled();
  });

  it("submits only a candidate when a decider presses Enter in the summary", async () => {
    const user = userEvent.setup();
    renderOverview();
    await user.click(await screen.findByRole("tab", { name: "Project baseline" }));
    await user.click(await screen.findByRole("button", { name: "Initialize chapter" }));
    await user.type(screen.getByRole("textbox", { name: "Markdown content" }), "## Goal\nReview first.");
    await user.type(screen.getByRole("textbox", { name: "Change summary" }), "Enter submission{Enter}");

    await waitFor(() => expect(proposeProjectBaseline).toHaveBeenCalled());
    expect(decideProjectBaseline).not.toHaveBeenCalled();
  });

  it("preserves the draft when proposal fails", async () => {
    const user = userEvent.setup();
    proposeProjectBaseline.mockRejectedValueOnce(new Error("offline"));
    renderOverview();
    await user.click(await screen.findByRole("tab", { name: "Project baseline" }));
    await user.click(await screen.findByRole("button", { name: "Initialize chapter" }));
    await user.type(screen.getByRole("textbox", { name: "Markdown content" }), "Keep this draft");
    await user.type(screen.getByRole("textbox", { name: "Change summary" }), "Keep this summary");
    await user.click(screen.getByRole("button", { name: "Save and adopt" }));

    expect(await screen.findByText("The baseline revision was not saved")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Markdown content" })).toHaveValue("Keep this draft");
    expect(screen.getByRole("textbox", { name: "Change summary" })).toHaveValue("Keep this summary");
    expect(decideProjectBaseline).not.toHaveBeenCalled();
  });

  it("distinguishes a created candidate from a failed direct adoption", async () => {
    const user = userEvent.setup();
    decideProjectBaseline.mockRejectedValueOnce(new Error("baseline conflict"));
    renderOverview();
    await user.click(await screen.findByRole("tab", { name: "Project baseline" }));
    await user.click(await screen.findByRole("button", { name: "Initialize chapter" }));
    await user.type(screen.getByRole("textbox", { name: "Markdown content" }), "## Goal\nKeep candidate.");
    await user.type(screen.getByRole("textbox", { name: "Change summary" }), "Adoption conflict");
    await user.click(screen.getByRole("button", { name: "Save and adopt" }));

    expect(await screen.findByText("The candidate was not decided")).toBeInTheDocument();
    expect(screen.queryByText("The baseline revision was not saved")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save and adopt" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Markdown content" })).toHaveValue("## Goal\nKeep candidate.");
  });

  it("submits a baseline section annotation through one review mutation", async () => {
    const user = userEvent.setup();
    const current = {
      ...revision("adopted-rules", "domain_rules", 1, "Rules", "adopted", "2026-10-29T00:00:00Z", "session"),
      contentMarkdown: "## Rules\nFirst.\n\n## Other\nSecond.",
    };
    chapters = chapters.map((chapter) => chapter.chapter === "domain_rules"
      ? { ...chapter, adopted: current }
      : chapter.chapter === "architecture"
        ? { ...chapter, candidate: revision(ARCHITECTURE_CANDIDATE, "architecture", 1, "ARCH-CANDIDATE") }
        : chapter.chapter === "exclusions_and_risks"
          ? { ...chapter, candidate: revision(EXCLUSIONS_CANDIDATE, "exclusions_and_risks", 1, "EXCLUSIONS-CANDIDATE") }
          : chapter);
    agents = [{ id: "agent-1", name: "Backend", archived_at: null } as Agent];
    renderOverview();
    await user.click(await screen.findByRole("tab", { name: "Project baseline" }));
    const toc = document.querySelector('aside[aria-label="Baseline contents"]') as HTMLElement;
    await user.click(within(toc).getByRole("button", { name: "Domain and rules" }));
    const article = document.querySelector('[data-baseline-section-key="domain_rules:Rules"]') as HTMLElement;
    await user.click(screen.getByRole("tab", { name: "Annotations (0)" }));
    await user.click(within(article).getByRole("button", { name: "Annotate section" }));
    const rail = document.querySelector("[data-reading-rail]") as HTMLElement;
    await user.type(within(rail).getByRole("textbox", { name: "Write a change request" }), "Clarify the rule");
    await user.click(within(rail).getByRole("button", { name: "Add to review" }));
    expect(submitProjectBaselineReview).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Finish review" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("textbox", { name: "Overall note (optional)" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Request changes" })).toBeEnabled();
    await user.type(within(dialog).getByRole("textbox", { name: "Overall note (optional)" }), "Address the section annotation");
    await user.click(within(dialog).getByRole("button", { name: "Request changes" }));

    await waitFor(() => expect(submitProjectBaselineReview).toHaveBeenCalledTimes(1));
    const input = submitProjectBaselineReview.mock.calls[0]![2];
    expect(input).toMatchObject({
      chapter: "domain_rules",
      reviewedRevisionId: "adopted-rules",
      assignee: { type: "agent", id: "agent-1" },
      annotations: [{ anchorKind: "section", targetRevisionId: "adopted-rules", sectionAnchor: "Rules", note: "Clarify the rule" }],
    });
    expect(input.clientKey).toEqual(expect.any(String));
    expect(useBaselineAnnotationDraftStore.getState().draft.annotations).toEqual([]);
  });
});

describe("EngineeringOverview localization", () => {
  it("renders the dedicated zh-Hant bundle without raw keys", async () => {
    renderOverview("", "zh-Hant");
    expect(await screen.findByText("交付階段")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "總覽" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "專案基線" })).toBeInTheDocument();
    for (const key of ["stage.flowLabel", "views.overview", "views.baseline"]) expect(screen.queryByText(key)).not.toBeInTheDocument();
  });
});
