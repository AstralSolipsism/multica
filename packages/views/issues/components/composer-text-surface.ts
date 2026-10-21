import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * Click-to-focus policy shared by the comment composers' text surface (the
 * editor host plus the padding bands around it): a press landing outside
 * ProseMirror's own surface and outside any interactive control focuses the
 * editor with the caret at the document position nearest the click.
 *
 * Ordering: ContentEditor's own wrapper mousedown handler runs first for
 * clicks inside it and calls preventDefault, so `defaultPrevented` here means
 * "already handled" and the press must not be double-focused.
 */
export function focusComposerOnSurfaceMouseDown(
  event: ReactMouseEvent<HTMLElement>,
  activate: (target: { x: number; y: number }) => void,
): void {
  if (event.button !== 0 || event.defaultPrevented) return;
  const target = event.target as HTMLElement;
  // ProseMirror places the caret itself; interactive elements (links, buttons,
  // NodeViews, the lazy shell's role=button) keep their own press behavior.
  if (target.closest(".ProseMirror")) return;
  if (target.closest("a, button, input, textarea, [role='button'], [data-node-view-wrapper]")) return;
  // A press on the host's own scrollbar track must scroll, not focus. The
  // track only exists when content overflows (offset−client > 0); jsdom
  // reports 0 for both, which skips the guard entirely.
  if (target === event.currentTarget) {
    const el = event.currentTarget as HTMLElement;
    const vScrollbar = el.offsetWidth - el.clientWidth;
    const hScrollbar = el.offsetHeight - el.clientHeight;
    if (vScrollbar > 0 && event.nativeEvent.offsetX > el.clientWidth) return;
    if (hScrollbar > 0 && event.nativeEvent.offsetY > el.clientHeight) return;
  }
  // preventDefault keeps the press from blurring the editor or starting a
  // selection outside ProseMirror; activate() resolves the caret position from
  // the click coordinates (focusAtCoords) once the editor is live.
  event.preventDefault();
  activate({ x: event.clientX, y: event.clientY });
}
