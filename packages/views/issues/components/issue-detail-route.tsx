"use client";

import { useEffect, useRef } from "react";
import { useCanonicalIssue } from "@multica/core/issues/canonical-id";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { parseCommentHighlightHash } from "../comment-deep-link";
import { useNavigation } from "../../navigation";
import { IssueDetail, IssueDetailSkeleton, IssueNotFound } from "./issue-detail";
import { IssuePeekHost } from "./issue-peek";

export { parseCommentHighlightHash } from "../comment-deep-link";

interface IssueDetailRouteProps {
  /**
   * Raw `/{ws}/issues/{segment}` parameter. Either a UUID (older links, and
   * anything the app itself linked before the issue row was in hand) or a
   * human-readable identifier such as `MUL-123`.
   */
  routeId: string;
  onDelete?: () => void;
}

/**
 * Rewrite `/{ws}/issues/{uuid}` to `/{ws}/issues/{identifier}` once the issue
 * is known, so the address bar and any copied URL read as `MUL-123`.
 *
 * A replace, not a push: the UUID URL is the same page, and a history entry
 * for it would make Back bounce the user between two spellings of one issue.
 * The adapter's `replaceCanonical` hook lets each platform fix up deep-link
 * landing records for the respelling (web clears so the remounted instance
 * re-lands; desktop migrates so the surviving instance stays landed).
 */
export function useCanonicalIssueUrl(
  routeId: string,
  identifier: string | undefined,
  hash = "",
) {
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const canonicalHref = identifier ? `${paths.issueDetail(identifier)}${hash}` : null;
  // `useWorkspacePaths()` and the navigation adapter are both rebuilt on
  // render, so this ref — not the dependency array — is what guarantees the
  // replace runs once per target instead of on every commit. Desktop reuses
  // the route instance across issues (param changes do not remount it and it
  // has no key), so the guard is scoped to the routeId stint that produced
  // it: once the routeId moves on — to the identifier spelling this rewrite
  // committed, or to another issue — a later UUID arrival for the SAME issue
  // is a new visit and must rewrite again (OL-302).
  const replacedRef = useRef<string | null>(null);
  const routeIdRef = useRef(routeId);

  useEffect(() => {
    if (routeIdRef.current !== routeId) {
      routeIdRef.current = routeId;
      replacedRef.current = null;
    }
    if (!canonicalHref || routeId === identifier) return;
    if (replacedRef.current === canonicalHref) return;
    replacedRef.current = canonicalHref;
    (navigation.replaceCanonical ?? navigation.replace)(canonicalHref);
  }, [canonicalHref, identifier, routeId, navigation]);
}

/**
 * The `#comment-…` fragment the current URL carries, read through the
 * navigation adapter rather than `window.location`.
 *
 * `window.location.hash` is wrong here on both platforms:
 *  - web: an in-app `router.push` commits the new URL only after the new page
 *    renders (Next's HistoryUpdater), and a same-page push fires no
 *    `hashchange` — a mount-time read sees the PREVIOUS page's fragment, or
 *    never sees the new one. The web adapter compensates: it records every
 *    push/replace target and reports ITS fragment while the URL commit is
 *    still pending, so the value is accurate from the destination's first
 *    render. Hydration is the one frame-late case left (the server snapshot
 *    is "") — `IssueDetail` captures its deep-link arrival when the issue
 *    and timeline first become ready, never at mount, so it still lands.
 *  - desktop: the renderer is a MemoryRouter over a `file://` page, so
 *    `window.location.hash` is always empty; the adapter's hash comes from
 *    the tab URL and is frame-accurate.
 */
function useCommentHighlightHash(): { hash: string; commentId?: string } {
  const { hash } = useNavigation();
  return { hash, commentId: parseCommentHighlightHash(hash) };
}

/**
 * Route-level wrapper around `IssueDetail` for `/{ws}/issues/{id}`.
 *
 * Two jobs the panel-embedded `IssueDetail` must not do:
 *  - resolve an identifier segment to the issue's UUID before rendering, so
 *    every cache key below stays UUID-keyed and realtime updates land (see
 *    `useCanonicalIssue`);
 *  - rewrite the address bar to the canonical identifier URL. That belongs to
 *    the route and only the route — the inbox renders `IssueDetail` in a side
 *    panel, where replacing the URL would navigate the user out of the inbox.
 */
export function IssueDetailRoute({ routeId, onDelete }: IssueDetailRouteProps) {
  const wsId = useWorkspaceId();
  const { canonicalId, issue, isResolving, notFound } = useCanonicalIssue(wsId, routeId);
  const highlight = useCommentHighlightHash();

  useCanonicalIssueUrl(routeId, issue?.identifier, highlight.hash);

  if (isResolving) return <IssueDetailSkeleton />;

  // Render not-found here rather than handing the unresolved segment down.
  // `IssueDetail` would mount a second observer on the query that just failed,
  // refetch it, and restart this component's resolve/remount cycle — an
  // unbounded request loop that never settles. See `CanonicalIssue.notFound`.
  if (notFound || !canonicalId) return <IssueNotFound showBackLink={!onDelete} />;

  // The page hosts a side peek so Shift+Click on an issue mention in the
  // description or comments opens it floating over the page. Keyed so moving
  // to another issue closes the peek.
  return (
    <IssuePeekHost key={canonicalId}>
      <IssueDetail
        issueId={canonicalId}
        onDelete={onDelete}
        highlightCommentId={highlight.commentId}
      />
    </IssuePeekHost>
  );
}
