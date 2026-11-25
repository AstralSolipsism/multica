import type { ChatMessage } from "@multica/core/types";
import type { ChatTimelineItem } from "@multica/core/chat";
import { stripChatQuickActionsProtocol } from "./quick-actions";

/**
 * Split an assistant timeline into three regions for the settled process fold:
 *   preface — text items before the first thinking/tool/error item
 *   middle  — everything from the first to the last non-text item (inclusive),
 *             including any text items sandwiched between them
 *   final   — text items after the last non-text item
 *
 * Settled responses fold preface + middle as process history and replace final
 * with canonical content. Legacy rows without canonical content retain final.
 */
export function splitTimeline(items: ChatTimelineItem[]): {
  preface: ChatTimelineItem[];
  middle: ChatTimelineItem[];
  final: ChatTimelineItem[];
} {
  const firstNonTextIdx = items.findIndex((i) => i.type !== "text");
  if (firstNonTextIdx === -1) {
    return { preface: [], middle: [], final: items };
  }
  let lastNonTextIdx = items.length - 1;
  while (lastNonTextIdx >= 0 && items[lastNonTextIdx]!.type === "text") {
    lastNonTextIdx--;
  }
  return {
    preface: items.slice(0, firstNonTextIdx),
    middle: items.slice(firstNonTextIdx, lastNonTextIdx + 1),
    final: items.slice(lastNonTextIdx + 1),
  };
}

type StreamingTimelineSegment = {
  kind: "text" | "process" | "error";
  items: ChatTimelineItem[];
};

/** Group streaming narration and process steps while keeping the final answer tail separate. */
export function segmentStreamingTimeline(items: ChatTimelineItem[]): {
  segments: StreamingTimelineSegment[];
  final: ChatTimelineItem[];
} {
  let lastNonTextIdx = items.length - 1;
  while (lastNonTextIdx >= 0 && items[lastNonTextIdx]!.type === "text") {
    lastNonTextIdx--;
  }
  if (lastNonTextIdx === -1) return { segments: [], final: items };

  const segments: StreamingTimelineSegment[] = [];
  for (let index = 0; index <= lastNonTextIdx; index++) {
    const item = items[index]!;
    const kind = item.type === "text" ? "text" : item.type === "error" ? "error" : "process";
    const previous = segments[segments.length - 1];
    if (kind !== "error" && previous?.kind === kind) previous.items.push(item);
    else segments.push({ kind, items: [item] });
  }
  return { segments, final: items.slice(lastNonTextIdx + 1) };
}

/**
 * Canonical completed answer from the persisted chat message. Surface-specific
 * transforms still apply so hidden protocols stay out of the rendered and
 * copied answer.
 */
export function canonicalAnswerText(
  message: ChatMessage,
  transformContent?: (content: string) => string,
): string {
  const content = stripChatQuickActionsProtocol(message.content ?? "");
  return transformContent ? transformContent(content) : content;
}

/**
 * Markdown source for Copy. Completed messages use canonical content instead
 * of inferring an answer from transcript position. Legacy rows with empty
 * content retain the previous visible-timeline fallback.
 */
export function extractCopyText(
  message: ChatMessage,
  timeline: ChatTimelineItem[],
  transformContent?: (content: string) => string,
): string {
  const canonical = canonicalAnswerText(message, transformContent);
  if (canonical.trim()) return canonical;

  const { preface, final } = splitTimeline(timeline);
  return [...preface, ...final]
    .map((item) => item.content ?? "")
    .filter((content) => content.length > 0)
    .join("\n\n");
}
