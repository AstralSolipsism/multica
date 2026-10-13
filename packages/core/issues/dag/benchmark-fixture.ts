/** Temporary deterministic OL-279 fixture until OL-278's shared generator lands.
 * Six projects, 36 tasks/line, four hierarchy levels, stages 1-6,
 * one/two local predecessors and an extra cross-line predecessor on ~20%. */
export function dagBenchmarkFixture(size: number, unfinished = 800) {
  const capturedAt = "2026-10-12T00:00:00.000Z";
  const nodes = [];
  const edges: { source_edge_id: string; source: string; target: string; type: "blocked_by" }[] = [];
  const edge = (source: number, target: number) => edges.push({ source_edge_id: `${source}-${target}`, source: `n${source}`, target: `n${target}`, type: "blocked_by" });
  for (let i = 0; i < size; i++) {
    const offset = i % 36, root = i - offset;
    const parent = offset === 0 ? null : offset === 1 ? root : offset === 2 ? root + 1 : offset < 8 ? root + 2 : root;
    const active = i >= size - unfinished;
    const status = !active ? "done" : i % 31 === 0 ? "cancelled" : i % 13 === 0 ? "blocked" : i % 7 === 0 ? "in_review" : i % 3 === 0 ? "in_progress" : "todo";
    nodes.push({
      id: `n${i}`, identifier: `PERF-${i + 1}`, title: `Production task ${i + 1}: deterministic DAG model benchmark`,
      status, status_category: status === "done" ? "done" : status === "cancelled" ? "closed" : status === "todo" ? "unstarted" : "started",
      revision: 1, parent_issue_id: parent === null ? null : `n${parent}`, has_restricted_parent: false,
      project_id: `p${Math.min(5, Math.floor(i / (size / 6)))}`, stage: offset % 6 + 1, priority: ["none", "low", "medium", "high", "urgent"][i % 5],
      assignee: null, role: "match", run_summary: { queued: 0, dispatched: 0, running: status === "in_progress" ? 1 : 0, waiting_local_directory: 0, captured_at: capturedAt },
      dependency_summary: { visible_unsatisfied_count: 0, has_restricted_blockers: false, dependency_version: `v${i}` },
    });
    if (offset > 0) edge(i - 1, i);
    if (offset > 2 && offset % 2 === 0) edge(i - 2, i);
    if (root > 0 && offset % 5 === 0) edge(root - 1, i);
  }
  for (const dependency of edges) {
    const source = Number(dependency.source.slice(1)), target = Number(dependency.target.slice(1));
    if (nodes[source]!.status_category !== "done") nodes[target]!.dependency_summary.visible_unsatisfied_count++;
  }
  return {
    schema_version: 1, snapshot_id: `benchmark-${size}`, topology_id: `benchmark-${size}`, captured_at: capturedAt,
    complete: true, scope: { type: "workspace", project_id: null }, focus_issue_id: null,
    matched_count: size, context_count: 0, nodes, edges,
    projects: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, title: ["Tools", "Art", "Server", "Audio", "Client", "Levels"][i] })),
    has_restricted_context: false,
  };
}
