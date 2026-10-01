// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DagHandles, DagPortUpdateProvider } from "./dag-ports";
const update = vi.hoisted(() => vi.fn());
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  useUpdateNodeInternals: () => update,
}));
afterEach(() => { cleanup(); update.mockClear(); });
const port = { id: "p", type: "source" as const, x: 248, y: 58 };
function Nodes({ x = 248, removed = false }: { x?: number; removed?: boolean }) {
  return <DagPortUpdateProvider>
    <DagHandles nodeId="a" ports={removed ? [] : [{ ...port, x }]} width={248} height={116} />
    <DagHandles nodeId="b" ports={[port]} width={248} height={116} />
    <DagHandles nodeId="empty" ports={[]} width={248} height={116} />
  </DagPortUpdateProvider>;
}
describe("DAG handle measurement", () => {
  it("batches mounted handles and ignores unchanged geometry even with fresh arrays", async () => {
    const view = render(<Nodes />);
    await waitFor(() => expect(update).toHaveBeenCalledWith(["a", "b"]));
    expect(update).toHaveBeenCalledTimes(1);
    update.mockClear();
    view.rerender(<Nodes />);
    await act(async () => {});
    expect(update).not.toHaveBeenCalled();
    view.rerender(<Nodes x={200} />);
    await waitFor(() => expect(update).toHaveBeenCalledWith(["a"]));
  });
  it("updates the node when its final handle is removed", async () => {
    const view = render(<Nodes />);
    await act(async () => {});
    update.mockClear();
    view.rerender(<Nodes removed />);
    await waitFor(() => expect(update).toHaveBeenCalledWith(["a"]));
  });
  it("discards measurements when the canvas unmounts before the batch runs", async () => {
    const view = render(<Nodes />);
    view.unmount();
    await act(async () => {});
    expect(update).not.toHaveBeenCalled();
  });
});
