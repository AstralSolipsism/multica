"use client";

import { useEffect, useMemo, useState } from "react";
import { PreviewTooLargeError, PreviewUnsupportedError } from "@multica/core/api";
import { useT } from "../i18n";
import {
  resolveEntityHtmlAttachment,
  useEntityAttachments,
  type EntityAttachment,
} from "../rich-content/entity-attachments-context";
import { LazyRichBlock } from "../rich-content/lazy-rich-block";
import {
  DYNAMIC_BLOCK_MIN_BODY_PX,
  DynamicBlock,
  DynamicBlockSkeleton,
} from "./dynamic-block";
import { HtmlBlockPreview } from "./html-block-preview";
import { useAttachmentHtmlText } from "./hooks/use-attachment-html-text";

interface AttachmentHtmlBlockProps {
  src: string;
  /** Inline fence body retained for clients and states that cannot load src. */
  fallbackHtml: string;
  title?: string | null;
  reservedHeightPx: number;
}

// chat:done persists the message before the invalidated messages query returns
// its attachments. Keep the skeleton through that handoff instead of flashing
// a missing-attachment error.
const ATTACHMENT_RESOLUTION_GRACE_MS = 2_000;

export function AttachmentHtmlBlock({
  src,
  fallbackHtml,
  title,
  reservedHeightPx,
}: AttachmentHtmlBlockProps) {
  const { attachments, phase } = useEntityAttachments();
  const attachment = useMemo(
    () => resolveEntityHtmlAttachment(attachments, src),
    [attachments, src],
  );

  return (
    <LazyRichBlock
      reservedHeightPx={reservedHeightPx}
      sourceKey={attachment ? `html-attachment:${attachment.id}` : undefined}
    >
      <AttachmentHtmlContent
        src={src}
        attachment={attachment}
        attachmentsKnown={attachments !== undefined}
        phase={phase}
        fallbackHtml={fallbackHtml}
        title={title}
      />
    </LazyRichBlock>
  );
}

function AttachmentHtmlContent({
  src,
  attachment,
  attachmentsKnown,
  phase,
  fallbackHtml,
  title,
}: Omit<AttachmentHtmlBlockProps, "reservedHeightPx"> & {
  attachment?: EntityAttachment;
  attachmentsKnown: boolean;
  phase: "streaming" | "settled";
}) {
  const { t } = useT("editor");
  const [resolution, setResolution] = useState({ src, expired: false });
  useEffect(() => {
    setResolution((current) =>
      current.src === src && !current.expired ? current : { src, expired: false },
    );
    if (attachmentsKnown || phase === "streaming") return;
    const timer = setTimeout(
      () => setResolution({ src, expired: true }),
      ATTACHMENT_RESOLUTION_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [attachmentsKnown, phase, src]);

  const query = useAttachmentHtmlText(attachment?.id);
  if (!attachment) {
    const resolutionExpired = resolution.src === src && resolution.expired;
    if (phase === "streaming" || (!attachmentsKnown && !resolutionExpired)) {
      return (
        <AttachmentHtmlLoading
          fallbackHtml={fallbackHtml}
          title={title}
          message={t(($) =>
            phase === "streaming"
              ? $.attachment.preview_after_reply
              : $.attachment.preview_loading,
          )}
        />
      );
    }
    return (
      <AttachmentHtmlFallback
        fallbackHtml={fallbackHtml}
        title={title}
        reason={t(($) => $.attachment.preview_attachment_missing, { filename: src })}
      />
    );
  }

  if (query.isPending) {
    return (
      <AttachmentHtmlLoading
        fallbackHtml={fallbackHtml}
        title={title}
        message={t(($) => $.attachment.preview_loading)}
      />
    );
  }

  if (query.isError) {
    const reason = query.error instanceof PreviewTooLargeError
      ? t(($) => $.attachment.preview_too_large)
      : query.error instanceof PreviewUnsupportedError
        ? t(($) => $.attachment.preview_unsupported)
        : t(($) => $.attachment.preview_failed);
    return (
      <AttachmentHtmlFallback
        fallbackHtml={fallbackHtml}
        title={title}
        reason={reason}
      />
    );
  }

  return <HtmlBlockPreview html={query.data.text} title={title} />;
}

function AttachmentHtmlLoading({
  fallbackHtml,
  title,
  message,
}: {
  fallbackHtml: string;
  title?: string | null;
  message: string;
}) {
  return (
    <DynamicBlock
      kind="html"
      title={title}
      source={fallbackHtml}
      bodyHeight={DYNAMIC_BLOCK_MIN_BODY_PX}
      preview={() => (
        <div style={{ height: DYNAMIC_BLOCK_MIN_BODY_PX }}>
          <DynamicBlockSkeleton label={message} />
        </div>
      )}
    />
  );
}

function AttachmentHtmlFallback({
  fallbackHtml,
  title,
  reason,
}: {
  fallbackHtml: string;
  title?: string | null;
  reason: string;
}) {
  return (
    <div>
      <HtmlBlockPreview html={fallbackHtml} title={title} />
      <p role="alert" className="mt-2 px-1 text-caption text-muted-foreground">
        {reason}
      </p>
    </div>
  );
}
