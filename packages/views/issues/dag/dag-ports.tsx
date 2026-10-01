"use client";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import type { DagPort } from "./dag-layout";

const PortUpdateContext = createContext<((id: string) => void) | null>(null);

/** Collect each commit's handle changes before React Flow schedules its measurement frame. */
export function DagPortUpdateProvider({ children }: { children: ReactNode }) {
  const update = useUpdateNodeInternals();
  const batch = useMemo(() => ({ ids: new Set<string>(), queued: false, mounted: true }), []);
  useLayoutEffect(() => {
    batch.mounted = true;
    return () => { batch.mounted = false; batch.ids.clear(); };
  }, [batch]);
  const enqueue = useCallback((id: string) => {
    batch.ids.add(id);
    if (batch.queued) return;
    batch.queued = true;
    queueMicrotask(() => {
      batch.queued = false;
      if (!batch.mounted || !batch.ids.size) return;
      const ids = [...batch.ids];
      batch.ids.clear();
      update(ids);
    });
  }, [batch, update]);
  return <PortUpdateContext.Provider value={enqueue}>{children}</PortUpdateContext.Provider>;
}

export function DagHandles({
  nodeId, ports, width, height,
}: {
  nodeId: string;
  ports: readonly DagPort[];
  width: number;
  height: number;
}) {
  const enqueue = useContext(PortUpdateContext);
  const signature = JSON.stringify(ports);
  const previous = useRef<string | null>(null);
  useLayoutEffect(() => {
    // ResizeObserver handles initial dimensions. Force a measurement only for
    // actual handles, including the transition that removes the final handle.
    if (signature !== "[]" || (previous.current !== null && previous.current !== "[]")) {
      if (!enqueue) throw new Error("DAG handles require DagPortUpdateProvider");
      enqueue(nodeId);
    }
    previous.current = signature;
  }, [nodeId, signature, width, height, enqueue]);
  return ports.map((port) => {
    const distances = [
      Math.abs(port.x), Math.abs(port.x - width),
      Math.abs(port.y), Math.abs(port.y - height),
    ];
    const side = [Position.Left, Position.Right, Position.Top, Position.Bottom][
      distances.indexOf(Math.min(...distances))
    ]!;
    return (
      <Handle
        key={port.id}
        id={port.id}
        type={port.type}
        position={side}
        className="!pointer-events-none !h-px !w-px !min-h-0 !min-w-0 !border-0 !opacity-0"
        style={{ left: port.x, top: port.y, right: "auto", bottom: "auto", transform: "translate(-50%, -50%)" }}
      />
    );
  });
}
