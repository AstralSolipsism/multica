import { IssueGraphSchema } from "../../api/issue-graph-schemas";
import { buildIssueGraphFixture, ISSUE_GRAPH_FIXTURE_VERSION } from "../testing/issue-graph-fixture";
import { createDagModelIndex } from "./model-index";
import { computeDagOverview } from "./overview";
import { computeDagLine, computeDagFocus } from "./detail";

function measure(run: () => unknown, samples = 30) {
  const times: number[] = [];
  const start = performance.now();
  run();
  const cold = performance.now() - start;
  for (let i = 0; i < 5; i++) run();
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { cold, p50: times[Math.floor(samples / 2)]!, p95: times[Math.ceil(samples * 0.95) - 1]!, max: times.at(-1)!, samples };
}

/** Runs synchronously on the browser main thread; no workers or layout. A raw
 * graph payload can be supplied from the OL-278 generator or an API fixture. */
export function benchmarkDagModels(payload5000: unknown = buildIssueGraphFixture("accept-5000"), payload10000: unknown = buildIssueGraphFixture("10000"), fixture = `OL-278 shared generator ${ISSUE_GRAPH_FIXTURE_VERSION}: accept-5000 / 10000`) {
  const json5000 = JSON.stringify(payload5000), json10000 = JSON.stringify(payload10000);
  const graph = IssueGraphSchema.parse(payload5000);
  if (graph.nodes.length !== 5000 || IssueGraphSchema.parse(payload10000).nodes.length !== 10000) throw new Error("Expected 5,000 and 10,000 task fixtures");
  const index = createDagModelIndex(graph);
  const largest = [...index.lineInputs.values()].sort((a, b) => b.members.length - a.members.length)[0]!;
  const focusId = graph.nodes[1]!.id;
  const focus = computeDagFocus(index, focusId);
  return {
    fixture,
    nodes: graph.nodes.length, edges: graph.edges.length,
    maxLineSize: largest.members.length, focusIssueId: focusId,
    focusVisible: focus.groups.reduce((sum, group) => sum + group.frames.length + group.tasks.length, 0),
    focusHidden: focus.hiddenIssueCount,
    index: measure(() => createDagModelIndex(graph)),
    overview: measure(() => computeDagOverview(createDagModelIndex(graph))),
    overviewAll: measure(() => computeDagOverview(createDagModelIndex(graph), { showCompleted: true, showSatisfiedDependencies: true })),
    line: measure(() => computeDagLine(index, largest.id)),
    focus: measure(() => computeDagFocus(index, focusId)),
    focusAll: measure(() => computeDagFocus(index, focusId, true)),
    parse5000: measure(() => IssueGraphSchema.parse(JSON.parse(json5000))),
    parse10000: measure(() => IssueGraphSchema.parse(JSON.parse(json10000))),
  };
}

export function inspectDagOverview(payload: unknown) {
  const graph = IssueGraphSchema.parse(payload);
  const index = createDagModelIndex(graph), overview = computeDagOverview(index);
  return {
    capturedAt: graph.capturedAt, nodes: graph.nodes.length, edges: graph.edges.length,
    hiddenCompleted: overview.hiddenCompleted,
    hiddenLines: [...index.visibility.hiddenRoots].map((id) => index.forest.byId.get(id)!.identifier).sort(),
    cards: overview.cards.map((card) => ({
      identifier: card.issue?.identifier ?? "independent", kind: card.kind,
      progress: card.progress, unfinished: card.unfinished, attention: card.attention,
      cancelledBlocking: card.cancelledBlocking,
    })),
    lines: overview.cards.filter((card) => card.kind === "line").map((card) => {
      const line = computeDagLine(index, card.issue!.id)!;
      return { identifier: card.issue!.identifier,
        dependencies: line.dependencies.length,
        redundant: line.dependencies.filter((edge) => edge.redundant).length,
        retained: line.dependencies.filter((edge) => edge.retained).length,
        hidden: line.dependencies.filter((edge) => edge.hiddenByDefault).length,
      };
    }),
  };
}
