"use client";

import {
  FolderPlus,
  ListChevronsDownUp,
  ListChevronsUpDown,
} from "@multica/ui/icons";
import { IconButton } from "@multica/ui/components/common/icon-button";

export function FolderExplorerHeaderActions({
  hasFolders,
  expandAllLabel,
  collapseAllLabel,
  newFolderLabel,
  onExpandAll,
  onCollapseAll,
  onNewFolder,
}: {
  hasFolders: boolean;
  expandAllLabel: string;
  collapseAllLabel: string;
  newFolderLabel: string;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onNewFolder: () => void;
}) {
  return (
    <>
      {hasFolders ? (
        <>
          <IconButton
            label={expandAllLabel}
            tooltipSide="bottom"
            className="text-muted-foreground"
            onClick={onExpandAll}
          >
            <ListChevronsUpDown />
          </IconButton>
          <IconButton
            label={collapseAllLabel}
            tooltipSide="bottom"
            className="text-muted-foreground"
            onClick={onCollapseAll}
          >
            <ListChevronsDownUp />
          </IconButton>
        </>
      ) : null}
      <IconButton
        label={newFolderLabel}
        tooltipSide="bottom"
        className="text-muted-foreground"
        onClick={onNewFolder}
      >
        <FolderPlus />
      </IconButton>
    </>
  );
}
