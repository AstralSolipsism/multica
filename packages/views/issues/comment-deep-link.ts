/**
 * Comment deep-link helpers — the `#comment-<id>` fragment grammar plus the
 * memento key vocabulary for "this deep link already landed here".
 *
 * This module is a LEAF on purpose: the web navigation adapter
 * (`apps/web/platform/navigation.tsx`) sits in the root layout's provider
 * chain, and importing these from the issues components barrel pulled the
 * whole issue-detail graph (editors included) into the landing/login chunks.
 * Keep it dependency-free.
 */

/** Parse `#comment-<id>` fragments; undefined for anything else. */
export function parseCommentHighlightHash(hash: string): string | undefined {
  const match = /^#comment-([A-Za-z0-9_-]+)$/.exec(hash);
  return match?.[1];
}

/**
 * Memento entry recording that the comment-highlight deep link for this
 * issue already landed on the current route (value: the consumed comment
 * id). Lets a remount that merely restores the view (tab switch back) skip
 * the jump-and-highlight, while a fresh deep-link intent — an inbox
 * selection (see InboxPage.handleSelect) or an in-app `#comment-…` push,
 * which the platform navigation layer clears on dispatch — runs it again.
 */
export function issueHighlightMementoKey(issueId: string): string {
  return `highlight:${issueId}`;
}

/** Shared prefix of every `issueHighlightMementoKey` entry, for prefix clears. */
export const ISSUE_HIGHLIGHT_MEMENTO_PREFIX = "highlight:";
