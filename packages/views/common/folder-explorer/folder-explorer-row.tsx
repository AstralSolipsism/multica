"use client";

import type { ReactNode } from "react";
import { Folder } from "lucide-react";
import { ListGridCell, ListGridRow } from "@multica/ui/components/ui/list-grid";

export function FolderExplorerRow({
  name,
  typeLabel,
  countLabel,
  openLabel,
  onOpen,
  leading,
  trailing,
  actions,
}: {
  name: string;
  typeLabel?: string;
  countLabel: string;
  openLabel: string;
  onOpen: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <ListGridRow className="cursor-pointer" onClick={onOpen}>
      {leading}
      <ListGridCell className="px-0">
        <button
          type="button"
          aria-label={openLabel}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className="flex h-full w-full min-w-0 items-center gap-1.5 rounded-xs px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-body font-medium">{name}</span>
          {typeLabel && (
            <span className="shrink-0 rounded-xs bg-muted px-1 py-0.5 text-caption text-muted-foreground">
              {typeLabel}
            </span>
          )}
          <span className="ml-auto shrink-0 pl-2 text-caption tabular-nums text-muted-foreground">
            {countLabel}
          </span>
        </button>
      </ListGridCell>
      {trailing}
      <ListGridCell className="justify-end px-0" onClick={(event) => event.stopPropagation()}>
        {actions}
      </ListGridCell>
    </ListGridRow>
  );
}
