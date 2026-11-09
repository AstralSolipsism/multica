import { workspaceSlugForPath } from "@multica/core/paths";

let pendingDestination: { userId: string; path: string } | null = null;

export function isEngineeringCandidatePath(path: string): boolean {
  const queryIndex = path.indexOf("?");
  const hashIndex = path.indexOf("#");
  if (queryIndex === -1 || (hashIndex !== -1 && hashIndex < queryIndex)) {
    return false;
  }

  const segments = path
    .slice(0, queryIndex)
    .split("/")
    .filter(Boolean);
  if (
    segments.length !== 4 ||
    segments[1] !== "projects" ||
    segments[3] !== "engineering"
  ) {
    return false;
  }

  const search = path.slice(
    queryIndex + 1,
    hashIndex === -1 ? undefined : hashIndex,
  );
  const candidate = new URLSearchParams(search).get("candidate");
  return candidate !== null && candidate.length > 0;
}

export function preserveEngineeringDestinationForReauth(
  userId: string | null | undefined,
  path: string | null | undefined,
): void {
  pendingDestination =
    userId && path && isEngineeringCandidatePath(path)
      ? { userId, path }
      : null;
}

export function consumeEngineeringDestinationForReauth(
  userId: string,
): string | null {
  const destination = pendingDestination;
  pendingDestination = null;
  return destination?.userId === userId ? destination.path : null;
}

export function clearPendingEngineeringDestination(): void {
  pendingDestination = null;
}

/**
 * Consumes the engineering destination preserved across re-auth and maps it to
 * a workspace the user still belongs to. Returns null when there is nothing to
 * restore; consuming is one-shot either way.
 */
export function engineeringReauthDestination(
  userId: string | null | undefined,
  validSlugs: ReadonlySet<string>,
): { slug: string; path: string } | null {
  if (!userId) return null;
  const pendingPath = consumeEngineeringDestinationForReauth(userId);
  const pendingSlug = pendingPath ? workspaceSlugForPath(pendingPath) : null;
  if (pendingPath && pendingSlug && validSlugs.has(pendingSlug)) {
    return { slug: pendingSlug, path: pendingPath };
  }
  return null;
}

// Minimal structural shape of a TabSession, declared locally so this module
// stays importable from the tab store without a circular dependency.
interface CandidateLandingTab {
  id: string;
  url: string;
  resourceKey: string;
  history: { stack: string[]; index: number };
}

/**
 * Landing intent for a fresh `?candidate=` deep link: when the requested URL
 * targets an engineering candidate path that differs from the matched tab's
 * current URL, rewrite that tab (URL, resource key, one forward history
 * entry). Returns the input pair unchanged otherwise, so callers can diff by
 * reference. `resourceKeyForUrl` is injected from the tab store for the same
 * cycle-avoidance reason.
 */
export function applyEngineeringCandidateLanding<T extends CandidateLandingTab>(
  tabs: T[],
  matched: T,
  url: string,
  resourceKeyForUrl: (url: string) => string,
): { tabs: T[]; tab: T } {
  if (!isEngineeringCandidatePath(url) || matched.url === url) {
    return { tabs, tab: matched };
  }
  const landed: T = {
    ...matched,
    url,
    resourceKey: resourceKeyForUrl(url),
    history: {
      stack: [...matched.history.stack.slice(0, matched.history.index + 1), url],
      index: matched.history.index + 1,
    },
  };
  return { tabs: tabs.map((tab) => (tab.id === landed.id ? landed : tab)), tab: landed };
}
