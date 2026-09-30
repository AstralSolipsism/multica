"use client";
import { useLayoutEffect } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import type { DagPort } from "./dag-layout";

export function DagHandles({
  nodeId,
  ports,
  width,
  height,
}: {
  nodeId: string;
  ports: readonly DagPort[];
  width: number;
  height: number;
}) {
  const update = useUpdateNodeInternals();
  useLayoutEffect(() => {
    update(nodeId);
  }, [nodeId, ports, width, height, update]);
  return ports.map((port) => {
    const distances = [
      Math.abs(port.x),
      Math.abs(port.x - width),
      Math.abs(port.y),
      Math.abs(port.y - height),
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
        style={{
          left: port.x,
          top: port.y,
          right: "auto",
          bottom: "auto",
          transform: "translate(-50%, -50%)",
        }}
      />
    );
  });
}
