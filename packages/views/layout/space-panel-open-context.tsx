"use client";

import { createContext, useContext, type ReactNode } from "react";

const SpacePanelOpenContext = createContext(true);

export function SpacePanelOpenProvider({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  return <SpacePanelOpenContext.Provider value={open}>{children}</SpacePanelOpenContext.Provider>;
}

export function useSpacePanelOpen() {
  return useContext(SpacePanelOpenContext);
}
