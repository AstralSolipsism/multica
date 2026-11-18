"use client";

import { createContext, use, useMemo, type ReactNode } from "react";
import type { Attachment, SourceContextAttachment } from "@multica/core/types";

export type EntityAttachment = Attachment | SourceContextAttachment;
export type EntityAttachmentsStatus = "loading" | "ready" | "error";

interface EntityAttachmentsValue {
  attachments?: readonly EntityAttachment[];
  phase: "streaming" | "settled";
  status: EntityAttachmentsStatus;
}

const EntityAttachmentsContext = createContext<EntityAttachmentsValue>({
  phase: "settled",
  status: "ready",
});

/** Attachments owned by the comment or Chat message containing this content. */
export function EntityAttachmentsProvider({
  attachments,
  phase = "settled",
  status,
  children,
}: {
  attachments?: readonly EntityAttachment[];
  phase?: "streaming" | "settled";
  status?: EntityAttachmentsStatus;
  children: ReactNode;
}) {
  const inherited = use(EntityAttachmentsContext);
  const value = useMemo(
    () => ({ attachments, phase, status: status ?? inherited.status }),
    [attachments, phase, status, inherited.status],
  );
  return (
    <EntityAttachmentsContext.Provider value={value}>
      {children}
    </EntityAttachmentsContext.Provider>
  );
}

export function useEntityAttachments(): EntityAttachmentsValue {
  return use(EntityAttachmentsContext);
}

/** Resolve only a bare filename, never a path or URL, within the current entity. */
export function resolveEntityHtmlAttachment(
  attachments: readonly EntityAttachment[] | undefined,
  src: string,
): EntityAttachment | undefined {
  if (!src || /[\\/]/.test(src) || /^[a-z][a-z\d+.-]*:/i.test(src)) return undefined;

  let latest: EntityAttachment | undefined;
  for (const attachment of attachments ?? []) {
    const contentType = attachment.content_type.split(";", 1)[0]?.trim().toLowerCase();
    const isHtml = contentType === "text/html" || /\.html?$/i.test(attachment.filename);
    if (attachment.filename !== src || !isHtml) continue;
    const createdAt = Date.parse(attachment.created_at) || 0;
    const latestCreatedAt = latest ? Date.parse(latest.created_at) || 0 : 0;
    if (
      !latest ||
      createdAt > latestCreatedAt ||
      (createdAt === latestCreatedAt && attachment.id > latest.id)
    ) {
      latest = attachment;
    }
  }
  return latest;
}
