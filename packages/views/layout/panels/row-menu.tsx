"use client";

import type { ReactNode } from "react";
import { MoreHorizontal } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { TREE_ROW_BUTTON_CLASS } from "./sidebar-tree";

const ROW_MENU_CLASS = cn(
  TREE_ROW_BUTTON_CLASS,
  "text-muted-foreground opacity-0 group-hover/row:opacity-100 data-[popup-open]:opacity-100 [@media(pointer:coarse)]:opacity-100",
);

/** "…" on hover, and the same menu on right-click. */
export function RowMenu({
  label,
  open,
  onOpenChange,
  className,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onPointerDown={(event) => event.stopPropagation()}
            className={cn(ROW_MENU_CLASS, className)}
          />
        }
      >
        <MoreHorizontal className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-auto min-w-48">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
