// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDagSceneRunner, type DagSceneRequest, type DagSceneResponse } from "./dag-scene-runner";
import { emptyDagScene } from "./dag-scene-layout";
import type { DagSceneInput, DagSceneKind } from "./dag-scene";

class FakeWorker {
  static instances: FakeWorker[] = [];
  listeners = new Map<string, (event: { data: DagSceneResponse; message?: string }) => void>();
  postMessage = vi.fn<(request: DagSceneRequest) => void>();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  addEventListener(type: string, listener: (event: { data: DagSceneResponse }) => void) { this.listeners.set(type, listener); }
  reply() { const request = this.postMessage.mock.calls.at(-1)![0]; this.listeners.get("message")?.({ data: { requestId: request.requestId, result: emptyDagScene(request.fallback ? "fallback" : "elk") } }); }
}
const input = (kind: DagSceneKind, id: string = kind): DagSceneInput => ({ kind, id, nodes: [], frames: [], edges: [] });
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal("Worker", FakeWorker); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("scene scheduling and content LRUs", () => {
  it("runs the three classes independently and only supersedes the same class", () => {
    const runner = createDagSceneRunner(), overview = vi.fn(), line = vi.fn(), focus = vi.fn(), newer = vi.fn();
    runner.execute(input("overview"), overview);
    runner.execute(input("line"), line);
    runner.execute(input("focus"), focus);
    runner.execute(input("line", "second"), newer);
    const [a, b, c, d] = FakeWorker.instances;
    expect(a!.terminate).not.toHaveBeenCalled(); expect(c!.terminate).not.toHaveBeenCalled();
    expect(b!.terminate).toHaveBeenCalledOnce();
    b!.reply(); a!.reply(); c!.reply(); d!.reply();
    expect(line).not.toHaveBeenCalled();
    expect(overview).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledOnce(); expect(newer).toHaveBeenCalledOnce();
    runner.dispose();
  });
  it("deduplicates in-flight content, uses LRU recency and caches each line independently", () => {
    const runner = createDagSceneRunner({ capacity: 2 }), old = vi.fn(), done = vi.fn();
    runner.execute(input("line", "a"), old);
    runner.execute(structuredClone(input("line", "a")), done);
    const worker = FakeWorker.instances[0]!;
    expect(worker.postMessage).toHaveBeenCalledOnce(); worker.reply();
    expect(old).not.toHaveBeenCalled(); expect(done).toHaveBeenCalledOnce();
    runner.execute(input("line", "b"), done); worker.reply();
    runner.execute(input("line", "a"), done);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    runner.execute(input("line", "c"), done); worker.reply();
    runner.execute(input("line", "b"), done);
    expect(worker.postMessage).toHaveBeenCalledTimes(4);
    runner.dispose();
  });
  it("kills over-budget ELK, computes fallback off-thread and ignores the late ELK result", () => {
    const runner = createDagSceneRunner(), done = vi.fn();
    runner.execute(input("overview"), done);
    const elk = FakeWorker.instances[0]!;
    vi.advanceTimersByTime(3000);
    expect(elk.terminate).toHaveBeenCalledOnce();
    const fallback = FakeWorker.instances[1]!;
    expect(fallback.postMessage.mock.calls[0]![0].fallback).toBe(true);
    elk.reply(); expect(done).not.toHaveBeenCalled(); fallback.reply();
    expect(done.mock.calls[0]![0].result.quality).toBe("fallback");
    expect(FakeWorker.instances).toHaveLength(4); // Line/focus are prewarmed.
    runner.execute(input("overview"), done);
    expect(FakeWorker.instances).toHaveLength(4);
    runner.execute(input("overview"), done, true);
    expect(fallback.postMessage.mock.calls.at(-1)![0].fallback).toBeUndefined();
    fallback.reply();
    expect(done.mock.calls.at(-1)![0].result.quality).toBe("elk");
    runner.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a class and clears cache/workers on scope disposal", () => {
    const runner = createDagSceneRunner(), done = vi.fn();
    runner.execute(input("line"), done); runner.cancel("line");
    vi.advanceTimersByTime(4000); FakeWorker.instances[0]!.reply();
    expect(done).not.toHaveBeenCalled(); expect(FakeWorker.instances).toHaveLength(1);
    runner.execute(input("line"), done); FakeWorker.instances[1]!.reply();
    runner.dispose(); runner.execute(input("line"), done);
    expect(FakeWorker.instances).toHaveLength(3);
    runner.dispose();
  });
});
