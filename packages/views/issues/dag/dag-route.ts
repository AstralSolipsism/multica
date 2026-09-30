import type { DagPoint } from "./dag-layout";

/** Format the layout engine's polyline. This only rounds corners; it neither
 * finds routes nor changes endpoints. */
export function dagRoutePath(input: readonly DagPoint[], radius = 6): string {
  const points = input.filter((p, i) => !i || p.x !== input[i - 1]!.x || p.y !== input[i - 1]!.y);
  if (points.length < 2) return "";
  let result = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      c = points[i + 1]!;
    const before = Math.hypot(b.x - a.x, b.y - a.y),
      after = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, before / 2, after / 2);
    const x1 = b.x + ((a.x - b.x) * r) / before,
      y1 = b.y + ((a.y - b.y) * r) / before;
    const x2 = b.x + ((c.x - b.x) * r) / after,
      y2 = b.y + ((c.y - b.y) * r) / after;
    result += ` L ${x1} ${y1} Q ${b.x} ${b.y} ${x2} ${y2}`;
  }
  const last = points[points.length - 1]!;
  return `${result} L ${last.x} ${last.y}`;
}

export function dagRouteMidpoint(points: readonly DagPoint[]): DagPoint {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]!;
    if (length && remaining <= length) {
      const a = points[i]!,
        b = points[i + 1]!,
        f = remaining / length;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    remaining -= length;
  }
  return points[0] ?? { x: 0, y: 0 };
}
