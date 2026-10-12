import type { SchedulableTip, TipAnchorDescriptor } from "./types";

/**
 * Canonical identity key for a descriptor. Effects key off this string so a
 * caller that forgets to memo its descriptor still re-registers only when the
 * descriptor's content actually changes (the contract asks callers to memo;
 * this keeps a slip from churning the registry every render).
 */
export function tipAnchorDescriptorKey(descriptor: TipAnchorDescriptor): string {
  if (descriptor.level === "summary") {
    const entries = Object.keys(descriptor.scope)
      .sort()
      .map((id) => `${id}=${descriptor.scope[id]}`);
    return `summary:${entries.join(",")}`;
  }
  return `${descriptor.level}:${descriptor.issueId}`;
}

/**
 * Whether a visible anchor is a candidate position for `tip`: same-issue
 * detail header, same-issue row, or a summary whose scope covers the issue.
 */
export function isTipAnchorCandidate(
  descriptor: TipAnchorDescriptor,
  tip: SchedulableTip,
): boolean {
  if (descriptor.level === "summary") {
    return descriptor.scope[tip.issue_id] !== undefined;
  }
  return descriptor.issueId === tip.issue_id;
}
