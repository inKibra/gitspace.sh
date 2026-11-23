import { Tooltip, useSidebar } from '@gitspace/ui';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/** Past this width the sidebar's groups are the board's columns; released there, the board opens. */
export const BOARD_SNAP = 520;
/** The narrowest the list goes, and how far past it a drag folds the sidebar away (the kit rail's clamp). */
const MIN = 160;
const COLLAPSE_SLOP = 56;
/** How close to the window's right edge a release closes the workspace beside the board. */
export const CLOSE_BESIDE_SLOP = 160;

interface Drag { x: number; width: number; last: number; moved: boolean; collapsed: boolean; columns: boolean }

/**
 * The sidebar's right edge: on the board, the divider between the board and the workspace beside it. Dragged, it resizes
 * the sidebar live, past the kit rail's clamp up to the window's edge; past the snap width the list reflows into columns
 * (`onReflow`), and released there the board opens (`onRelease`, which also closes the workspace beside the board when
 * released near the window's edge). Dragged well past the narrowest it folds the sidebar away, and a press that never
 * moved folds it too, as the kit rail does. While it moves the width spring is off, so the panel follows the pointer.
 */
export function SidebarEdge({ onReflow, onRelease }: { onReflow(columns: boolean): void; onRelease(width: number): void }) {
  const { setIsResizing, setWidth, setOpen, toggleSidebar } = useSidebar();
  const [active, setActive] = useState(false);
  const drag = useRef<Drag | null>(null);
  const down = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const panel = event.currentTarget.closest<HTMLElement>('[data-slot="sidebar"]');
    if (!panel || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: panel.offsetWidth, last: panel.offsetWidth, moved: false, collapsed: false, columns: panel.offsetWidth >= BOARD_SNAP };
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (!current) return;
    const raw = current.width + event.clientX - current.x;
    if (!current.moved && Math.abs(raw - current.width) < 4) return;
    if (!current.moved) { current.moved = true; setActive(true); setIsResizing(true); }
    if (raw < MIN - COLLAPSE_SLOP) {
      if (!current.collapsed) { current.collapsed = true; setOpen(false); }
      return;
    }
    if (current.collapsed) { current.collapsed = false; setOpen(true); }
    current.last = Math.max(MIN, Math.min(window.innerWidth, raw));
    setWidth(`${current.last}px`);
    const columns = current.last >= BOARD_SNAP;
    if (columns !== current.columns) { current.columns = columns; onReflow(columns); }
  };
  const end = (): Drag | null => {
    const current = drag.current;
    drag.current = null;
    setActive(false);
    setIsResizing(false);
    return current;
  };
  const up = (): void => {
    const current = end();
    if (!current) return;
    if (!current.moved) { toggleSidebar(); return; }
    if (current.collapsed) { setWidth(`${MIN}px`); return; }
    onRelease(current.last);
  };
  // A cancelled pointer (a touch interrupted, capture lost) ends the drag where it stands, folding nothing.
  const cancel = (): void => {
    const current = end();
    if (current?.moved && !current.collapsed) onRelease(current.last);
  };
  return <Tooltip content={<span>Drag to resize · past {BOARD_SNAP} px it opens the board <kbd className="ml-1 rounded border border-border px-1 font-mono text-[10px]">B</kbd></span>} side="right" followCursor="y" forceOpen={active ? false : undefined}>
    <div role="separator" aria-orientation="vertical" aria-label="Resize the sidebar; past the snap width it opens the board" data-sidebar-edge=""
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
      className={`absolute inset-y-0 right-0 z-30 w-2 cursor-col-resize touch-none after:absolute after:inset-y-0 after:right-0 after:w-px after:transition-colors after:duration-80 hover:after:bg-foreground/25 ${active ? 'after:bg-[#6B97FF]' : 'after:bg-transparent'}`} />
  </Tooltip>;
}
