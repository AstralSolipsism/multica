"use client";

import type { ReactNode } from "react";
import { ChevronRight, Folder } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import {
  CollectionNameCell,
  CollectionTag,
} from "../../layout/collection-list";

export function FolderExplorerDepth({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className="relative h-full shrink-0 self-stretch"
      style={{ width: depth * 20 }}
    >
      {Array.from({ length: depth }, (_, index) => (
        <span
          key={index}
          className="absolute inset-y-0 w-px bg-border"
          style={{ left: index * 20 + 9 }}
        />
      ))}
    </span>
  );
}

export function FolderExplorerNameCell({
  name,
  typeLabel,
  countLabel,
  openLabel,
  onOpen,
  icon,
  preview,
  depth = 0,
  expanded = false,
}: {
  name: string;
  typeLabel?: string;
  countLabel: string;
  openLabel: string;
  onOpen: () => void;
  icon?: ReactNode;
  preview?: ReactNode;
  depth?: number;
  expanded?: boolean;
}) {
  return (
    <span className="@container/folder-name flex min-w-0 flex-1 items-center">
      <FolderExplorerDepth depth={depth} />
      <button
        type="button"
        aria-label={openLabel}
        aria-expanded={expanded}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-xs text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            expanded && "rotate-90",
          )}
        />
        <CollectionNameCell
          icon={
            icon ?? (
              <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            )
          }
          title={name}
          badges={typeLabel ? <CollectionTag>{typeLabel}</CollectionTag> : undefined}
          description={countLabel}
          trailing={
            preview ? (
              <span className="shrink-0 @max-[22rem]/folder-name:hidden">{preview}</span>
            ) : undefined
          }
        />
      </button>
    </span>
  );
}
