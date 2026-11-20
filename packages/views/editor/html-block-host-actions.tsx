"use client";

import { createContext, use, type ReactNode } from "react";

export interface HtmlBlockHostActions {
  fillComment?: (content: string) => void | boolean | Promise<boolean>;
  // The stable card key lets Chat reuse a submission ID after a lost response.
  submitComment?: (content: string, cardKey: string) => Promise<boolean>;
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
