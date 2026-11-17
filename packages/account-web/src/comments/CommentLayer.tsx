// Comments on what the agent wrote (docs/BLOCK-DOCUMENTS-DESIGN.md §3–§4): since the last message from a person or the
// project agent, the Goal, the Change Guide and drive docs. In a message: a passage selected anywhere (prose, or any text
// inside a block), a whole paragraph, heading, list item or quote (from an icon beside it), an item inside a block (a
// table row, a step, a CallDiff line, a Sequence frame, a checklist item), a whole block, or a tool call. Thinking and
// question blocks take none, and turns before that message take none: selecting text there shows a hint. In the Goal and
// the Guide: an entity (a requirement, decision, plan step, section or exhibit, CommentEntity), a passage or block inside
// one, or an exhibit's lines; in a drive doc (the entity `drive`): a passage or a block. These never lock. A comment is
// staged in the workspace (the runtime's staged comments, so it survives reloads and shows in every tab), shows as a chip
// above the composer and a pill in the margin (CommentMargin.tsx), and goes with the person's next message, which lists
// it. Sent comments come from the runtime's comment lookup, their notes from the person's messages and their answers from
// the agent's Reply blocks.
//
// The chat wraps each of the agent's messages in CommentMessage; a drawn block sets CommentBlock (and
// data-comment-block on its element) so its items and the selections inside it know where they are.
import type { TranscriptRow } from '@gitspace/blocks';
import { blockReplies } from '@gitspace/protocol/gitspace-ui';
import {
  COMMENT_EXACT_MAX, COMMENT_QUOTE_MAX, CommentsDocumentSchema, commentExcerpt, findTextQuote, messageComments, textQuoteAt,
  type CommentAnchor, type CommentDocument, type CommentLookup, type CommentTarget, type OpenDocumentKind, type SentComment,
} from '@gitspace/protocol-runtime/comments';
import type { RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { Badge, Button, useShape } from '@gitspace/ui';
import { Annotation, ArrowUpRight, ChevronRight, Trash01 } from '@untitledui/icons';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { EntityBlocks } from '../blocks/BlockDocument.js';
import { CommentLayer, DocumentComments, DocumentNavigation, type CommentLayerValue, type CommentNote, type CommentScopeValue, type DocumentNote } from './context.js';

/**
 * The rows that take new comments: the agent's stored messages and its tool calls in the turns of the comment window,
 * which starts at turn `windowStart` (the snapshot's `gitspace.comments`, null before the first message) and runs
 * through every later turn. A turn id ends in the ordinal of the input that opened it (`turnRowId`).
 */
export function openRows(rows: readonly TranscriptRow[], windowStart: string | null): Set<string> {
  const open = new Set<string>();
  if (windowStart === null) return open;
  const start = Number(windowStart.slice(windowStart.lastIndexOf(':') + 1));
  for (const { turnId, item } of rows) {
    if (!(Number(turnId.slice(turnId.lastIndexOf(':') + 1)) >= start)) continue;
    if ((item.type === 'message' && item.role === 'assistant' && !item.pending) || item.type === 'tool-call') open.add(item.id);
  }
  return open;
}

const NO_LOOKUP: CommentLookup = { comments: [], replies: [] };
/** Turns one lookup asks about: the newest loaded ones. */
const LOOKUP_TURNS = 256;
/** The documents whose comments the layer always reads, whichever turns are loaded: drive docs' only for the files
 * shown (`showDrive`). */
const OPEN_DOCUMENTS: OpenDocumentKind[] = ['goal', 'guide', 'drive'];
/** Pages of a row's text read for a comment on the Goal or the Guide whose message is not loaded. */
const ROW_PAGES = 8;

/** The whole text of a transcript row, read page by page; empty when the runtime returns none. */
async function rowText(request: (command: RuntimeSessionCommand) => Promise<RuntimeSessionResult>, generation: string, rowId: string): Promise<string> {
  let text = '';
  let offset: number | null = 0;
  for (let page = 0; offset !== null && page < ROW_PAGES; page++) {
    const content: RuntimeSessionResult['transcriptContent'] = (await request({ type: 'transcriptContent', request: { generation, rowId, offset } })).transcriptContent;
    if (!content) break;
    text += content.text;
    offset = content.nextOffset;
  }
  return text;
}

/** The comment layer of one open workspace's main conversation: its staged comments (the snapshot's
 * `gitspace.comments`), the sent ones on the loaded turns, on the Goal and the Change Guide and on the drive docs shown
 * (the runtime's lookup, asked again when its revision moves or another drive doc shows), and the loaded rows that take
 * new ones (in the document's comment window). A Goal, Guide or drive doc comment's note and replies are read from the
 * transcript when their messages are not loaded. */
export function CommentLayerProvider({ conversationId, document, rows, generation = null, request, author = 'You', children }: {
  conversationId: string | undefined;
  document: unknown;
  rows: readonly TranscriptRow[];
  /** The transcript's generation, which reads rows that are not loaded. */
  generation?: string | null;
  request(command: RuntimeSessionCommand): Promise<RuntimeSessionResult>;
  author?: string;
  children: ReactNode;
}) {
  const parsed = useMemo(() => CommentsDocumentSchema.safeParse(document ?? { staged: [], lookupRevision: 0 }), [document]);
  const staged = parsed.success ? parsed.data.staged : null;
  const revision = parsed.success ? parsed.data.lookupRevision : 0;
  const windowStart = parsed.success ? parsed.data.window : null;
  const turnIds = useMemo(() => [...new Set(rows.map((row) => row.turnId))].slice(-LOOKUP_TURNS), [rows]);
  const turnKey = turnIds.join('\n');
  // The drive docs shown, each with how many views show it.
  const shownDrives = useRef(new Map<string, number>());
  const [drivePaths, setDrivePaths] = useState<readonly string[]>([]);
  const showDrive = useCallback((path: string) => {
    const shown = shownDrives.current;
    shown.set(path, (shown.get(path) ?? 0) + 1);
    setDrivePaths([...shown.keys()].sort());
    return () => {
      const views = (shown.get(path) ?? 1) - 1;
      if (views > 0) shown.set(path, views);
      else shown.delete(path);
      setDrivePaths([...shown.keys()].sort());
    };
  }, []);
  const driveKey = drivePaths.join('\n');
  const [lookup, setLookup] = useState(NO_LOOKUP);
  const ask = useRef({ request, turnIds, drivePaths });
  ask.current = { request, turnIds, drivePaths };
  useEffect(() => {
    if (conversationId === undefined) return;
    let live = true;
    // A failed read keeps the comments already shown; the next revision or loaded turn asks again.
    ask.current.request({ type: 'commentLookup', turnIds: ask.current.turnIds, documents: OPEN_DOCUMENTS, drivePaths: [...ask.current.drivePaths] }).then((result) => { if (live && result.commentLookup) setLookup(result.commentLookup); }, () => {});
    return () => { live = false; };
  }, [conversationId, turnKey, revision, driveKey]);
  const byRow = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  // The rows a Goal, Guide or drive doc comment needs that are not loaded: the person's message carrying it and the
  // replies to it.
  const [read, setRead] = useState<ReadonlyMap<string, string>>(new Map());
  const reading = useRef(new Set<string>());
  const unloaded = useMemo(() => {
    const documentComments = lookup.comments.filter((comment) => comment.anchor.document.kind !== 'turn');
    const ids = new Set(documentComments.map((comment) => comment.id));
    return [...new Set([...documentComments.map((comment) => comment.message), ...lookup.replies.filter((reply) => ids.has(reply.comment)).map((reply) => reply.row)])]
      .filter((row) => !byRow.has(row)).sort();
  }, [lookup, byRow]);
  const unloadedKey = unloaded.join('\n');
  useEffect(() => {
    if (generation === null) return;
    for (const row of unloaded) {
      if (reading.current.has(row)) continue;
      reading.current.add(row);
      rowText(ask.current.request, generation, row).then((text) => setRead((current) => new Map(current).set(row, text)), () => { reading.current.delete(row); });
    }
  }, [unloadedKey, generation]);
  const notes = useMemo((): CommentNote[] => {
    if (conversationId === undefined) return [];
    const textOf = (row: string): string | null => {
      const item = byRow.get(row)?.item;
      return item?.type === 'message' ? item.text : read.get(row) ?? null;
    };
    const sent = lookup.comments.filter((comment) => comment.conversationId === conversationId).map((comment): CommentNote => {
      const message = textOf(comment.message);
      const carried = message === null ? undefined : messageComments(message).find((each) => each.id === comment.id);
      const replies = lookup.replies.filter((reply) => reply.comment === comment.id).map((reply) => {
        const text = textOf(reply.row);
        return { row: reply.row, text: text === null ? null : blockReplies(text).find((each) => each.comment === comment.id)?.text ?? null };
      });
      return { id: comment.id, anchor: comment.anchor, note: carried?.note ?? null, state: 'sent', replies };
    });
    const sentIds = new Set(sent.map((note) => note.id));
    const waiting = (staged ?? []).filter(({ id, anchor: { document } }) => (document.kind !== 'turn' || document.conversationId === conversationId) && !sentIds.has(id))
      .map((comment): CommentNote => ({ id: comment.id, anchor: comment.anchor, note: comment.note, state: 'staged', replies: [] }));
    return [...sent, ...waiting];
  }, [conversationId, lookup, byRow, read, staged]);
  const open = useMemo(() => openRows(rows, windowStart), [rows, windowStart]);
  const turnOf = useCallback((row: string) => byRow.get(row)?.turnId, [byRow]);
  const stage = useCallback(async (scope: Pick<CommentScopeValue, 'row' | 'document'>, target: CommentTarget, quote: string, note: string) => {
    const turnId = byRow.get(scope.row)?.turnId;
    let where: CommentDocument | null = scope.document;
    if (where === null && conversationId !== undefined && turnId !== undefined) where = { kind: 'turn', conversationId, turnId };
    if (where === null) throw new Error('Comments go on what the agent wrote since the last message');
    await request({ type: 'stageComment', anchor: { document: where, target, quote: commentExcerpt(quote, COMMENT_QUOTE_MAX) }, note });
  }, [byRow, conversationId, request]);
  const edit = useCallback(async (id: string, note: string) => { await request({ type: 'editComment', id, note }); }, [request]);
  const remove = useCallback(async (id: string) => { await request({ type: 'unstageComment', id }); }, [request]);
  const value = useMemo((): CommentLayerValue | null => conversationId === undefined ? null : { conversationId, notes, open, turnOf, author, stage, edit, remove, showDrive },
    [conversationId, notes, open, turnOf, author, stage, edit, remove, showDrive]);
  return <CommentLayer.Provider value={value}>{children}</CommentLayer.Provider>;
}

/** The message, tool call or Goal or Guide entity a part of the page belongs to, and whether it takes new comments. */
export const CommentScope = createContext<CommentScopeValue | null>(null);

/** Set by a drawn block for its items and the selections inside it: the block's key in the turn (`blockKey`), what it is
 * called ("StateFlow: Login"), and whether it asks a question (no comments). */
export interface CommentBlockValue { key: string; kind: string; title: string | null; asks: boolean }
export const CommentBlock = createContext<CommentBlockValue | null>(null);

/** A block's key in its turn: its message row and its root element's id, or a hash of its root element when it has
 * none. */
export function blockKey(messageRow: string, root: unknown, id: string | null): string {
  if (id !== null) return `${messageRow}#${id}`;
  let hash = 2166136261;
  for (const character of JSON.stringify(root ?? null)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return `${messageRow}#@${hash.toString(16)}`;
}

/** What people call a Goal or Guide entity by the prefix of its ref. */
const ENTITY_LABEL: Record<string, string> = { 'tool-call': 'Tool call', requirement: 'Requirement', decision: 'Decision', step: 'Plan step', section: 'Guide section', exhibit: 'Exhibit' };

/** What people call a comment's place. */
export function anchorLabel(anchor: CommentAnchor): string {
  const { target } = anchor;
  if (target.kind === 'item') return target.label;
  if (target.kind === 'entity') return ENTITY_LABEL[target.ref.split(':')[0] ?? ''] ?? 'Entity';
  if (target.kind === 'block') return 'Block';
  if (target.kind === 'lines') return target.start === target.end ? `Line ${target.start}` : `Lines ${target.start}–${target.end}`;
  if (target.kind === 'time') return `At ${Math.floor(target.seconds / 60)}:${String(Math.floor(target.seconds % 60)).padStart(2, '0')}`;
  if (target.kind === 'frame') return `Frame ${target.index + 1}`;
  return 'Passage';
}

/** The Goal or Guide entity a comment is in (`requirement:<id>`, `exhibit:<section>:<path>`, …): its entity, the exhibit
 * of its lines, or the entity a block or passage is in (a block key `<entity>#<element id>`). */
export function anchorEntity(anchor: CommentAnchor): string | null {
  const { target } = anchor;
  const ref = target.kind === 'entity' ? target.ref : target.kind === 'lines' ? target.exhibit : target.kind === 'text' ? target.within : target.kind === 'block' ? target.id : target.block;
  return ref === null ? null : ref.split('#')[0] ?? null;
}

/** Text the comment layer draws: never part of a quote. */
const COMMENT_UI = '[data-comment-ui], [data-comment-editor]';
const BLOCK_TAGS: Record<string, true> = { P: true, LI: true, DIV: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true, TD: true, TH: true, TR: true, PRE: true, BLOCKQUOTE: true, SECTION: true, ARTICLE: true, FIGURE: true, FIGCAPTION: true, UL: true, OL: true, TABLE: true };

/** An element's text as quotes read it: runs of white space as one space, a space between blocks; `places` maps each
 * character back to the text node and offset it came from; `breaks`: where in `text` each block after the first starts,
 * which bounds a quote's prefix and suffix (`textQuoteAt`). */
export interface FlatText { text: string; places: readonly { node: Text; offset: number }[]; nodes: readonly { node: Text; offsets: readonly number[] }[]; breaks: readonly number[] }

function blockOf(node: Node): Element | null {
  let element = node.parentElement;
  while (element && !BLOCK_TAGS[element.tagName]) element = element.parentElement;
  return element;
}

export function flatText(within: Element): FlatText {
  const walker = document.createTreeWalker(within, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement?.closest(COMMENT_UI) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const places: { node: Text; offset: number }[] = [];
  const nodes: { node: Text; offsets: number[] }[] = [];
  const breaks: number[] = [];
  let text = '';
  let previous: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue;
    // A new block starts a new word.
    if (previous && text && blockOf(previous) !== blockOf(node)) {
      if (!text.endsWith(' ')) { text += ' '; places.push({ node: previous, offset: previous.data.length }); }
      if (breaks[breaks.length - 1] !== text.length) breaks.push(text.length);
    }
    const offsets: number[] = [];
    for (let offset = 0; offset < node.data.length; offset++) {
      offsets.push(text.length);
      const space = /\s/u.test(node.data[offset] ?? '');
      if (space && (text.endsWith(' ') || text.length === 0)) continue;
      text += space ? ' ' : node.data[offset];
      places.push({ node, offset });
    }
    offsets.push(text.length);
    nodes.push({ node, offsets });
    previous = node;
  }
  return { text, places, nodes, breaks };
}

/** The index in `flat` of a DOM boundary point inside its element. */
export function flatOffset(flat: FlatText, container: Node, offset: number): number {
  if (container instanceof Text) {
    const entry = flat.nodes.find((each) => each.node === container);
    if (entry) return entry.offsets[Math.min(offset, entry.offsets.length - 1)] ?? flat.text.length;
  }
  const point = document.createRange();
  point.setStart(container, offset);
  // The first text node at or after the point.
  const next = flat.nodes.find((each) => point.comparePoint(each.node, 0) >= 0);
  return next ? next.offsets[0] ?? flat.text.length : flat.text.length;
}

/** The DOM range of `flat.text[start, end)`. */
export function flatRange(flat: FlatText, start: number, end: number): Range | null {
  const first = flat.places[start];
  const last = flat.places[end - 1];
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, Math.min(last.offset + 1, last.node.data.length));
  return range;
}

/** A text target for `[start, end)` of `within`'s text, trimmed of spaces at both ends; null for less than 2 characters. */
function textTarget(flat: FlatText, start: number, end: number, within: string): { target: CommentTarget; quote: string } | null {
  let from = start;
  let to = Math.min(end, start + COMMENT_EXACT_MAX);
  while (from < to && flat.text[from] === ' ') from++;
  while (to > from && flat.text[to - 1] === ' ') to--;
  if (to - from < 2) return null;
  const quote = textQuoteAt(flat.text, from, to, flat.breaks);
  return { target: { kind: 'text', within, ...quote }, quote: quote.exact };
}

/** The element a comment's target names inside `root`: the message, the block, its item, the tool call, or the Goal,
 * Guide or drive doc entity (an exhibit for its lines). */
export function targetElement(root: ParentNode, target: CommentTarget): Element | null {
  const named = (attribute: string, value: string) => root.querySelector(`[${attribute}="${CSS.escape(value)}"]`);
  if (target.kind === 'entity') {
    const row = target.ref.startsWith('tool-call:') ? target.ref.slice('tool-call:'.length) : null;
    return row === null ? named('data-comment-target', target.ref) : named('data-call', row) ?? root.querySelector(`[data-comment-calls~="${CSS.escape(row)}"]`);
  }
  if (target.kind === 'lines') return named('data-comment-target', target.exhibit);
  if (target.kind === 'text') {
    if (target.within?.startsWith('message:')) return named('data-comment-target', target.within.slice('message:'.length));
    return target.within === null ? null : named('data-comment-block', target.within) ?? named('data-comment-target', target.within);
  }
  const block = named('data-comment-block', target.kind === 'block' ? target.id : target.block);
  if (target.kind === 'item') return block?.querySelector(`[data-comment-item="${CSS.escape(target.path)}"]`) ?? block;
  return block;
}

/** Paragraphs, headings, list items and quotes of the agent's prose, never inside a block, an item, a drawing (a
 * Mermaid diagram's labels are paragraphs in its SVG) or the comment UI. */
const PROSE = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';
const NOT_PROSE = '[data-comment-block], [data-comment-item], [data-comment-ui], [data-comment-editor], [data-call], svg';

/** Where a comment is on the page: the element it names, and for a passage its range; `whole`: the passage is all of a
 * paragraph, heading, list item or quote, which is marked rather than its text highlighted. Null when it is not drawn
 * or its passage is gone (outdated). */
export function locateAnchor(root: ParentNode, anchor: CommentAnchor): { element: Element; range: Range | null; whole: Element | null } | null {
  const element = targetElement(root, anchor.target);
  if (!element) return null;
  if (anchor.target.kind !== 'text') return { element, range: null, whole: null };
  const flat = flatText(element);
  const found = findTextQuote(flat.text, anchor.target, flat.breaks);
  const range = found ? flatRange(flat, found.start, found.end) : null;
  if (!range) return null;
  const container = range.commonAncestorContainer;
  const prose = (container instanceof Element ? container : container.parentElement)?.closest(PROSE) ?? null;
  const whole = prose && !prose.closest(NOT_PROSE) && element.contains(prose) && (prose.textContent ?? '').replace(/\s+/gu, ' ').trim() === anchor.target.exact ? prose : null;
  return { element: whole ?? element, range: whole ? null : range, whole };
}

/** Scrolls the page to what a comment is about, when it is drawn. */
export function showAnchor(anchor: CommentAnchor): void {
  const found = locateAnchor(document, anchor);
  (found?.whole ?? found?.range?.startContainer.parentElement ?? found?.element)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Frames to wait for the Inspector to draw a Goal or Guide anchor after opening it. */
const NAVIGATION_FRAMES = 90;

/** Shows what a comment is about: in the chat, scrolls to it; on the Goal or the Guide, opens it in the Inspector first
 * and scrolls once it is drawn; on a drive doc, opens the file in the Inspector, which scrolls to it once drawn
 * (DriveDocument). */
export function useShowAnchor(): (anchor: CommentAnchor) => void {
  const navigate = useContext(DocumentNavigation);
  return useCallback((anchor: CommentAnchor) => {
    if (anchor.document.kind === 'turn' || !navigate) { showAnchor(anchor); return; }
    navigate(anchor);
    if (anchor.document.kind === 'drive') return;
    let frames = 0;
    const scroll = (): void => {
      if (locateAnchor(document, anchor)) showAnchor(anchor);
      else if (frames++ < NAVIGATION_FRAMES) requestAnimationFrame(scroll);
    };
    requestAnimationFrame(scroll);
  }, [navigate]);
}

/** The comments here: a block's (`block`), an item's of it (`path`), or a tool call's (`call`); in a Goal, Guide or
 * drive doc, among the comments it shows (another drive doc's blocks have the same keys). */
export function useCommentsAt(place: { block: string; path?: string } | { call: string }): CommentNote[] {
  const layer = useContext(CommentLayer);
  const shown = useContext(DocumentComments)?.notes ?? layer?.notes;
  return useMemo(() => (shown ?? []).filter(({ anchor: { target } }) => {
    if ('call' in place) return target.kind === 'entity' && target.ref === `tool-call:${place.call}`;
    if (place.path !== undefined) return target.kind === 'item' && target.block === place.block && target.path === place.path;
    if (target.kind === 'block') return target.id === place.block;
    if (target.kind === 'text') return target.within === place.block;
    return (target.kind === 'item' || target.kind === 'time' || target.kind === 'frame') && target.block === place.block;
  }), [shown, 'call' in place ? place.call : place.block, 'path' in place ? place.path : undefined]);
}

/** Where a note editor opens: what it is about (`place`), and the chat's comment margin when it is drawn beside the
 * column. */
interface EditorAt { place: DOMRect; margin: DOMRect | null }

const EDITOR_WIDTH = 320;
const EDITOR_HEIGHT = 200;
/** The Comment button and the hint go above a selection when this much of the window is above it, else below it. */
const ROOM_ABOVE = 96;

/** The editor for something on the page: level with `place` (by default the item, tool row or element itself). */
function editorAt(element: Element, place?: DOMRect): EditorAt {
  const around = element.closest('[data-comment-item]') ?? element.closest('[data-call]') ?? element;
  return { place: place ?? around.getBoundingClientRect(), margin: element.closest('[data-comment-row]')?.querySelector('[data-comment-margin="wide"]')?.getBoundingClientRect() ?? null };
}

/** In the margin, level with what it is about, when the margin is drawn; else under the anchored text, or above it near
 * the bottom of the window: never over what it is about. */
function editorStyle({ place, margin }: EditorAt): CSSProperties {
  if (margin) return { position: 'fixed', left: margin.left, width: margin.width, top: Math.max(8, Math.min(place.top, window.innerHeight - EDITOR_HEIGHT - 8)) };
  const left = Math.max(8, Math.min(place.left, window.innerWidth - EDITOR_WIDTH - 16));
  if (place.bottom + 8 + EDITOR_HEIGHT <= window.innerHeight) return { position: 'fixed', left, top: place.bottom + 8 };
  return { position: 'fixed', left, top: Math.max(8, place.top - EDITOR_HEIGHT - 8) };
}

/** Where note editors open instead of beside what they are about: the lightbox's comment panel (a modal dialog takes no
 * input outside itself). */
export const CommentEditorHost = createContext<HTMLElement | null>(null);

/** A note being written: a small card beside the place it is about, with the quoted text above the box; in a lightbox,
 * in its comment panel. Saving stages it; a refusal shows in the card. */
function NoteEditor({ quote, label, at, onSave, onCancel }: { quote: string | null; label: string; at: EditorAt; onSave(note: string): Promise<void>; onCancel(): void }) {
  const shape = useShape();
  const host = useContext(CommentEditorHost);
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<{ saving: boolean; error: string | null }>({ saving: false, error: null });
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  const save = (): void => {
    if (!draft.trim() || state.saving) return;
    setState({ saving: true, error: null });
    onSave(draft.trim()).catch((failure: unknown) => setState({ saving: false, error: failure instanceof Error ? failure.message : String(failure) }));
  };
  return createPortal(<div role="dialog" aria-label={`Comment on ${label}`} data-comment-editor=""
    className={`${shape.container} z-50 flex flex-col gap-2 border border-border bg-background p-2.5 text-left shadow-lg ${host ? 'w-full' : 'w-80 max-w-[calc(100vw-2rem)]'}`}
    style={host ? undefined : editorStyle(at)}
    onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') onCancel(); if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save(); }}
    onClick={(event) => event.stopPropagation()}>
    <span className="flex items-center gap-1.5 text-caption font-medium text-muted-foreground"><Annotation width={13} height={13} />{label}</span>
    {quote ? <blockquote className="border-l-2 border-border pl-2 text-caption italic text-muted-foreground [overflow-wrap:anywhere]">{commentExcerpt(quote, 160)}</blockquote> : null}
    {/* FLUID-GAP: multi-line textarea — the registry has no textarea field. */}
    <textarea ref={box} aria-label="Your comment" placeholder="Your comment" rows={3} value={draft} onChange={(event) => setDraft(event.currentTarget.value)}
      className={`${shape.input} w-full resize-y border border-border bg-surface-2 px-2.5 py-1.5 text-body text-foreground`} />
    {state.error ? <p role="alert" className="text-caption text-destructive">{state.error}</p> : null}
    <div className="flex items-center gap-2">
      <Button variant="primary" size="compact" type="button" disabled={!draft.trim() || state.saving} onClick={save}>Comment</Button>
      <Button variant="ghost" size="compact" type="button" onClick={onCancel}>Cancel</Button>
    </div>
  </div>, host ?? document.body);
}

/** What a trigger stages: the target and the quote, taken when the editor opens so a playing Sequence moving on does not
 * move the comment with it. */
interface Pending { at: EditorAt; label: string; quote: string | null; target: CommentTarget }

/** The comment icon of something in a commentable message, and its editor, which opens beside `around` (by default the
 * item or tool row the icon is in). */
function CommentTrigger({ label, quote, targetFor, around, className = '', children }: { label: string; quote: string | null; targetFor: () => CommentTarget; around?: Element | null; className?: string; children?: ReactNode }) {
  const layer = useContext(CommentLayer);
  const scope = useContext(CommentScope);
  const [open, setOpen] = useState<Pending | null>(null);
  if (!layer || !scope) return null;
  return <>
    <button type="button" aria-label={`Comment on ${label}`} title="Comment" data-comment-trigger="" data-comment-ui=""
      onClick={(event) => { event.stopPropagation(); setOpen({ at: editorAt(around ?? event.currentTarget), label, quote, target: targetFor() }); }}
      className={`inline-flex shrink-0 items-center gap-1 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-surface-2 hover:text-foreground ${className}`}>
      <Annotation width={13} height={13} />{children}
    </button>
    {open ? <NoteEditor quote={open.quote} label={open.label} at={open.at} onCancel={() => setOpen(null)}
      onSave={async (note) => { await layer.stage(scope, open.target, open.quote ?? open.label, note); setOpen(null); }} /> : null}
  </>;
}

/** A comment icon's side; it fits the gutter (CommentMargin.tsx). */
const HANDLE_SIZE = 16;
/** How long an icon stays after the pointer leaves what it is for, so the pointer can cross to it. */
const HANDLE_LINGER = 250;

interface Box { top: number; width: number; height: number }

/** Where a comment icon goes in the gutter, relative to the gutter: centred across it, level with the middle of the
 * first line of what it is for. */
export function gutterSlot(gutter: Box, line: Box): { left: number; top: number } {
  return { left: (gutter.width - HANDLE_SIZE) / 2, top: line.top - gutter.top + (line.height - HANDLE_SIZE) / 2 };
}

/** The gutter right of the chat's column that `element` is in, where its comment icons go: outside the text. */
function gutterOf(element: Element): HTMLElement | null {
  return element.closest('[data-comment-column]')?.querySelector<HTMLElement>(':scope > [data-comment-gutter]') ?? null;
}

/** The element's first line of text (its first drawn text node's first line, not the box of a child that holds more
 * than one line), else its box. */
function firstLine(element: Element): DOMRect {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || node.parentElement?.closest(COMMENT_UI)) continue;
    range.selectNodeContents(node);
    const line = [...range.getClientRects()].find((rect) => rect.width > 0 && rect.height > 0);
    if (line) return line;
  }
  return element.getBoundingClientRect();
}

/** The pointer cannot hover (touch): every icon shows, dimmed. */
function useTouch(): boolean {
  const [touch, setTouch] = useState(() => window.matchMedia('(hover: none)').matches);
  useEffect(() => {
    const media = window.matchMedia('(hover: none)');
    const change = (): void => setTouch(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return touch;
}

/** The comment icon of the item or tool row (`anchor`, a selector) this is in: in the column's gutter level with its
 * first line while it is hovered; with no gutter (a lightbox), inline with `inlineClassName`. */
function GutterTrigger({ anchor: selector, inlineClassName, ...trigger }: { anchor: string; inlineClassName: string; label: string; quote: string | null; targetFor: () => CommentTarget }) {
  const touch = useTouch();
  const [marker, setMarker] = useState<HTMLSpanElement | null>(null);
  const [slot, setSlot] = useState<{ left: number; top: number } | null>(null);
  const linger = useRef(0);
  const anchor = marker?.closest(selector) ?? marker?.parentElement ?? null;
  const gutter = marker ? gutterOf(marker) : null;
  useEffect(() => {
    if (!anchor || !gutter) return;
    const place = (): void => { window.clearTimeout(linger.current); setSlot(gutterSlot(gutter.getBoundingClientRect(), firstLine(anchor))); };
    if (touch) {
      place();
      const observer = new ResizeObserver(place);
      observer.observe(gutter);
      return () => observer.disconnect();
    }
    const leave = (): void => { linger.current = window.setTimeout(() => setSlot(null), HANDLE_LINGER); };
    anchor.addEventListener('mouseenter', place);
    anchor.addEventListener('mouseleave', leave);
    return () => { window.clearTimeout(linger.current); anchor.removeEventListener('mouseenter', place); anchor.removeEventListener('mouseleave', leave); };
  }, [anchor, gutter, touch]);
  return <>
    <span ref={setMarker} hidden />
    {gutter ? slot ? createPortal(<span data-comment-ui="" data-gutter-handle="" className="absolute z-10 flex" style={slot}
      onMouseEnter={() => window.clearTimeout(linger.current)}
      onMouseLeave={() => { if (!touch) linger.current = window.setTimeout(() => setSlot(null), HANDLE_LINGER); }}>
      <CommentTrigger {...trigger} around={anchor} className={`size-4 justify-center p-0 ${touch ? 'opacity-60' : ''}`} />
    </span>, gutter) : null : marker ? <CommentTrigger {...trigger} className={inlineClassName} /> : null}
  </>;
}

/** How many comments, amber while one is staged. */
function CommentCount({ notes }: { notes: readonly CommentNote[] }) {
  if (notes.length === 0) return null;
  const staged = notes.some((note) => note.state === 'staged');
  return <span data-comment-ui="" className="rounded-full px-1 text-[10px] font-semibold tabular-nums text-white" style={{ background: staged ? 'var(--color-amber-500, #f59e0b)' : 'var(--muted-foreground)' }} title={`${notes.length} comment${notes.length === 1 ? '' : 's'}`}>{notes.length}</span>;
}

/** The data attributes that make an element an item of a block: a selection inside it is in it, and its ItemComment icon
 * shows while it is hovered. */
export function commentItem(path: string, label: string): { 'data-comment-item': string; 'data-comment-label': string } {
  return { 'data-comment-item': path, 'data-comment-label': label };
}

/** An item's comment icon (in the column's gutter while its row, marked `group/item`, is hovered) and how many comments
 * it has. */
export function ItemComment({ path, label, quote }: { path: string; label: string; quote: string | null }) {
  const block = useContext(CommentBlock);
  const scope = useContext(CommentScope);
  const notes = useCommentsAt({ block: block?.key ?? '', path });
  if (!block || block.asks || !scope || (!scope.editable && notes.length === 0)) return null;
  const name = `${block.kind} ${label}`;
  return <span className="inline-flex shrink-0 items-center gap-0.5 align-middle" data-comment-ui="">
    <CommentCount notes={notes} />
    {scope.editable ? <GutterTrigger anchor="[data-comment-item]" label={name} quote={quote} inlineClassName="opacity-0 focus-visible:opacity-100 group-hover/item:opacity-100 [@media(hover:none)]:opacity-60"
      targetFor={() => ({ kind: 'item', block: block.key, path, label: name.slice(0, 120) })} /> : null}
  </span>;
}

/** The block's own comment button, among the block's hover actions. Question blocks have none. */
export function BlockCommentButton() {
  const block = useContext(CommentBlock);
  const scope = useContext(CommentScope);
  if (!block || block.asks || !scope?.editable) return null;
  const quote = block.title ? `${block.kind}: ${block.title}` : block.kind;
  return <span className="inline-flex size-7 items-center justify-center rounded-md bg-surface-2 shadow-surface-1">
    <CommentTrigger label={`this ${block.kind}`} quote={quote} targetFor={() => ({ kind: 'block', id: block.key })} />
  </span>;
}

/** Under a block with comments: how many, and where they are. */
export function BlockMarker() {
  const block = useContext(CommentBlock);
  const notes = useCommentsAt({ block: block?.key ?? '' });
  if (!block || notes.length === 0) return null;
  const staged = notes.some((note) => note.state === 'staged');
  return <span data-comment-ui="" data-comment-marker={block.key} className="flex w-fit items-center gap-1 px-1 text-[11px] text-muted-foreground" title={`${notes.length} comment${notes.length === 1 ? '' : 's'} on this ${block.kind}, in the margin`}>
    <Annotation width={12} height={12} style={{ color: staged ? 'var(--color-amber-500, #f59e0b)' : undefined }} />{notes.length} on this {block.kind}
  </span>;
}

/** A tool call's row comment ("why this command?"): an icon in the column's gutter while the row is hovered, and a
 * count on the row (which is positioned). Its output takes no comments. */
export function CallComment({ id, tool, target }: { id: string; tool: string; target: string }) {
  const layer = useContext(CommentLayer);
  const notes = useCommentsAt({ call: id });
  const editable = layer?.open.has(id) ?? false;
  const scope = useMemo(() => ({ row: id, editable, document: null }), [id, editable]);
  if (!layer || (!editable && notes.length === 0)) return null;
  return <CommentScope.Provider value={scope}><span data-comment-ui="" className="absolute right-16 top-0 flex h-7 items-center gap-0.5">
    <CommentCount notes={notes} />
    {editable ? <GutterTrigger anchor="[data-call]" label={`${tool} call`} quote={target ? `${tool} ${target}` : tool} inlineClassName="bg-surface-2 opacity-0 focus-visible:opacity-100 group-hover/item:opacity-100 [@media(hover:none)]:opacity-60"
      targetFor={() => ({ kind: 'entity', ref: `tool-call:${id}` })} /> : null}
  </span></CommentScope.Provider>;
}

/** How many comments are on any of these tool calls: a tool group's, for its header. */
export function useCallCommentCount(calls: readonly string[]): number {
  const layer = useContext(CommentLayer);
  return (layer?.notes ?? []).filter(({ anchor: { target } }) => target.kind === 'entity' && calls.some((call) => target.ref === `tool-call:${call}`)).length;
}

interface ProseHandle { element: Element; label: string; quote: string; left: number; top: number }

/** The prose of a commentable part (`target`, a message or an entity), not that of an entity drawn inside it. */
function proseElements(target: Element): Element[] {
  return [...target.querySelectorAll(PROSE)].filter((element) => !element.closest(NOT_PROSE) && element.closest('[data-comment-target]') === target && !(element.tagName === 'P' && element.parentElement?.tagName === 'LI'));
}

function proseLabel(element: Element): string {
  if (/^H[1-6]$/u.test(element.tagName)) return 'Heading';
  if (element.tagName === 'LI') return 'List item';
  if (element.tagName === 'BLOCKQUOTE') return 'Quote';
  return 'Paragraph';
}

/** The icon for one prose element: in the gutter, level with its first line. */
function proseHandle(gutter: Element, element: Element): ProseHandle {
  const label = proseLabel(element);
  return { element, label, quote: commentExcerpt(element.textContent ?? '', COMMENT_QUOTE_MAX), ...gutterSlot(gutter.getBoundingClientRect(), firstLine(element)) };
}

/** The comment icons of a message's or an entity's prose, in the column's gutter: the hovered element's (kept while the
 * pointer crosses to it); with no hover (touch), every element's, dimmed, as item icons are. */
function ProseHandles({ container, scope }: { container: HTMLDivElement; scope: CommentScopeValue }) {
  const layer = useContext(CommentLayer);
  const touch = useTouch();
  const gutter = gutterOf(container);
  const [hovered, setHovered] = useState<ProseHandle | null>(null);
  const [all, setAll] = useState<readonly ProseHandle[]>([]);
  const [editing, setEditing] = useState<{ handle: ProseHandle; at: EditorAt } | null>(null);
  const linger = useRef(0);
  const current = useRef<Element | null>(null);
  const clearSoon = useCallback((): void => {
    window.clearTimeout(linger.current);
    linger.current = window.setTimeout(() => { current.current = null; setHovered(null); }, HANDLE_LINGER);
  }, []);
  useEffect(() => {
    if (touch || !gutter) return;
    const move = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return;
      const start = event.target.closest(PROSE);
      const prose = start?.tagName === 'P' && start.parentElement?.tagName === 'LI' ? start.parentElement : start;
      if (prose && prose === current.current) { window.clearTimeout(linger.current); return; }
      if (!prose || !container.contains(prose) || prose.closest(NOT_PROSE) || prose.closest('[data-comment-target]') !== container) { clearSoon(); return; }
      window.clearTimeout(linger.current);
      current.current = prose;
      setHovered(proseHandle(gutter, prose));
    };
    container.addEventListener('mousemove', move);
    container.addEventListener('mouseleave', clearSoon);
    return () => { window.clearTimeout(linger.current); container.removeEventListener('mousemove', move); container.removeEventListener('mouseleave', clearSoon); };
  }, [container, gutter, touch, clearSoon]);
  useLayoutEffect(() => {
    if (!touch || !gutter) return;
    const update = (): void => setAll(proseElements(container).map((prose) => proseHandle(gutter, prose)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, gutter, touch]);
  if (!layer || !gutter) return null;
  const shown = touch ? all : hovered ? [hovered] : [];
  return <>
    {createPortal(shown.map((handle, index) => <button key={index} type="button" data-prose-handle="" data-comment-ui="" aria-label={`Comment on this ${handle.label.toLowerCase()}`} title="Comment"
      className={`absolute z-10 flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:opacity-100 ${touch ? 'opacity-60' : ''}`}
      style={{ left: handle.left, top: handle.top }}
      onMouseEnter={() => window.clearTimeout(linger.current)} onMouseLeave={() => { if (!touch) clearSoon(); }}
      onClick={(event) => { event.stopPropagation(); setEditing({ handle, at: editorAt(handle.element) }); }}>
      <Annotation width={13} height={13} />
    </button>), gutter)}
    {editing ? <NoteEditor quote={editing.handle.quote} label={editing.handle.label} at={editing.at} onCancel={() => setEditing(null)}
      onSave={async (note) => {
        const flat = flatText(container);
        const { element } = editing.handle;
        // A message's passage is within the message; an entity's within the entity.
        const chosen = textTarget(flat, flatOffset(flat, element, 0), flatOffset(flat, element, element.childNodes.length), scope.document ? scope.row : `message:${scope.row}`);
        if (!chosen) throw new Error('This has no text to comment on');
        await layer.stage(scope, chosen.target, chosen.quote, note);
        setEditing(null);
      }} /> : null}
  </>;
}

/** A selection in a commentable message: where its Comment button goes and what it is anchored to. */
interface Selected { rect: DOMRect; target: CommentTarget; quote: string; label: string }

/**
 * A commentable part of a message (the message, or a block in its lightbox) or of a Goal or Guide entity: selecting text
 * in it shows a Comment button once the pointer is up, so dragging is never interrupted. A selection inside one block is
 * anchored to that block, else to the message or entity; one inside an entity drawn within this part is that entity's.
 * Question blocks take no comments. Where the message takes no new comments (before the last message), a selection
 * shows a hint instead. The button is drawn without moving any text.
 */
export function SelectionComments({ className = '', children }: { className?: string; children: ReactNode }) {
  const layer = useContext(CommentLayer);
  const scope = useContext(CommentScope);
  const container = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<Selected | null>(null);
  const [hint, setHint] = useState<DOMRect | null>(null);
  const [editing, setEditing] = useState<{ selected: Selected; at: EditorAt } | null>(null);
  // The listeners read the latest scope; they are attached once.
  const latest = useRef(scope);
  latest.current = scope;
  useEffect(() => {
    let pointerDown = false;
    const update = (): void => {
      const element = container.current;
      const here = latest.current;
      const current = window.getSelection();
      if (!element || !here || !current || current.isCollapsed || current.rangeCount === 0) { setSelection(null); setHint(null); return; }
      const range = current.getRangeAt(0);
      const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
      const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
      if (!start || !end || !element.contains(start) || !element.contains(end)) { setSelection(null); setHint(null); return; }
      const owner = element.closest('[data-comment-target]');
      if (owner && (start.closest('[data-comment-target]') !== owner || end.closest('[data-comment-target]') !== owner)) { setSelection(null); setHint(null); return; }
      // While the pointer is down, the person is still selecting: show nothing yet.
      if (pointerDown) return;
      if ([start, end].some((edge) => edge.closest('[data-comment-ui], [data-comment-editor], [data-comment-ask]'))) { setSelection(null); setHint(null); return; }
      const rect = range.getBoundingClientRect();
      if (!here.editable) { setSelection(null); setHint(current.toString().trim().length > 1 ? rect : null); return; }
      const startBlock = start.closest('[data-comment-block]');
      const block = startBlock && startBlock === end.closest('[data-comment-block]') ? startBlock : null;
      const within = block ?? element.closest('[data-comment-target]') ?? element;
      const flat = flatText(within);
      const key = block?.getAttribute('data-comment-block');
      const chosen = textTarget(flat, flatOffset(flat, range.startContainer, range.startOffset), flatOffset(flat, range.endContainer, range.endOffset), key ?? (here.document ? here.row : `message:${here.row}`));
      setHint(null);
      setSelection(chosen ? { rect, ...chosen, label: block ? `${block.getAttribute('data-comment-kind') ?? 'Block'} · selection` : 'Selection' } : null);
    };
    const down = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-comment-ui], [data-comment-editor]')) return;
      pointerDown = true;
    };
    const up = (): void => {
      pointerDown = false;
      // The selection settles after the pointer is released (a double or triple click extends it then).
      requestAnimationFrame(update);
    };
    document.addEventListener('selectionchange', update);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    return () => {
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
    };
  }, []);
  if (!layer || !scope) return <>{children}</>;
  const box = container.current?.getBoundingClientRect();
  return <div ref={container} className={`relative min-w-0 ${className}`}>
    {children}
    {selection && box && !editing ? <button type="button" data-comment-ui="" aria-label="Comment on the selection"
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => { setEditing({ selected: selection, at: editorAt(event.currentTarget, selection.rect) }); setSelection(null); }}
      className={`absolute z-30 flex select-none items-center gap-1 rounded-md bg-foreground px-2 py-1 text-caption font-medium text-background shadow-md ${selection.rect.top > ROOM_ABOVE ? '-translate-y-full' : ''}`}
      style={{ left: Math.max(0, Math.min(selection.rect.left - box.left + selection.rect.width / 2 - 44, box.width - 96)), top: selection.rect.top > ROOM_ABOVE ? selection.rect.top - box.top - 6 : selection.rect.bottom - box.top + 6 }}>
      <Annotation width={13} height={13} />Comment
    </button> : null}
    {hint && box ? <span role="status" data-comment-ui="" className={`pointer-events-none absolute z-30 select-none whitespace-nowrap rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-muted-foreground shadow-surface-1 ${hint.top > ROOM_ABOVE ? '-translate-y-full' : ''}`}
      style={{ left: Math.max(0, Math.min(hint.left - box.left, box.width - 320)), top: hint.top > ROOM_ABOVE ? hint.top - box.top - 6 : hint.bottom - box.top + 6 }}>
      Comments go on what the agent wrote since the last message
    </span> : null}
    {editing ? <NoteEditor quote={editing.selected.quote} label={editing.selected.label} at={editing.at} onCancel={() => setEditing(null)}
      onSave={async (note) => {
        await layer.stage(scope, editing.selected.target, editing.selected.quote, note);
        setEditing(null);
        window.getSelection()?.removeAllRanges();
      }} /> : null}
  </div>;
}

/** One of the agent's messages in the chat: it takes comments while it is in the comment window, on a selection or, for
 * a paragraph, heading, list item or quote, from the icon beside it. */
export function CommentMessage({ row, children }: { row: string; children: ReactNode }) {
  const layer = useContext(CommentLayer);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const editable = layer?.open.has(row) ?? false;
  const scope = useMemo(() => ({ row, editable, document: null }), [row, editable]);
  if (!layer) return <>{children}</>;
  return <CommentScope.Provider value={scope}><div ref={setElement} data-comment-target={row} className="relative min-w-0">
    <SelectionComments>{children}</SelectionComments>
    {editable && element ? <ProseHandles container={element} scope={scope} /> : null}
  </div></CommentScope.Provider>;
}

/** The comments a sent message carried: each quote and note, linking back to what it is about (a drive doc's named by
 * its file). */
export function SentComments({ comments }: { comments: readonly SentComment[] }) {
  const shape = useShape();
  const show = useShowAnchor();
  if (comments.length === 0) return null;
  return <ul aria-label="Comments in this message" className="mt-1 flex flex-col gap-1.5">
    {comments.map(({ id, anchor, note }) => <li key={id} data-sent-comment={id} className={`${shape.container} flex min-w-0 flex-col gap-1 bg-background/60 px-2.5 py-1.5 text-left`}>
      <button type="button" className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => show(anchor)}>
        <Annotation width={12} height={12} className="shrink-0" />
        <span className="min-w-0 truncate">{anchor.document.kind === 'drive' ? `${driveFileName(anchor.document.path)} · ` : ''}{anchorLabel(anchor)}</span>
        <ArrowUpRight width={11} height={11} className="shrink-0" />
      </button>
      {anchor.quote ? <blockquote className="border-l-2 border-border pl-2 text-caption italic text-muted-foreground [overflow-wrap:anywhere]">{commentExcerpt(anchor.quote, 140)}</blockquote> : null}
      <span className="whitespace-pre-wrap text-body text-foreground [overflow-wrap:anywhere]">{note}</span>
    </li>)}
  </ul>;
}

/** The agent's Reply block: its answer, linked to the comment it answers. */
export function ReplyView({ comment, quote, text }: { comment: string; quote: string | null; text: string }) {
  const shape = useShape();
  const layer = useContext(CommentLayer);
  const show = useShowAnchor();
  const answered = layer?.notes.find((note) => note.id === comment);
  const quoted = quote ?? answered?.anchor.quote ?? null;
  return <div data-comment-reply={comment} className={`${shape.container} flex min-w-0 flex-col gap-1.5 border border-border border-l-2 bg-surface-1 px-3 py-2`} style={{ borderLeftColor: 'var(--muted-foreground)' }}>
    <button type="button" disabled={!answered} className="flex min-w-0 items-center gap-1 text-left text-caption text-muted-foreground enabled:hover:text-foreground" onClick={() => { if (answered) show(answered.anchor); }}>
      <Annotation width={13} height={13} className="shrink-0" />
      <span className="min-w-0 truncate">Reply to your comment{answered?.note ? `: “${commentExcerpt(answered.note, 80)}”` : ''}</span>
      {answered ? <ArrowUpRight width={11} height={11} className="shrink-0" /> : null}
    </button>
    {quoted ? <blockquote className="border-l-2 border-border pl-2 text-caption italic text-muted-foreground [overflow-wrap:anywhere]">{commentExcerpt(quoted, 140)}</blockquote> : null}
    <div className="text-body"><GitSpaceMarkdown>{text}</GitSpaceMarkdown></div>
  </div>;
}

/** A drive file's name, as people read it, from its drive URL. */
export function driveFileName(path: string): string {
  const name = path.split('/').at(-1) ?? path;
  try { return decodeURIComponent(name); } catch { return name; }
}

/**
 * An entity of the Goal or a Change Guide revision (`requirement:<id>`, `decision:<entry id>`, `step:<id>`,
 * `section:<id>`, `exhibit:<section id>:<path>`), or a drive doc (`drive`), as a commentable part of its document
 * (DocumentComments): its comment icon (in the column's gutter level with its first line while hovered; none without
 * `label`, a drive doc, which takes comments on its passages and blocks only), a selection or a paragraph's icon inside
 * it, and the blocks of its Markdown. It never locks; where its document takes no comments (an older Guide revision), it
 * is only marked so its comments find it.
 */
export function CommentEntity({ entity, label, quote, className = '', children }: { entity: string; label?: string; quote?: string; className?: string; children: ReactNode }) {
  const layer = useContext(CommentLayer);
  const where = useContext(DocumentComments)?.document ?? null;
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const scope = useMemo((): CommentScopeValue | null => where ? { row: entity, editable: true, document: where } : null, [entity, where]);
  if (!layer || !scope) return <div data-comment-target={entity} className={`min-w-0 ${className}`}><EntityBlocks entity={entity}>{children}</EntityBlocks></div>;
  // The layout classes go on the box that holds the entity's own content, not on the box that also holds its icons.
  return <CommentScope.Provider value={scope}><div ref={setElement} data-comment-target={entity} data-comment-entity={entity} className="relative min-w-0">
    <SelectionComments className={className}><EntityBlocks entity={entity}>{children}</EntityBlocks></SelectionComments>
    {label === undefined ? null : <GutterTrigger anchor="[data-comment-entity]" label={label} quote={quote ?? label} inlineClassName="absolute -left-5 top-0.5 opacity-60 hover:opacity-100 focus-visible:opacity-100"
      targetFor={() => ({ kind: 'entity', ref: entity })} />}
    {element ? <ProseHandles container={element} scope={scope} /> : null}
  </div></CommentScope.Provider>;
}

/** The note editor for a target the caller found (an exhibit's selected lines), beside `around`, staging in the scope
 * it is drawn in; closes once staged or cancelled. */
export function TargetCommentEditor({ target, quote, label, around, onClose }: { target: CommentTarget; quote: string; label: string; around: Element; onClose(): void }) {
  const layer = useContext(CommentLayer);
  const scope = useContext(CommentScope);
  const at = useMemo(() => editorAt(around), [around]);
  if (!layer || !scope?.editable) return null;
  return <NoteEditor quote={quote} label={label} at={at} onCancel={onClose} onSave={async (note) => { await layer.stage(scope, target, quote, note); onClose(); }} />;
}

/** A Goal, Guide or drive doc comment with its replies, under what it is on: its place, its quote (as written, for an
 * outdated one, with the revision or file version it was written on), the person's note and the agent's Reply blocks.
 * Folded, one line. */
function DocumentThread({ note, folded, onUnfold }: { note: DocumentNote; folded: boolean; onUnfold(): void }) {
  const shape = useShape();
  const layer = useContext(CommentLayer);
  const documentComments = useContext(DocumentComments);
  const onShowRevision = documentComments?.onShowRevision ?? null;
  const [error, setError] = useState<string | null>(null);
  const said = note.note ?? 'Sent with your message.';
  if (folded) return <button type="button" data-document-thread={note.id} data-thread-folded="" onClick={onUnfold}
    className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-caption text-muted-foreground hover:bg-surface-2 hover:text-foreground">
    <ChevronRight width={12} height={12} className="shrink-0" /><Annotation width={12} height={12} className="shrink-0" />
    <span className="shrink-0">{anchorLabel(note.anchor)}</span>
    <span className="min-w-0 flex-1 truncate">· {commentExcerpt(said, 80)}</span>
    {note.outdated ? <span className="shrink-0">outdated</span> : null}
    {note.replies.length ? <span className="shrink-0 tabular-nums">· {note.replies.length} repl{note.replies.length === 1 ? 'y' : 'ies'}</span> : null}
  </button>;
  return <article data-document-thread={note.id} data-thread-state={note.state} data-thread-outdated={note.outdated || undefined} aria-label={`Comment: ${commentExcerpt(said, 60)}`}
    className={`${shape.container} flex min-w-0 flex-col gap-1.5 border border-border border-l-2 bg-surface-1 px-2.5 py-2`}
    style={{ borderLeftColor: note.state === 'staged' ? 'var(--color-amber-500, #f59e0b)' : 'var(--border)' }}>
    <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      <Annotation width={12} height={12} className="shrink-0" />
      <span>{anchorLabel(note.anchor)}</span>
      {note.outdated ? <Badge size="compact" variant="dot" color="amber">Outdated</Badge> : null}
      {note.outdated && note.version !== undefined ? <span data-thread-version="">as written in {note.version}</span>
        : note.outdated && onShowRevision ? <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={() => onShowRevision(note.revision)}>as written on r{note.revision}</button> : null}
      <span className="flex-1" />
      <Badge size="compact" variant="dot" color={note.state === 'staged' ? 'amber' : 'gray'}>{note.state === 'staged' ? 'in your next message' : 'sent'}</Badge>
      {note.state === 'staged' && layer ? <button type="button" aria-label="Remove comment" className="rounded p-0.5 hover:bg-surface-2 hover:text-foreground"
        onClick={() => { setError(null); layer.remove(note.id).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))); }}><Trash01 width={12} height={12} /></button> : null}
    </span>
    {note.anchor.quote ? <blockquote className="border-l-2 border-border pl-2 text-caption italic text-muted-foreground [overflow-wrap:anywhere]">{commentExcerpt(note.anchor.quote, 200)}</blockquote> : null}
    <p className="whitespace-pre-wrap text-caption text-foreground [overflow-wrap:anywhere]">{said}</p>
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    {note.replies.map((reply) => <div key={reply.row} data-thread-reply="" className="flex flex-col gap-0.5 border-t border-border pt-1.5 text-caption">
      <span className="text-[11px] font-medium text-foreground">Agent</span>
      {reply.text === null ? <span className="text-muted-foreground">Replied in the chat.</span> : <GitSpaceMarkdown>{reply.text}</GitSpaceMarkdown>}
    </div>)}
  </article>;
}

/** Comment threads in order: the newest open, older ones folded to one line until opened. No resolve: a thread stays
 * until what it is on changes (then it shows outdated) or its messages leave the transcript. */
export function DocumentThreads({ notes }: { notes: readonly DocumentNote[] }) {
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  return <>{notes.map((note, index) => <DocumentThread key={note.id} note={note} folded={index < notes.length - 1 && note.state === 'sent' && !unfolded.has(note.id)}
    onUnfold={() => setUnfolded((current) => new Set(current).add(note.id))} />)}</>;
}

/** The comment threads on a Goal or Guide entity (and on passages, blocks and lines inside it). */
export function EntityThreads({ entity, className = '' }: { entity: string; className?: string }) {
  const notes = useContext(DocumentComments)?.notes;
  const threads = useMemo(() => (notes ?? []).filter((note) => anchorEntity(note.anchor) === entity), [notes, entity]);
  if (threads.length === 0) return null;
  return <div data-entity-threads={entity} data-comment-ui="" className={`flex min-w-0 flex-col gap-1 ${className}`}><DocumentThreads notes={threads} /></div>;
}
