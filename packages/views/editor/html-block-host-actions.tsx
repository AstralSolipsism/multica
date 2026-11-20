"use client";

/**
 * Host actions for an embedded ```html block.
 *
 * Issue detail and Chat already own a composer, so their fill/submit actions
 * reach the canvas through `useHtmlCommentActions`. Surfaces without a
 * composer — the engineering-baseline wiki page — still have to honor the
 * canvas's "copy as instruction" action. They provide it here as a thin
 * host-layer adapter instead of growing an editor-surface special case.
 */

import { createContext, use, type ReactNode } from "react";

export interface HtmlBlockHostActions {
  /**
   * Receive canvas-generated instruction text. Returns whether the host took
   * it (the wiki copies to the system clipboard and reports success).
   */
  fillComment?: (content: string) => boolean | Promise<boolean>;
}

const HtmlBlockHostActionsContext = createContext<HtmlBlockHostActions | null>(null);

export function HtmlBlockHostActionsProvider({
  value,
  children,
}: {
  value: HtmlBlockHostActions | null;
  children: ReactNode;
}) {
  return (
    <HtmlBlockHostActionsContext.Provider value={value}>
      {children}
    </HtmlBlockHostActionsContext.Provider>
  );
}

export function useHtmlBlockHostActions(): HtmlBlockHostActions | null {
  return use(HtmlBlockHostActionsContext);
}
