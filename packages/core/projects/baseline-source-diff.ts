export interface BaselineSourceSection {
  anchor: string;
  title: string;
  level: number;
  ownMarkdown: string;
  subtreeMarkdown: string;
}

export interface BaselineSourceDiffRow {
  kind: "context" | "added" | "removed";
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
}

export interface BaselineSourceDiffFold {
  kind: "folded";
  count: number;
  /** Zero-based indexes into the original diff rows, inclusive. */
  start: number;
  end: number;
  rows: BaselineSourceDiffRow[];
}

export type BaselineSourceDiffDisplayRow = BaselineSourceDiffRow | BaselineSourceDiffFold;

export interface FoldBaselineSourceDiffOptions {
  context?: number;
  requiredRowIndexes?: Iterable<number>;
  expandedFoldStarts?: Iterable<number>;
}

interface DocumentHeading {
  anchor: string;
  title: string;
  level: number;
  start: number;
  ownEnd: number;
  end: number;
}

const headingPattern = /^ {0,3}(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const explicitKeyPattern = /^\[([\p{L}\p{N}_]+-[^\]\r\n]{1,64})\][ \t]*(.*)$/u;

function hasPreamble(content: string): boolean {
  return content.split(/\r\n|\r|\n/).some((line) => line.replace(/[ \t]+$/g, "") !== "");
}

function scanHeadings(content: string): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  const seen = new Set<string>();
  let parent = "";
  let fence = "";
  let start = 0;

  while (start < content.length) {
    let end = content.length;
    for (let index = start; index < content.length; index++) {
      if (content[index] === "\r" || content[index] === "\n") {
        end = index;
        break;
      }
    }
    let next = end;
    if (next < content.length) {
      next++;
      if (content[end] === "\r" && next < content.length && content[next] === "\n") next++;
    }

    const line = content.slice(start, end);
    const trimmed = line.replace(/^ +/, "");
    let inFence = fence !== "";
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const marker = trimmed[0]!;
      let markerCount = 0;
      while (trimmed[markerCount] === marker) markerCount++;
      if (fence === "") fence = marker.repeat(markerCount);
      else if (trimmed.startsWith(fence) && trimmed.slice(markerCount).trim() === "") fence = "";
      inFence = true;
    }

    if (!inFence) {
      const match = headingPattern.exec(line.replace(/[ \t]+$/g, ""));
      if (match) {
        if (headings.length === 0 && hasPreamble(content.slice(0, start))) seen.add("_preamble");
        const rawTitle = match[2]!;
        let title = rawTitle.trim().split(/\s+/u).join(" ");
        let key = title;
        const explicit = explicitKeyPattern.exec(rawTitle.trim());
        if (explicit) {
          key = explicit[1]!;
          title = explicit[2]!;
        } else if (match[1]!.length === 3 && parent !== "") {
          key = `${parent} / ${key}`;
        }
        const base = key;
        for (let suffix = 2; seen.has(key); suffix++) key = `${base} (${suffix})`;
        seen.add(key);
        const level = match[1]!.length;
        if (level < 3) parent = key;
        headings.push({
          anchor: key,
          title,
          level,
          start,
          ownEnd: content.length,
          end: content.length,
        });
      }
    }
    start = next;
  }

  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!;
    if (index + 1 < headings.length) heading.ownEnd = headings[index + 1]!.start;
    for (let next = index + 1; next < headings.length; next++) {
      if (headings[next]!.level <= heading.level) {
        heading.end = headings[next]!.start;
        break;
      }
    }
  }
  return headings;
}

export function findBaselineSourceSection(content: string, anchor: string): BaselineSourceSection | null {
  const heading = scanHeadings(content).find((entry) => entry.anchor === anchor);
  if (!heading) return null;
  return {
    anchor: heading.anchor,
    title: heading.title,
    level: heading.level,
    ownMarkdown: content.slice(heading.start, heading.ownEnd),
    subtreeMarkdown: content.slice(heading.start, heading.end),
  };
}

export function baselineSourceLines(source: string): string[] {
  const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}

function backtrackDiff(
  trace: Array<Map<number, number>>,
  before: string[],
  after: string[],
): BaselineSourceDiffRow[] {
  const rows: BaselineSourceDiffRow[] = [];
  let x = before.length;
  let y = after.length;
  for (let depth = trace.length - 1; depth > 0; depth--) {
    const vector = trace[depth]!;
    const diagonal = x - y;
    const previousDiagonal = diagonal === -depth ||
      (diagonal !== depth && (vector.get(diagonal - 1) ?? -Infinity) < (vector.get(diagonal + 1) ?? -Infinity))
      ? diagonal + 1
      : diagonal - 1;
    const previousX = vector.get(previousDiagonal)!;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      rows.push({ kind: "context", text: before[x - 1]!, beforeLine: x, afterLine: y });
      x--;
      y--;
    }
    if (x === previousX) {
      rows.push({ kind: "added", text: after[previousY]!, beforeLine: null, afterLine: previousY + 1 });
    } else {
      rows.push({ kind: "removed", text: before[previousX]!, beforeLine: previousX + 1, afterLine: null });
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    rows.push({ kind: "context", text: before[x - 1]!, beforeLine: x, afterLine: y });
    x--;
    y--;
  }
  return rows.reverse();
}

export function diffBaselineSourceLines(beforeMarkdown: string, afterMarkdown: string): BaselineSourceDiffRow[] {
  const before = baselineSourceLines(beforeMarkdown);
  const after = baselineSourceLines(afterMarkdown);
  const maximum = before.length + after.length;
  const trace: Array<Map<number, number>> = [];
  const vector = new Map<number, number>([[1, 0]]);

  for (let depth = 0; depth <= maximum; depth++) {
    trace.push(new Map(vector));
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      let x: number;
      if (diagonal === -depth ||
        (diagonal !== depth && (vector.get(diagonal - 1) ?? -Infinity) < (vector.get(diagonal + 1) ?? -Infinity))) {
        x = vector.get(diagonal + 1) ?? 0;
      } else {
        x = (vector.get(diagonal - 1) ?? 0) + 1;
      }
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x++;
        y++;
      }
      vector.set(diagonal, x);
      if (x >= before.length && y >= after.length) return backtrackDiff(trace, before, after);
    }
  }
  return [];
}

export function diffBaselineSourceSection(
  beforeContent: string,
  afterContent: string,
  anchor: string,
): BaselineSourceDiffRow[] | null {
  const before = findBaselineSourceSection(beforeContent, anchor);
  const after = findBaselineSourceSection(afterContent, anchor);
  if (!before || !after) return null;
  return diffBaselineSourceLines(before.ownMarkdown, after.ownMarkdown);
}

export function foldBaselineSourceDiff(
  rows: BaselineSourceDiffRow[],
  options: FoldBaselineSourceDiffOptions = {},
): BaselineSourceDiffDisplayRow[] {
  if (rows.length === 0) return [];
  const requestedContext = options.context ?? 3;
  const context = Number.isFinite(requestedContext) ? Math.max(0, Math.floor(requestedContext)) : 3;
  const visible = rows.map((row) => row.kind !== "context");
  const markWithContext = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= rows.length) return;
    for (let row = Math.max(0, index - context); row <= Math.min(rows.length - 1, index + context); row++) {
      visible[row] = true;
    }
  };
  rows.forEach((row, index) => {
    if (row.kind !== "context") markWithContext(index);
  });
  for (const index of options.requiredRowIndexes ?? []) markWithContext(index);

  const expanded = new Set(options.expandedFoldStarts ?? []);
  if (expanded.size > 0) {
    let start = 0;
    while (start < rows.length) {
      if (visible[start]) {
        start++;
        continue;
      }
      let end = start + 1;
      while (end < rows.length && !visible[end]) end++;
      if (expanded.has(start)) {
        for (let index = start; index < end; index++) visible[index] = true;
      }
      start = end;
    }
  }

  const output: BaselineSourceDiffDisplayRow[] = [];
  let index = 0;
  while (index < rows.length) {
    if (visible[index]) {
      output.push(rows[index]!);
      index++;
      continue;
    }
    const start = index;
    while (index < rows.length && !visible[index]) index++;
    output.push({
      kind: "folded",
      count: index - start,
      start,
      end: index - 1,
      rows: rows.slice(start, index),
    });
  }
  return output;
}
