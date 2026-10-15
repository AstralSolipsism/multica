import { replaceEqualDeep } from "@tanstack/react-query";
import { normalizeIssueStatusCategory } from "../config/status";
import { PRIORITY_ORDER } from "../config/priority";
import { DAG_INDEPENDENT_GROUP, dagFeatureRepId } from "./projection";
import { aggregateDagDependencyState, dagHasActiveRun, dagIssueFinished, type DagDependencyState } from "./state";
import type { DagDependency, DagIssue, DagModelIndex } from "./model-index";

export type DagAttentionTier = "exception" | "advancing" | "review" | "unstarted" | "finished";
const tiers: DagAttentionTier[] = ["exception", "advancing", "review", "unstarted", "finished"];
const identifiers = new Intl.Collator(undefined, { numeric: true });

export function summarizeDagMembers(members: readonly DagIssue[], cancelledBlockedIds: ReadonlySet<string>) {
  const unfinished = { blocked: 0, review: 0, inProgress: 0, unstarted: 0 };
  let unknownStatusCount = 0;
  for (const member of members) {
    if (dagIssueFinished(member)) continue;
    if (member.status === "blocked") unfinished.blocked++;
    else if (member.status === "in_review") unfinished.review++;
    else if (normalizeIssueStatusCategory(member.statusCategory) === "started") unfinished.inProgress++;
    else if (normalizeIssueStatusCategory(member.statusCategory) === "unstarted") unfinished.unstarted++;
    else unknownStatusCount++;
  }
  const hasActiveRun = members.some(dagHasActiveRun);
  const matchCount = members.filter((m) => m.role === "match").length;
  const attention: DagAttentionTier = unfinished.blocked || members.some((m) => cancelledBlockedIds.has(m.id))
    ? "exception" : unfinished.inProgress || hasActiveRun ? "advancing" : unfinished.review
      ? "review" : unfinished.unstarted || unknownStatusCount ? "unstarted" : "finished";
  return {
    unfinished, unknownStatusCount, hasActiveRun, attention,
    matchCount, contextCount: members.length - matchCount,
    role: matchCount ? "match" as const : "context" as const,
    hasRestrictedParent: members.some((m) => m.hasRestrictedParent),
    hasRestrictedBlockers: members.some((m) => m.dependencySummary?.hasRestrictedBlockers),
    unknownDependencyCount: members.filter((m) => !m.dependencySummary).length,
    unknownRunCount: members.filter((m) => !m.runSummary).length,
  };
}

export interface DagOverviewCard extends ReturnType<typeof summarizeDagMembers> {
  id: string;
  kind: "line" | "issue" | "independent";
  issue: DagIssue | null;
  project: DagModelIndex["graph"]["projects"][number] | null;
  memberIds: string[];
  progress: { completed: number; total: number };
  cancelledBlocking: boolean;
}

export interface DagAggregateDependency {
  id: string;
  source: string;
  target: string;
  sourceEdgeIds: string[];
  count: number;
  state: DagDependencyState;
  dependencies: DagDependency[];
}

export interface DagOverviewModel {
  /** Order is a layout preference; minimizing crossings takes precedence. */
  cards: DagOverviewCard[];
  dependencies: DagAggregateDependency[];
  /** Satisfied raw edges, also when bundled with unsatisfied edges. */
  satisfiedByCard: ReadonlyMap<string, readonly DagAggregateDependency[]>;
  representatives: ReadonlyMap<string, string>;
  hiddenCompleted: { lines: number; lineTasks: number; singles: number };
  hiddenLineIds: readonly string[];
  autoEnterLineId: string | null;
  hasRestrictedContext: boolean;
}

function compareCards(a: DagOverviewCard, b: DagOverviewCard): number {
  const priority = (card: DagOverviewCard) => {
    const rank = PRIORITY_ORDER.indexOf(card.issue?.priority as typeof PRIORITY_ORDER[number]);
    return rank < 0 ? PRIORITY_ORDER.length : rank;
  };
  return tiers.indexOf(a.attention) - tiers.indexOf(b.attention) || priority(a) - priority(b) ||
    identifiers.compare(b.issue?.identifier ?? "", a.issue?.identifier ?? "") || a.id.localeCompare(b.id);
}

export function computeDagOverview(
  index: DagModelIndex,
  options: { showCompleted?: boolean; showSatisfiedDependencies?: boolean } = {},
  previous?: DagOverviewModel,
): DagOverviewModel {
  const oldCards = new Map(previous?.cards.map((card) => [card.id, card]));
  const cards: DagOverviewCard[] = [];
  const representatives = new Map<string, string>();
  const hiddenCompleted = { lines: 0, lineTasks: 0, singles: 0 };
  const independent: string[] = [];
  function pushCard(id: string, kind: DagOverviewCard["kind"], memberIds: string[], issue: DagIssue | null, cancelledBlocking = false) {
    const members = memberIds.map((memberId) => index.issues.get(memberId)!);
    const progressMembers = kind === "line" ? members.filter((m) => m.id !== issue!.id) : members;
    const card: DagOverviewCard = {
      id, kind, issue, project: index.projects.get(issue?.projectId ?? "") ?? null, memberIds,
      progress: {
        completed: progressMembers.filter((m) => normalizeIssueStatusCategory(m.statusCategory) === "done").length,
        total: progressMembers.length,
      },
      ...summarizeDagMembers(members, index.cancelledBlockedIds), cancelledBlocking,
    };
    if (cancelledBlocking) card.role = "context";
    for (const memberId of memberIds) representatives.set(memberId, id);
    cards.push(replaceEqualDeep(oldCards.get(id), card));
  }
  for (const [id, input] of index.lineInputs) {
    const issue = index.issues.get(id)!;
    if (!options.showCompleted && index.visibility.hiddenRoots.has(id)) {
      hiddenCompleted.lines++;
      for (const member of input.members) {
        if (index.visibility.keptCancelled.has(member.issue.id)) pushCard(member.issue.id, "issue", [member.issue.id], member.issue, true);
        else hiddenCompleted.lineTasks++;
      }
    } else if (!options.showCompleted && index.visibility.hiddenSingles.has(id)) {
      if (index.visibility.keptCancelled.has(id)) pushCard(id, "issue", [id], issue, true);
      else hiddenCompleted.singles++;
    } else if (index.independentIds.has(id)) independent.push(id);
    else if (index.forest.children.has(id)) pushCard(dagFeatureRepId(id), "line", input.members.map((m) => m.issue.id), issue);
    else pushCard(id, "issue", [id], issue);
  }
  if (independent.length) pushCard(DAG_INDEPENDENT_GROUP, "independent", independent, null);
  cards.sort(compareCards);
  const visibleIds = new Set(cards.map((card) => card.id));
  function aggregate(onlySatisfied: boolean): DagAggregateDependency[] {
    const groups = new Map<string, DagAggregateDependency>();
    for (const edge of index.dependencies) {
      if (onlySatisfied && edge.state !== "satisfied") continue;
      const source = representatives.get(edge.source), target = representatives.get(edge.target);
      if (!source || !target || source === target || !visibleIds.has(source) || !visibleIds.has(target)) continue;
      const id = JSON.stringify([source, target]);
      let group = groups.get(id);
      if (!group) {
        group = { id, source, target, sourceEdgeIds: [], count: 0, state: "satisfied", dependencies: [] };
        groups.set(id, group);
      }
      group.sourceEdgeIds.push(edge.id);
      group.dependencies.push(edge);
      group.count++;
      group.state = aggregateDagDependencyState([group.state, edge.state]);
    }
    return [...groups.values()];
  }
  const satisfiedByCard = new Map<string, DagAggregateDependency[]>(cards.map((c) => [c.id, []]));
  for (const edge of aggregate(true)) {
    satisfiedByCard.get(edge.source)!.push(edge);
    satisfiedByCard.get(edge.target)!.push(edge);
  }
  return {
    cards,
    dependencies: aggregate(false).filter((edge) => options.showSatisfiedDependencies || edge.state !== "satisfied"),
    satisfiedByCard, representatives,
    hiddenCompleted, hiddenLineIds: options.showCompleted ? [] : index.visibility.hiddenLineIds,
    autoEnterLineId: cards.length === 1 && cards[0]!.kind === "line" ? cards[0]!.issue!.id : null,
    hasRestrictedContext: index.graph.hasRestrictedContext,
  };
}
