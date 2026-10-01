// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerRunner, useDagLayout, type DagLayoutRunner } from "./use-dag-layout";
import type { DagLayoutRequest, DagLayoutResponse } from "./dag-layout";

class TestWorker {
  static instances: TestWorker[] = [];
  listeners = new Map<string, (event: any) => void>();
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { TestWorker.instances.push(this); }
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, listener); }
  reply(requestId: number) { this.listeners.get("message")?.({ data: { requestId } }); }
  fail(message: string) { this.listeners.get("error")?.({ message }); }
}
const request = (requestId: number): DagLayoutRequest => ({
  requestId, nodes: [{ id: "a", width: 248, height: 116 }], edges: [], groups: [], direction: "LR",
});
beforeEach(() => { TestWorker.instances = []; vi.stubGlobal("Worker", TestWorker); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("prepared DAG workers", () => {
  it("loads one worker before data and reuses it for completed layouts", () => {
    const runner = createWorkerRunner(), done = vi.fn();
    runner.prepare();
    expect(TestWorker.instances).toHaveLength(1);
    const worker = TestWorker.instances[0]!;
    expect(worker.postMessage).not.toHaveBeenCalled();
    runner.execute(request(1), done);
    worker.reply(1);
    runner.execute(request(2), done);
    worker.reply(2);
    expect(TestWorker.instances).toHaveLength(1);
    expect(done).toHaveBeenCalledTimes(2);
    runner.terminate();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("reports a warmup failure to the first request and can retry on a fresh worker", () => {
    const runner = createWorkerRunner(), done = vi.fn();
    runner.prepare();
    TestWorker.instances[0]!.fail("load failed");
    runner.execute(request(1), done);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ requestId: 1, error: "load failed" }));
    runner.terminate();
    runner.execute(request(2), done);
    TestWorker.instances[1]!.reply(2);
    expect(done).toHaveBeenLastCalledWith({ requestId: 2 });
  });
  it("ignores late messages and errors from a superseded worker", () => {
    const runner = createWorkerRunner(), oldDone = vi.fn(), nextDone = vi.fn();
    runner.execute(request(1), oldDone);
    const old = TestWorker.instances[0]!;
    runner.execute(request(2), nextDone);
    old.reply(1);
    old.fail("obsolete");
    TestWorker.instances[1]!.reply(2);
    expect(old.terminate).toHaveBeenCalledOnce();
    expect(oldDone).not.toHaveBeenCalled();
    expect(nextDone).toHaveBeenCalledWith({ requestId: 2 });
  });
  it("keeps the prepared worker while the graph is pending and terminates it when membership empties", () => {
    const runner: DagLayoutRunner = { prepare: vi.fn(), execute: vi.fn(), terminate: vi.fn() };
    const empty: DagLayoutRequest["nodes"] = [], nodes = request(1).nodes;
    const edges: DagLayoutRequest["edges"] = [], groups: DagLayoutRequest["groups"] = [];
    const factory = () => runner;
    const view = renderHook(({ items }) => useDagLayout(items, edges, groups, "LR", factory), { initialProps: { items: empty } });
    expect(runner.prepare).toHaveBeenCalledOnce();
    expect(runner.terminate).not.toHaveBeenCalled();
    view.rerender({ items: nodes });
    expect(runner.execute).toHaveBeenCalledOnce();
    const callback = vi.mocked(runner.execute).mock.calls[0]![1];
    view.rerender({ items: empty });
    expect(runner.terminate).toHaveBeenCalledOnce();
    act(() => callback({ requestId: 0, positions: {}, groups: {}, routes: {}, ports: {}, elapsedMs: 1 } as DagLayoutResponse));
    expect(view.result.current.positions).toBeNull();
  });
});
