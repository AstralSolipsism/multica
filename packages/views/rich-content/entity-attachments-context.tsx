"use client";

import { createContext, use, useMemo, type ReactNode } from "react";
import type { Attachment, SourceContextAttachment } from "@multica/core/types";
import type { RichContentPhase } from "./rich-content";

export type EntityAttachment = Attachment | SourceContextAttachment;

interface EntityAttachmentsValue {
  attachments?: readonly EntityAttachment[];
  phase: RichContentPhase;
}

const EntityAttachmentsContext = createContext<EntityAttachmentsValue>({
  phase: "settled",
});

/** Attachments owned by the comment or Chat message containing this content. */
export function EntityAttachmentsProvider({
  attachments,
  phase,
  children,
}: EntityAttachmentsValue & { children: ReactNode }) {
  const value = useMemo(() => ({ attachments, phase }), [attachments, phase]);
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
    if (
      !latest ||
      attachment.created_at > latest.created_at ||
      (attachment.created_at === latest.created_at && attachment.id > latest.id)
    ) {
      latest = attachment;
    }
  }
  return latest;
}
