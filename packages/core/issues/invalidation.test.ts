// @vitest-environment node
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ApiError, setApiInstance, type ApiClient } from "../api";
import { IssueGraphSchema, type IssueGraph } from "../api/issue-graph-schemas";
import reference from "../api/testdata/issue-graph.json";
import { issueGraphOptions } from "./graph";
import { invalidateIssueQueries } from "./invalidation";
import { issueKeys } from "./queries";
import { onIssueDeleted, onIssueUpdated } from "./ws-updaters";
import type { IssueTableQuerySpec } from "../types";

const query: IssueTableQuerySpec = { scope: { kind: "workspace" }, filters: {}, sort: { field: "position", direction: "asc" } };
const before = IssueGraphSchema.parse(reference);
const after: IssueGraph = {
  ...before,
  snapshotId: "after-committed-change",
  nodes: before.nodes.map((n) => ({ ...n, revision: n.revision + 1 })),
};

function deferredGraphApi() {
  const requests: { wsId: string; signal: AbortSignal; resolve: (g: IssueGraph) => void; reject: (e: Error) => void }[] = [];
  const getIssueGraph = vi.fn((wsId: string, _request: unknown, { signal }: { signal: AbortSignal }) =>
    // Deliberately ignore abort: even a late transport response must not win.
    new Promise<IssueGraph>((resolve, reject) => requests.push({ wsId, signal, resolve, reject })),
  );
  setApiInstance({ getIssueGraph } as unknown as ApiClient);
  return { requests, getIssueGraph };
}

describe("graph invalidation during reads", () => {
  it.each(["issue update", "issue deletion", "workspace invalidation"])("refreshes the first snapshot after %s", async (change) => {
    const { requests, getIssueGraph } = deferredGraphApi();
    const qc = new QueryClient();
    const options = issueGraphOptions("ws", query);
    const observer = new QueryObserver(qc, options);
    const observed: string[] = [];
    const unsubscribe = observer.subscribe((result) => { if (result.data) observed.push(result.data.snapshotId); });
    try {
      expect(getIssueGraph).toHaveBeenCalledTimes(1);
      if (change === "issue update") onIssueUpdated(qc, "ws", { id: before.nodes[0]!.id, revision: before.nodes[0]!.revision + 1 });
      else if (change === "issue deletion") onIssueDeleted(qc, "ws", before.nodes[0]!.id);
      else void invalidateIssueQueries(qc, "ws");
      requests[0]!.resolve(before);
      await vi.waitFor(() => expect(getIssueGraph).toHaveBeenCalledTimes(2));
      expect(requests[0]!.signal.aborted).toBe(true);
      requests[1]!.resolve(after);
      await vi.waitFor(() => expect(observer.getCurrentResult().data?.snapshotId).toBe(after.snapshotId));
      expect(observed).not.toContain(before.snapshotId);
      expect(observer.getCurrentResult().data?.nodes[0]?.revision).toBe(after.nodes[0]!.revision);
      expect(observer.getCurrentResult().isStale).toBe(false);
    } finally {
      unsubscribe();
      qc.clear();
    }
  });

  it("supersedes a replacement when another event arrives before it finishes", async () => {
    const { requests, getIssueGraph } = deferredGraphApi();
    const qc = new QueryClient();
    const observer = new QueryObserver(qc, issueGraphOptions("ws", query));
    const unsubscribe = observer.subscribe(() => {});
    try {
      void invalidateIssueQueries(qc, "ws", "graph");
      await vi.waitFor(() => expect(getIssueGraph).toHaveBeenCalledTimes(2));
      void invalidateIssueQueries(qc, "ws", "graph");
      await vi.waitFor(() => expect(getIssueGraph).toHaveBeenCalledTimes(3));
      expect(requests.slice(0, 2).every((request) => request.signal.aborted)).toBe(true);
      requests[2]!.resolve({ ...after, snapshotId: "latest" });
      await vi.waitFor(() => expect(observer.getCurrentResult().data?.snapshotId).toBe("latest"));
      requests[1]!.resolve(after);
      requests[0]!.resolve(before);
      await Promise.resolve();
      expect(observer.getCurrentResult().data?.snapshotId).toBe("latest");
    } finally {
      unsubscribe();
      qc.clear();
    }
  });

  it("retains cached data while replacing a background read and keeps failed refreshes stale", async () => {
    const { requests, getIssueGraph } = deferredGraphApi();
    const qc = new QueryClient();
    const options = { ...issueGraphOptions("ws", query), retry: false };
    qc.setQueryData(options.queryKey, before);
    const observer = new QueryObserver(qc, options);
    const unsubscribe = observer.subscribe(() => {});
    try {
      void invalidateIssueQueries(qc, "ws", "graph");
      expect(getIssueGraph).toHaveBeenCalledTimes(1);
      void invalidateIssueQueries(qc, "ws", "graph");
      await vi.waitFor(() => expect(getIssueGraph).toHaveBeenCalledTimes(2));
      expect(qc.getQueryData(options.queryKey)).toBe(before);
      expect(requests[0]!.signal.aborted).toBe(true);
      requests[1]!.reject(new ApiError("refresh failed", 500, "Internal Server Error"));
      requests[0]!.resolve(after);
      await vi.waitFor(() => expect(observer.getCurrentResult().status).toBe("error"));
      expect(observer.getCurrentResult().data?.snapshotId).toBe(before.snapshotId);
      expect(observer.getCurrentResult().isStale).toBe(true);
    } finally {
      unsubscribe();
      qc.clear();
    }
  });

  it("keeps a failed first replacement unavailable instead of accepting the cancelled snapshot", async () => {
    const { requests, getIssueGraph } = deferredGraphApi();
    const qc = new QueryClient();
    const observer = new QueryObserver(qc, { ...issueGraphOptions("ws", query), retry: false });
    const unsubscribe = observer.subscribe(() => {});
    try {
      void invalidateIssueQueries(qc, "ws", "graph");
      await vi.waitFor(() => expect(getIssueGraph).toHaveBeenCalledTimes(2));
      requests[0]!.resolve(before);
      requests[1]!.reject(new ApiError("access lost", 403, "Forbidden"));
      await vi.waitFor(() => expect(observer.getCurrentResult().status).toBe("error"));
      expect(observer.getCurrentResult().data).toBeUndefined();
      expect(observer.getCurrentResult().isStale).toBe(true);
    } finally {
      unsubscribe();
      qc.clear();
    }
  });

  it("does not restart the old workspace after switching during cancellation", async () => {
    const { requests, getIssueGraph } = deferredGraphApi();
    const qc = new QueryClient();
    const observer = new QueryObserver(qc, issueGraphOptions("old", query));
    const unsubscribe = observer.subscribe(() => {});
    try {
      const refresh = invalidateIssueQueries(qc, "old", "graph");
      observer.setOptions(issueGraphOptions("new", query));
      await refresh;
      expect(getIssueGraph).toHaveBeenCalledTimes(2);
      expect(requests.map((request) => request.wsId)).toEqual(["old", "new"]);
      expect(requests[0]!.signal.aborted).toBe(true);
      expect(requests[1]!.signal.aborted).toBe(false);
      requests[0]!.resolve(before);
      expect(observer.getCurrentResult().data).toBeUndefined();
      requests[1]!.resolve(after);
      await vi.waitFor(() => expect(observer.getCurrentResult().data?.snapshotId).toBe(after.snapshotId));
    } finally {
      unsubscribe();
      qc.clear();
    }
  });

  it("leaves other workspaces and ordinary first issue reads running", async () => {
    const { requests, getIssueGraph } = deferredGraphApi();
    const qc = new QueryClient();
    let listSignal!: AbortSignal;
    let resolveList!: (value: string[]) => void;
    const list = qc.prefetchQuery({
      queryKey: issueKeys.list("ws"),
      queryFn: ({ signal }) => {
        listSignal = signal;
        return new Promise<string[]>((resolve) => { resolveList = resolve; });
      },
    });
    const first = new QueryObserver(qc, issueGraphOptions("ws", query));
    const other = new QueryObserver(qc, issueGraphOptions("other", query));
    const unsubFirst = first.subscribe(() => {});
    const unsubOther = other.subscribe(() => {});
    try {
      const refreshed = invalidateIssueQueries(qc, "ws");
      await vi.waitFor(() => expect(getIssueGraph).toHaveBeenCalledTimes(3));
      expect(requests.map((request) => request.wsId)).toEqual(["ws", "other", "ws"]);
      expect(requests[0]!.signal.aborted).toBe(true);
      expect(requests[1]!.signal.aborted).toBe(false);
      expect(listSignal.aborted).toBe(false);
      requests[0]!.resolve(before);
      requests[1]!.resolve(before);
      requests[2]!.resolve(after);
      resolveList(["ordinary issue"]);
      await Promise.all([refreshed, list]);
      expect(first.getCurrentResult().data?.snapshotId).toBe(after.snapshotId);
      expect(other.getCurrentResult().data?.snapshotId).toBe(before.snapshotId);
    } finally {
      unsubFirst();
      unsubOther();
      qc.clear();
    }
  });

  it("cancels inactive prefetches and reads a fresh snapshot on the next mount", async () => {
    const { requests, getIssueGraph } = deferredGraphApi();
    const qc = new QueryClient();
    const options = issueGraphOptions("ws", query);
    const prefetched = qc.prefetchQuery(options);
    await invalidateIssueQueries(qc, "ws", "graph");
    await prefetched;
    expect(getIssueGraph).toHaveBeenCalledTimes(1);
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(qc.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
    const observer = new QueryObserver(qc, options);
    const unsubscribe = observer.subscribe(() => {});
    try {
      expect(getIssueGraph).toHaveBeenCalledTimes(2);
      requests[0]!.resolve(before);
      requests[1]!.resolve(after);
      await vi.waitFor(() => expect(observer.getCurrentResult().data?.snapshotId).toBe(after.snapshotId));
    } finally {
      unsubscribe();
      qc.clear();
    }
  });
});
