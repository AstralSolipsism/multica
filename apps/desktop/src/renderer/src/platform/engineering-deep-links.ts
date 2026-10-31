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
