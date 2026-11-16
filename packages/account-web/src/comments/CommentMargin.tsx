// The chat's comments in a margin beside its column, Google Docs style: each comment is a compact pill at the height of
// what it is about, comments anchored close together share one stacked marker, and none overlap (a pill is pushed down
// below the one above, as close to its anchor as it fits). Hovering or clicking a commented passage, item or tool row
// opens its comment, and hovering a comment lights what it is about. A staged comment is edited or removed in its opened
// card; a sent one is read-only, with the agent's reply under it.
//
// The margin's space is kept from the start where it fits, so the first comment moves nothing; the column and the
// margin are centred together. Where it does not fit (a narrow window, the Inspector open) a 28 px strip right of the
// column is kept instead, and the comments are dots at its right edge, each opening its comments beside its anchor. The
// comment icons of paragraphs, items and tool rows go in the gutter right of the column (CommentLayer.tsx), never over
// the text: the gap before the margin, or the strip's left part. The margin also paints the passages the comments quote
// (CSS Custom Highlight API) and marks the paragraphs commented as a whole.
import { Badge, Button, useShape } from '@gitspace/ui';
import { commentExcerpt } from '@gitspace/protocol-runtime/comments';
import { Edit02, Lock01, Trash01 } from '@untitledui/icons';
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { anchorLabel, locateAnchor } from './CommentLayer.js';
import { CommentLayer, type CommentNote } from './context.js';

/** Width of the margin column and its gap from the column; the gap holds the comment icons. */
const MARGIN_WIDTH = 244;
const MARGIN_GAP = 28;
/** Anchors this close (px, from the first of a run) share one stacked marker. */
const GROUP_GAP = 40;
/** Space between margin cards, and between edge dots. */
const CARD_GAP = 6;
const DOT_GAP = 14;
/** Where the margin does not fit: the strip right of the column for the comment icons (its left part) and the edge
 * dots (its right `DOT_STRIP`). */
const EDGE_GUTTER = 28;
const DOT_STRIP = 12;
const PILL_HEIGHT = 30;

interface Group { key: string; notes: CommentNote[]; anchorTop: number }
interface Found { element: Element; range: Range | null; whole: Element | null }

/** Runs of anchors close together, in order down the page. */
function groupsOf(notes: readonly CommentNote[], tops: ReadonlyMap<string, number>): Group[] {
  const groups: Group[] = [];
  for (const note of [...notes].sort((a, b) => (tops.get(a.id) ?? 0) - (tops.get(b.id) ?? 0))) {
    const top = tops.get(note.id);
    if (top === undefined) continue;
    const last = groups.at(-1);
    if (last && top - last.anchorTop < GROUP_GAP) last.notes.push(note);
    else groups.push({ key: note.id, notes: [note], anchorTop: top });
  }
  return groups;
}

/** Each group's top: at its anchor, or pushed below the one above. */
function stack(groups: readonly Group[], heights: ReadonlyMap<string, number>, gap: number, fallback: number): number[] {
  let bottom = Number.NEGATIVE_INFINITY;
  return groups.map((group) => {
    const top = Math.max(group.anchorTop, bottom + gap);
    bottom = top + (heights.get(group.key) ?? fallback);
    return top;
  });
}

const painted = new Map<string, { staged: Range[]; sent: Range[]; active: Range[] }>();

function paint(): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') return;
  const all = [...painted.values()];
  CSS.highlights.set('gitspace-comment-staged', new Highlight(...all.flatMap((entry) => entry.staged)));
  CSS.highlights.set('gitspace-comment-sent', new Highlight(...all.flatMap((entry) => entry.sent)));
  CSS.highlights.set('gitspace-comment-active', new Highlight(...all.flatMap((entry) => entry.active)));
}

function Initial({ name }: { name: string }) {
  return <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[10px] font-semibold text-foreground ring-2 ring-background">{name.trim().slice(0, 1).toUpperCase() || '?'}</span>;
}

/** What a comment's pill says first: its note, or what it is on while its message is not loaded. */
function firstLine(note: CommentNote): string {
  return note.note ?? note.anchor.quote ?? anchorLabel(note.anchor);
}

/** A comment collapsed: who, its first line, its state, and the agent's reply under a sent one. */
function Pill({ note, author, onOpen, onHover }: { note: CommentNote; author: string; onOpen(): void; onHover(on: boolean): void }) {
  const shape = useShape();
  const reply = note.replies.find((each) => each.text !== null)?.text ?? null;
  return <button type="button" data-comment-pill={note.state} data-comment-id={note.id} aria-label={`Comment: ${commentExcerpt(firstLine(note), 60)} · ${note.state}`}
    onClick={onOpen} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}
    className={`${shape.container} flex w-full min-w-0 flex-col gap-1 border border-border bg-background px-1.5 py-1 text-left shadow-surface-1 transition-colors hover:bg-surface-1`}>
    <span className="flex min-h-5 w-full min-w-0 items-center gap-1.5">
      <Initial name={author} />
      <span className="min-w-0 flex-1 truncate text-caption text-foreground">{firstLine(note)}</span>
      {note.state === 'sent' ? <Lock01 width={11} height={11} className="shrink-0 text-muted-foreground" /> : null}
      <Badge size="compact" variant="dot" color={note.state === 'staged' ? 'amber' : 'gray'}>{note.state}</Badge>
    </span>
    {note.replies.length ? <span data-comment-reply-line="" className="flex min-w-0 items-center gap-1 pl-6 text-[11px] text-muted-foreground"><span className="shrink-0 font-medium text-foreground">Agent</span><span className="min-w-0 truncate">{reply ? commentExcerpt(reply, 80) : 'replied'}</span></span> : null}
  </button>;
}

/** A comment opened: the full note, editable and removable while staged; a sent one locked, with the agent's replies. */
function Card({ note, author, onHover, onClose }: { note: CommentNote; author: string; onHover(on: boolean): void; onClose(): void }) {
  const shape = useShape();
  const layer = useContext(CommentLayer);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sent = note.state === 'sent';
  const act = (operation: Promise<void>, after: () => void): void => {
    setError(null);
    operation.then(after, (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
  };
  const save = (): void => { if (draft?.trim() && layer) act(layer.edit(note.id, draft.trim()), () => setDraft(null)); };
  return <article data-comment-card={note.state} data-comment-id={note.id} aria-label={sent ? 'Sent comment' : 'Comment in your message'} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}
    className={`${shape.container} flex min-w-0 flex-col gap-1.5 border border-border border-l-2 bg-background p-2 shadow-surface-2`}
    style={{ borderLeftColor: sent ? 'var(--border)' : 'var(--color-amber-500, #f59e0b)' }}>
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Initial name={author} />
      <span className="min-w-0 flex-1 truncate">{anchorLabel(note.anchor)}</span>
      {sent ? <Badge size="compact" variant="dot" color="gray"><Lock01 width={10} height={10} />sent</Badge> : <Badge size="compact" variant="dot" color="amber">staged</Badge>}
      {!sent && draft === null ? <>
        <button type="button" aria-label="Edit comment" className="rounded p-0.5 hover:bg-surface-2 hover:text-foreground" onClick={() => setDraft(note.note ?? '')}><Edit02 width={12} height={12} /></button>
        <button type="button" aria-label="Remove comment" className="rounded p-0.5 hover:bg-surface-2 hover:text-foreground" onClick={() => { if (layer) act(layer.remove(note.id), onClose); }}><Trash01 width={12} height={12} /></button>
      </> : null}
    </span>
    {note.anchor.quote ? <span className="truncate border-l-2 border-border pl-1.5 text-[11px] italic text-muted-foreground">{commentExcerpt(note.anchor.quote, 90)}</span> : null}
    {draft === null ? <p className="whitespace-pre-wrap text-caption text-foreground [overflow-wrap:anywhere]">{note.note ?? 'Sent with your message.'}</p> : <>
      {/* FLUID-GAP: multi-line textarea — the registry has no textarea field. */}
      <textarea aria-label="Your comment" rows={3} value={draft} autoFocus onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') setDraft(null); if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save(); }}
        className={`${shape.input} w-full resize-y border border-border bg-surface-2 px-2 py-1 text-caption text-foreground`} />
      <span className="flex gap-1.5">
        <Button variant="primary" size="compact" type="button" disabled={!draft.trim()} onClick={save}>Save</Button>
        <Button variant="ghost" size="compact" type="button" onClick={() => setDraft(null)}>Cancel</Button>
      </span>
    </>}
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {note.replies.map((reply) => <p key={reply.row} data-comment-reply-text="" className="border-t border-border pt-1.5 text-caption text-foreground [overflow-wrap:anywhere]"><span className="font-medium">Agent · </span>{reply.text ?? 'Replied in the chat.'}</p>)}
  </article>;
}

/** Several comments anchored close together, collapsed: their authors and how many. */
function Stacked({ group, author, onOpen }: { group: Group; author: string; onOpen(): void }) {
  const shape = useShape();
  const staged = group.notes.some((note) => note.state === 'staged');
  return <button type="button" data-comment-stack={group.notes.length} aria-label={`${group.notes.length} comments: show them`} onClick={onOpen}
    className={`${shape.container} flex h-[30px] w-full items-center gap-1.5 border border-border bg-background px-1.5 text-left shadow-surface-1 hover:bg-surface-1`}>
    <span className="flex -space-x-1.5">{group.notes.slice(0, 3).map((note) => <Initial key={note.id} name={author} />)}</span>
    <span className="flex-1 text-caption text-foreground">{group.notes.length} comments</span>
    <Badge size="compact" variant="dot" color={staged ? 'amber' : 'gray'}>{staged ? 'staged' : 'sent'}</Badge>
  </button>;
}

/** A block's comments as opened cards (staged ones editable, sent ones locked): the lightbox's comment panel. */
export function CommentCards({ notes }: { notes: readonly CommentNote[] }) {
  const layer = useContext(CommentLayer);
  if (!notes.length) return <p className="text-caption text-muted-foreground">No comments on this yet.</p>;
  return <div data-comment-card-list="" className="flex flex-col gap-2">
    {notes.map((note) => <Card key={note.id} note={note} author={layer?.author ?? 'You'} onHover={() => undefined} onClose={() => undefined} />)}
  </div>;
}

/** The chat's column with its comment margin. `columnMax` is the column's widest; with the margin beside it, the two
 * are centred together. */
export function CommentMarginLayout({ columnMax, children }: { columnMax: number; children: ReactNode }) {
  const layer = useContext(CommentLayer);
  const id = useId();
  const outer = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const notes = useMemo(() => layer?.notes ?? [], [layer?.notes]);
  const author = layer?.author ?? 'You';
  const [width, setWidth] = useState(0);
  const [tick, setTick] = useState(0);
  const [tops, setTops] = useState<ReadonlyMap<string, number>>(new Map());
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const anchors = useRef(new Map<string, Found>());
  /** The paragraphs, headings and list items commented on as a whole: marked, not their text highlighted. */
  const marked = useRef(new Set<Element>());
  const wide = width >= columnMax + MARGIN_WIDTH + MARGIN_GAP;
  const shown = notes.length > 0;
  const reserved = wide && layer !== null;
  const edge = !wide && layer !== null;

  // The column's size, the page around it, and the rows drawn (the chat draws only the rows in view): re-measure when
  // any changes.
  useLayoutEffect(() => {
    const outerElement = outer.current;
    const rowElement = row.current;
    if (!outerElement || !rowElement) return;
    let frame = 0;
    const again = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setTick((value) => value + 1)); };
    const resize = new ResizeObserver(() => { setWidth(outerElement.clientWidth); again(); });
    resize.observe(outerElement);
    resize.observe(rowElement);
    const mounted = new MutationObserver(again);
    const items = rowElement.querySelector('[data-transcript-items]');
    if (items) mounted.observe(items, { childList: true });
    return () => { cancelAnimationFrame(frame); resize.disconnect(); mounted.disconnect(); };
  }, []);

  // Where each comment's anchor is, relative to the row, and the passages to paint.
  const signature = notes.map((note) => `${note.id}:${note.state}`).join('|');
  useLayoutEffect(() => {
    const rowElement = row.current;
    if (!rowElement) return;
    const origin = rowElement.getBoundingClientRect().top;
    const next = new Map<string, number>();
    const ranges: { staged: Range[]; sent: Range[]; active: Range[] } = { staged: [], sent: [], active: [] };
    const marks = new Map<Element, CommentNote['state']>();
    anchors.current.clear();
    for (const note of notes) {
      const found = locateAnchor(rowElement, note.anchor);
      if (!found) continue;
      anchors.current.set(note.id, found);
      // A passage's first line, else the element's top.
      next.set(note.id, Math.round((found.range?.getClientRects()[0] ?? found.element.getBoundingClientRect()).top - origin));
      if (found.range) ranges[note.state].push(found.range);
      else if (found.whole && marks.get(found.whole) !== 'staged') marks.set(found.whole, note.state);
    }
    for (const element of marked.current) if (!marks.has(element)) element.removeAttribute('data-comment-marked');
    for (const [element, state] of marks) element.setAttribute('data-comment-marked', state);
    marked.current = new Set(marks.keys());
    painted.set(id, ranges);
    paint();
    setTops((current) => current.size === next.size && [...next].every(([key, top]) => current.get(key) === top) ? current : next);
  }, [signature, tick, wide, id]);
  useEffect(() => () => { painted.delete(id); paint(); for (const element of marked.current) element.removeAttribute('data-comment-marked'); }, [id]);

  // The anchor lit for the comment hovered or opened: its passage, else its element.
  const active = hover ?? focus;
  useEffect(() => {
    const found = active ? anchors.current.get(active) : undefined;
    const entry = painted.get(id);
    if (entry) { entry.active = found?.range ? [found.range] : []; paint(); }
    if (!found || found.range) return;
    found.element.setAttribute('data-comment-active', '');
    return () => found.element.removeAttribute('data-comment-active');
  }, [active, id, tops]);

  // Hovering or clicking a commented passage, item or tool row opens its comment; pressing elsewhere closes it.
  useEffect(() => {
    const rowElement = row.current;
    if (!rowElement || !shown) return;
    const hit = (event: MouseEvent): string | null => {
      if (!(event.target instanceof Element) || event.target.closest('[data-comment-margin]')) return null;
      for (const [key, found] of anchors.current) {
        if (found.range) {
          if ([...found.range.getClientRects()].some((rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)) return key;
        } else if (found.element.matches('[data-comment-item], [data-call], [data-comment-marked]') && found.element.contains(event.target)) return key;
      }
      return null;
    };
    let frame = 0;
    const move = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-comment-margin]')) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setHover(hit(event)));
    };
    const leave = (): void => setHover(null);
    // A click on a commented passage opens its comment and nothing else (not the block's full-screen view).
    const click = (event: MouseEvent): void => {
      const key = hit(event);
      if (!key || window.getSelection()?.toString()) return;
      event.preventDefault();
      setFocus(key);
    };
    const press = (event: PointerEvent): void => {
      if (event.target instanceof Element && (event.target.closest('[data-comment-margin], [data-comment-editor]') || hit(event))) return;
      setFocus(null);
      setOpenGroups(new Set());
    };
    rowElement.addEventListener('mousemove', move);
    rowElement.addEventListener('mouseleave', leave);
    rowElement.addEventListener('click', click, true);
    document.addEventListener('pointerdown', press, true);
    return () => {
      cancelAnimationFrame(frame);
      rowElement.removeEventListener('mousemove', move);
      rowElement.removeEventListener('mouseleave', leave);
      rowElement.removeEventListener('click', click, true);
      document.removeEventListener('pointerdown', press, true);
    };
  }, [shown]);

  const groups = groupsOf(notes, tops);
  const placed = stack(groups, heights, wide ? CARD_GAP : DOT_GAP, wide ? PILL_HEIGHT : 12);
  const measure = (key: string) => (element: HTMLElement | null): void => {
    if (!element) return;
    const height = Math.round(element.offsetHeight);
    if (heights.get(key) !== height) setHeights((current) => new Map(current).set(key, height));
  };
  const groupOpen = (group: Group): boolean => group.notes.length === 1 || openGroups.has(group.key) || group.notes.some((note) => note.id === active);
  const open = (group: Group, key?: string): void => { setOpenGroups((current) => new Set(current).add(group.key)); if (key) setFocus(key); };

  const column = <div data-comment-column="" className="relative min-w-0">
    {children}
    {layer ? <div data-comment-gutter="" className="pointer-events-none absolute inset-y-0 left-full [&>*]:pointer-events-auto" style={{ width: wide ? MARGIN_GAP : EDGE_GUTTER - DOT_STRIP }} /> : null}
  </div>;
  const dots = shown && !wide ? <div data-comment-margin="edge" className="pointer-events-none absolute inset-y-0 right-0" style={{ width: DOT_STRIP }}>
    {groups.map((group, index) => {
      const top = placed[index] ?? group.anchorTop;
      const staged = group.notes.some((note) => note.state === 'staged');
      const popover = focus !== null && group.notes.some((note) => note.id === focus);
      return <div key={group.key} className="pointer-events-auto absolute right-0" style={{ top }} ref={measure(group.key)}>
        <button type="button" data-comment-dot={group.notes.length} aria-label={`${group.notes.length} comment${group.notes.length === 1 ? '' : 's'} here: show`}
          onClick={() => { const first = group.notes[0]; if (first) open(group, first.id); }}
          onMouseEnter={() => setHover(group.notes[0]?.id ?? null)} onMouseLeave={() => setHover(null)}
          className="flex size-3 items-center justify-center rounded-full text-[8px] font-bold text-white shadow-sm ring-2 ring-background"
          style={{ background: staged ? 'var(--color-amber-500, #f59e0b)' : 'var(--muted-foreground)' }}>{group.notes.length > 1 ? group.notes.length : ''}</button>
        {/* Below the anchor's first line, so the commented text stays in view. */}
        {popover ? <div data-comment-margin="popover" className="absolute right-5 top-6 z-40 flex w-72 flex-col gap-1.5">
          {group.notes.map((note) => <Card key={note.id} note={note} author={author} onHover={(on) => setHover(on ? note.id : null)} onClose={() => setFocus(null)} />)}
        </div> : null}
      </div>;
    })}
  </div> : null;

  return <div ref={outer} className="w-full min-w-0">
    <div ref={row} data-comment-row="" className={reserved ? 'mx-auto flex w-full items-stretch' : 'relative w-full'} style={reserved ? { maxWidth: columnMax + MARGIN_WIDTH + MARGIN_GAP } : edge ? { paddingRight: EDGE_GUTTER } : undefined}>
      {reserved ? <div className="min-w-0 flex-1">{column}</div> : <>{column}{dots}</>}
      {reserved ? <aside data-comment-margin="wide" aria-label="Comments" className="relative shrink-0" style={{ width: MARGIN_WIDTH, marginLeft: MARGIN_GAP }}>
        {groups.map((group, index) => <div key={group.key} ref={measure(group.key)} className="absolute inset-x-0 flex flex-col gap-1.5 transition-[top] duration-150" style={{ top: placed[index] ?? group.anchorTop }}>
          {groupOpen(group) ? group.notes.map((note) => note.id === active
            ? <Card key={note.id} note={note} author={author} onHover={(on) => setHover(on ? note.id : null)} onClose={() => setFocus(null)} />
            : <Pill key={note.id} note={note} author={author} onOpen={() => open(group, note.id)} onHover={(on) => setHover(on ? note.id : null)} />)
            : <Stacked group={group} author={author} onOpen={() => open(group)} />}
        </div>)}
      </aside> : null}
    </div>
  </div>;
}
