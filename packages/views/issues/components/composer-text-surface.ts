import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * Click-to-focus policy shared by the comment composers' text surface (the
 * editor host plus the padding bands around it): a press landing on the
 * surface ITSELF — its padding bands and dead space — focuses the editor with
 * the caret at the document position nearest the click.
 *
 * Whitelisted on `target === currentTarget`: presses on anything INSIDE the
 * surface keep their own behavior — ProseMirror places the caret, controls
 * and NodeViews act, toolbar overlays stay neutral, and portaled menus (which
 * still bubble through this React tree) never have the surface as their
 * target. This also leaves a send-in-flight lock intact: the locked editor
 * host is pointer-events-none, so its presses land on the column, not here.
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
  if (event.target !== event.currentTarget) return;
  // A press on the surface's own scrollbar track must scroll, not focus. The
  // track only exists when content overflows (offset−client > 0); jsdom
  // reports 0 for both, which skips the guard entirely.
  const el = event.currentTarget as HTMLElement;
  const vScrollbar = el.offsetWidth - el.clientWidth;
  const hScrollbar = el.offsetHeight - el.clientHeight;
  if (vScrollbar > 0 && event.nativeEvent.offsetX > el.clientWidth) return;
  if (hScrollbar > 0 && event.nativeEvent.offsetY > el.clientHeight) return;
  // preventDefault keeps the press from blurring the editor or starting a
  // selection outside ProseMirror; activate() resolves the caret position from
  // the click coordinates (focusAtCoords) once the editor is live.
  event.preventDefault();
  activate({ x: event.clientX, y: event.clientY });
}
