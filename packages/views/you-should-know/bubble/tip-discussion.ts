import type { CommentDraftKey } from "@multica/core/issues/stores";
import type { IssueTip } from "@multica/core/you-should-know";
import { BYSTANDER_MARKER } from "./bystander-marker";

/** The issue's top-level comment composer draft (CommentInput's key). */
export function issueCommentDraftKey(issueId: string): CommentDraftKey {
  return `new:${issueId}`;
}

/** Blockquote every line, so multi-line text stays inside the quote. */
function quoteLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => (line.trim() ? `> ${line}` : ">"));
}

/**
 * "Discuss in comments" (OL-187 §6, OL-196): the tip as a Markdown quote for
 * the issue's comment draft —
 *
 *     > ✦ <tag> · <line>
 *     >
 *     > <explanation>
 *
 * `tagLabel` is the tag in the viewer's UI language. A tip without an
 * explanation is quoted as its first line alone.
 */
export function tipDiscussionQuote(
  tagLabel: string,
  line: string,
  explanation: string | null,
): string {
  const head = quoteLines(`${BYSTANDER_MARKER} ${tagLabel} · ${line.trim()}`);
  const body = explanation?.trim();
  return [...head, ...(body ? [">", ...quoteLines(body)] : [])].join("\n");
}

/**
 * Whether `pathname` is the tip's issue detail page. The route takes the
 * issue's UUID or its identifier (it rewrites the first into the second), so
 * either spelling counts.
 */
export function isTipIssuePath(
  pathname: string,
  tip: Pick<IssueTip, "issue_id" | "issue_identifier">,
  issueDetail: (id: string) => string,
): boolean {
  return (
    pathname === issueDetail(tip.issue_id) ||
    (tip.issue_identifier !== "" && pathname === issueDetail(tip.issue_identifier))
  );
}
