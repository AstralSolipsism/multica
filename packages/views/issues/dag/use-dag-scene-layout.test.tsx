import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDagSceneLayout } from "./use-dag-scene-layout";
import { emptyDagScene } from "./dag-scene-layout";
import type { DagScenePlan } from "./dag-scene";
import type { DagSceneRunner } from "./dag-scene-runner";

afterEach(cleanup);
const plan = (id: string): DagScenePlan => ({ input: { kind: "line", id, nodes: [], frames: [], edges: [] }, dependencyIds: {}, overlays: [], overlayDependencyIds: {} });
function fixture() {
  const runner: DagSceneRunner = { prepare: vi.fn(), execute: vi.fn(), cancel: vi.fn(), dispose: vi.fn() };
  return { runner, factory: () => runner, finish: (index: number) => vi.mocked(runner.execute).mock.calls[index]![1]({ requestId: index, result: emptyDagScene() }) };
}
describe("scene hook", () => {
  it("paints fresh content without layout and keeps the previous scene while the next computes", () => {
    const f = fixture();
    const view = renderHook(({ input, title }) => useDagSceneLayout("workspace:query", input, title, f.factory), { initialProps: { input: plan("a"), title: "Old" } });
    act(() => f.finish(0));
    view.rerender({ input: structuredClone(plan("a")), title: "New" });
    expect(f.runner.execute).toHaveBeenCalledOnce();
    expect(view.result.current.snapshot).toBe("New");
    view.rerender({ input: plan("b"), title: "Second" });
    expect(view.result.current.pending).toBe(true);
    expect(view.result.current.geometry).not.toBeNull();
    expect(view.result.current.plan!.input.id).toBe("a");
    expect(view.result.current.snapshot).toBe("New");
    act(() => f.finish(1));
    expect(view.result.current.snapshot).toBe("Second");
    expect(view.result.current.pending).toBe(false);
  });
  it("isolates workspace/query scope and ignores cancelled or late replies", () => {
    const f = fixture(), a = plan("a");
    const view = renderHook(({ scope }) => useDagSceneLayout(scope, a, scope, f.factory), { initialProps: { scope: "one" } });
    act(() => f.finish(0));
    view.rerender({ scope: "two" });
    expect(view.result.current.geometry).toBeNull();
    expect(view.result.current.plan).toBeNull();
    expect(view.result.current.snapshot).toBeUndefined();
    expect(f.runner.dispose).toHaveBeenCalledOnce();
    act(() => f.finish(0)); expect(view.result.current.geometry).toBeNull();
    act(() => view.result.current.cancel());
    act(() => f.finish(1)); expect(view.result.current.geometry).toBeNull();
    act(() => view.result.current.retry());
    act(() => f.finish(2)); expect(view.result.current.snapshot).toBe("two");
    view.unmount(); expect(f.runner.dispose).toHaveBeenCalledTimes(2);
  });
});
