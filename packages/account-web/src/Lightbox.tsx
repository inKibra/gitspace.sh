// Opens a visual full-screen: a map, a diagram or a block. Pressing the visual anywhere that is not one of its own
// controls, or its expand button (shown on hover and focus), opens a dialog titled with the visual's label; Esc, the
// close button and the backdrop close it. A diagram or map ('zoom') shows at its natural size in a view that pans and
// zooms: drag to pan, wheel or pinch to zoom, buttons and keys to zoom, fit it to the screen or show it at 100%. A
// block ('fill') draws again at the dialog's size.
import { Button, Dialog, DialogContent, DialogTitle } from '@gitspace/ui';
import { Maximize01, ZoomIn, ZoomOut } from '@untitledui/icons';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { useBoxSize, type BoxSize } from './use-box-size.js';

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
/** Fitting never enlarges a visual past this. */
const MAX_FIT = 4;
const ZOOM_STEP = 1.25;
const PAN_STEP = 48;
/** How far, in pixels, a press moves before it pans instead of pressing what is under it. */
const DRAG_SLOP = 4;
/** Pressing one of these inside a visual does what it does instead of opening the lightbox. */
const CONTROLS = 'a, button, input, select, textarea, label, summary, [role="button"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="slider"], [contenteditable="true"]';

interface View { x: number; y: number; scale: number }
interface Press { x: number; y: number; startX: number; startY: number }

/** The view that shows the whole visual centred in the viewport, at `scale` or, when null, as large as fits. */
function centred(box: BoxSize, natural: BoxSize, scale: number | null): View {
  const fitted = scale ?? Math.max(MIN_SCALE, Math.min(MAX_FIT, box.width / Math.max(1, natural.width), box.height / Math.max(1, natural.height)));
  return { scale: fitted, x: (box.width - natural.width * fitted) / 2, y: (box.height - natural.height * fitted) / 2 };
}

/** `view` zoomed by `factor` about the point (x, y) of the viewport, which stays where it is. */
function zoomedAt(view: View, factor: number, x: number, y: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const ratio = scale / view.scale;
  return { scale, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio };
}

function PanZoom({ label, children }: { label: string; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const box = useBoxSize(viewport);
  const natural = useBoxSize(content);
  const [view, setView] = useState<View | null>(null);
  // Until the reader pans or zooms, the visual is fitted again whenever it or the viewport changes size.
  const moved = useRef(false);
  const presses = useRef(new Map<number, Press>());
  const dragged = useRef(false);
  useEffect(() => {
    if (box && natural && !moved.current) setView(centred(box, natural, null));
  }, [box, natural]);
  const change = (next: (current: View) => View): void => {
    moved.current = true;
    setView((current) => current ? next(current) : current);
  };
  const zoomBy = (factor: number): void => { const x = (box?.width ?? 0) / 2; const y = (box?.height ?? 0) / 2; change((current) => zoomedAt(current, factor, x, y)); };
  const reset = (scale: number | null): void => {
    if (!box || !natural) return;
    moved.current = scale !== null;
    setView(centred(box, natural, scale));
  };
  // React listens to wheel events passively, so the page would scroll too; this listener keeps the wheel for zooming.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      // A pinch on a touchpad arrives as a wheel with ctrlKey, in smaller steps.
      const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002));
      moved.current = true;
      setView((current) => current ? zoomedAt(current, factor, event.clientX - rect.left, event.clientY - rect.top) : current);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  const pointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    presses.current.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
    if (presses.current.size === 1) dragged.current = false;
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const press = presses.current.get(event.pointerId);
    if (!press) return;
    if (!dragged.current && Math.hypot(event.clientX - press.startX, event.clientY - press.startY) < DRAG_SLOP && presses.current.size === 1) return;
    // Once it moves, the press pans (or, with a second finger, pinches) and no longer presses what is under it.
    if (!dragged.current) {
      dragged.current = true;
      for (const id of presses.current.keys()) if (!event.currentTarget.hasPointerCapture(id)) event.currentTarget.setPointerCapture(id);
    }
    const others = [...presses.current].filter(([id]) => id !== event.pointerId).map(([, other]) => other);
    const other = others[0];
    if (other) {
      const rect = event.currentTarget.getBoundingClientRect();
      const before = Math.hypot(press.x - other.x, press.y - other.y);
      const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
      const x = (event.clientX + other.x) / 2 - rect.left;
      const y = (event.clientY + other.y) / 2 - rect.top;
      const pan = { x: (event.clientX - press.x) / 2, y: (event.clientY - press.y) / 2 };
      change((current) => { const zoomed = zoomedAt(current, before > 0 ? after / before : 1, x, y); return { ...zoomed, x: zoomed.x + pan.x, y: zoomed.y + pan.y }; });
    } else {
      const pan = { x: event.clientX - press.x, y: event.clientY - press.y };
      change((current) => ({ ...current, x: current.x + pan.x, y: current.y + pan.y }));
    }
    presses.current.set(event.pointerId, { ...press, x: event.clientX, y: event.clientY });
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>): void => { presses.current.delete(event.pointerId); };
  const clickCapture = (event: MouseEvent<HTMLDivElement>): void => {
    if (!dragged.current) return;
    dragged.current = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const key = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    const pans: Partial<Record<string, { x: number; y: number }>> = { ArrowLeft: { x: PAN_STEP, y: 0 }, ArrowRight: { x: -PAN_STEP, y: 0 }, ArrowUp: { x: 0, y: PAN_STEP }, ArrowDown: { x: 0, y: -PAN_STEP } };
    const pan = pans[event.key];
    if (pan) change((current) => ({ ...current, x: current.x + pan.x, y: current.y + pan.y }));
    else if (event.key === '+' || event.key === '=') zoomBy(ZOOM_STEP);
    else if (event.key === '-') zoomBy(1 / ZOOM_STEP);
    else if (event.key === '0') reset(null);
    else if (event.key === '1') reset(1);
    else return;
    event.preventDefault();
  };
  return <div className="flex min-h-0 flex-1 flex-col gap-2">
    <div className="flex flex-wrap items-center gap-1">
      <Button variant="ghost" size="icon-compact" type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}><ZoomOut width={14} height={14} /></Button>
      <span className="w-12 text-center text-caption tabular-nums text-muted-foreground" aria-live="polite">{view ? `${Math.round(view.scale * 100)}%` : ''}</span>
      <Button variant="ghost" size="icon-compact" type="button" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}><ZoomIn width={14} height={14} /></Button>
      <Button variant="ghost" size="compact" type="button" onClick={() => reset(null)}>Fit</Button>
      <Button variant="ghost" size="compact" type="button" onClick={() => reset(1)}>100%</Button>
      <span className="ml-2 text-caption text-muted-foreground">Drag to pan · scroll or pinch to zoom</span>
    </div>
    <div ref={viewport} role="group" aria-label={`${label}: drag or use the arrow keys to pan, scroll, pinch or press + and − to zoom, 0 to fit, 1 for 100%`} tabIndex={0}
      data-zoom={view?.scale}
      className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden rounded-md border border-border bg-surface-1 outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] active:cursor-grabbing"
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onClickCapture={clickCapture} onKeyDown={key}>
      <div ref={content} className="absolute left-0 top-0 w-max origin-top-left"
        style={{ transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined, visibility: view ? 'visible' : 'hidden' }}>{children}</div>
    </div>
  </div>;
}

/** A visual that opens full-screen. `children` is the visual in place; `expanded`, when given, is what the dialog shows
 * (given a way to close it); else it shows `children` again. `actions` show beside the expand button. */
export function Lightbox({ label, mode, children, expanded, actions, className = '' }: {
  /** Names the visual: the dialog's title and the expand button's label. */
  label: string;
  /** 'zoom' pans and zooms the visual at its natural size; 'fill' draws it again at the dialog's size. */
  mode: 'zoom' | 'fill';
  children: ReactNode;
  expanded?: ReactNode | ((close: () => void) => ReactNode);
  actions?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const press = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target;
    // A press inside the dialog reaches here through React's tree, not the page's; it is the dialog's own.
    if (event.defaultPrevented || !(target instanceof Element) || !event.currentTarget.contains(target)) return;
    const control = target.closest(CONTROLS);
    if ((control && event.currentTarget.contains(control)) || window.getSelection()?.toString()) return;
    setOpen(true);
  };
  const shown = typeof expanded === 'function' ? expanded(() => setOpen(false)) : expanded ?? children;
  return <div data-lightbox={label} className={`group/lightbox relative min-w-0 ${className}`}>
    <div className="cursor-zoom-in" onClick={press}>{children}</div>
    <div className="absolute right-2 top-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-focus-within/lightbox:opacity-100 group-hover/lightbox:opacity-100 [@media(hover:none)]:opacity-100">
      {actions}
      <Button variant="secondary" size="icon-compact" type="button" aria-label={`Expand ${label}`} aria-haspopup="dialog" onClick={() => setOpen(true)}><Maximize01 width={14} height={14} /></Button>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="lg" data-lightbox-dialog={mode} className="flex h-[calc(100dvh-2rem)] !max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-hidden p-4">
        <DialogTitle className="pr-10">{label}</DialogTitle>
        {mode === 'zoom' ? <PanZoom label={label}>{shown}</PanZoom> : <div className="min-h-0 flex-1 overflow-auto">{shown}</div>}
      </DialogContent>
    </Dialog>
  </div>;
}
