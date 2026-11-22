import { GHOST_ENTRY_ORDINALS, GHOST_PATH, GhostServerMessageSchema, ghostReference, type GhostCite, type GhostPart, type GhostQuery, type GhostRead, type GhostServerMessage } from '@gitspace/protocol-runtime';
import { DEVICE_SOCKET_PROTOCOL } from '@gitspace/protocol/socket-auth';
import { useSyncExternalStore } from 'react';
import { signDeviceRequest } from '../device.js';
import { currentDevice } from '../device-session.js';

/** The session a ghost is summoned for: the workspace (its name, whether it is archived), one of its conversations (its
 * main one when null; `title` names it until the ghost says), and `until`, the last entry it may read. */
export type GhostSubject = { projectId: string; workspaceId: string; workspaceName: string; archived: boolean; conversationId: string | null; title: string | null; until: number | null };
export type GhostReadLine = { index: number; read: GhostRead; done: boolean; failed: string | null };
export type GhostTurn =
  | { role: 'person'; turn: number; text: string; about: number | null }
  | { role: 'ghost'; turn: number; reads: GhostReadLine[]; round: number; text: string; parts: GhostPart[] | null; draft: string | null; everyone: Extract<GhostServerMessage, { type: 'answer' }>['everyone']; truncated: boolean; failed: string | null };
export type GhostAnswer = Extract<GhostTurn, { role: 'ghost' }>;
export type GhostReady = Omit<Extract<GhostServerMessage, { type: 'ready' }>, 'type' | 'expiresAt'>;
export type GhostEnding = { reason: Extract<GhostServerMessage, { type: 'ended' }>['reason']; at: string; questions: number; message: string | null };
/** One of the browser's ghosts: everything it said lives here and in its server object, nowhere else. A reload ends it. */
export type Ghost = {
  key: number;
  subject: GhostSubject;
  openedAt: string;
  ready: GhostReady | null;
  expiresAt: number | null;
  turns: GhostTurn[];
  input: string;
  /** The entry the next question is about ("Ask a ghost about this"), until the person clears it. */
  about: number | null;
  /** A question asked before the ghost was ready: sent once it is. */
  queued: { text: string; about: number | null } | null;
  ended: GhostEnding | null;
  /** Bumped when the ghost is summoned again: the window glows. */
  pulse: number;
};
/** Where the ghosts show: floating over the workspace, or docked as a column on its right. */
export type GhostPlacement = 'float' | 'dock';
/** What a citation or a draft asks of the workspace view: the transcript at an entry, the Drive at lines (in the version
 * the ghost read when `hash` names it), the draft in the composer; or, for an archived workspace's draft, a new
 * workspace in the project whose composer gets it. */
export type GhostRequest = { serial: number } & (
  | { kind: 'entry'; workspaceId: string; ordinal: number }
  | { kind: 'drive'; workspaceId: string; url: string; hash: string | null }
  | { kind: 'compose'; workspaceId: string; text: string }
  | { kind: 'create'; projectId: string; text: string });
export type GhostState = { ghosts: readonly Ghost[]; active: number | null; placement: GhostPlacement };

/** Live ghosts a person keeps at once; past it, the one opened longest ago ends. */
export const GHOST_PERSON_MAX = 6;
export const GHOST_ABOUT_QUESTION = 'Why did the agent do this?';
const PLACEMENT_KEY = 'gitspace.ghosts.placement';

/** The ghost answering `turn`, as it reads and writes. */
function answering(ghost: Ghost, turn: number, change: (answer: GhostAnswer) => GhostAnswer): Ghost {
  const blank: GhostAnswer = { role: 'ghost', turn, reads: [], round: 0, text: '', parts: null, draft: null, everyone: null, truncated: false, failed: null };
  const found = ghost.turns.some(item => item.role === 'ghost' && item.turn === turn);
  const turns = found ? ghost.turns.map(item => item.role === 'ghost' && item.turn === turn ? change(item) : item) : [...ghost.turns, change(blank)];
  return { ...ghost, turns };
}

/** The ghost after one message from its object. */
export function applyGhostMessage(ghost: Ghost, message: GhostServerMessage): Ghost {
  switch (message.type) {
    case 'ready': {
      const { type: _type, expiresAt, ...ready } = message;
      return { ...ghost, ready, expiresAt: Date.parse(expiresAt) };
    }
    case 'read': return answering(ghost, message.turn, answer => {
      const line: GhostReadLine = { index: message.index, read: message.read, done: message.done, failed: message.failed ?? null };
      const reads = answer.reads.some(item => item.index === message.index) ? answer.reads.map(item => item.index === message.index ? line : item) : [...answer.reads, line].sort((left, right) => left.index - right.index);
      return { ...answer, reads };
    });
    case 'text': return answering(ghost, message.turn, answer => message.round === answer.round ? { ...answer, text: answer.text + message.delta } : { ...answer, round: message.round, text: message.delta });
    case 'answer': return { ...answering(ghost, message.turn, answer => ({ ...answer, parts: message.parts, draft: message.draft, everyone: message.everyone, truncated: message.truncated })), expiresAt: Date.parse(message.expiresAt) };
    case 'failed': return { ...answering(ghost, message.turn, answer => ({ ...answer, failed: message.message })), expiresAt: Date.parse(message.expiresAt) };
    case 'expires': return { ...ghost, expiresAt: Date.parse(message.expiresAt) };
    case 'ended': return { ...ghost, ended: { reason: message.reason, at: message.endedAt, questions: message.questions, message: message.message ?? null } };
  }
}

/** A ghost is answering: its last turn is an answer still without its parts or failure. */
export function ghostBusy(ghost: Ghost): boolean {
  const last = ghost.turns.at(-1);
  return last?.role === 'person' || (last?.role === 'ghost' && last.parts === null && last.failed === null);
}

/** What the store uses of the ghost's WebSocket. */
export type GhostSocket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'addEventListener'>;
type State = GhostState & { request: GhostRequest | null };
function storedPlacement(): GhostPlacement {
  try { return globalThis.localStorage?.getItem(PLACEMENT_KEY) === 'dock' ? 'dock' : 'float'; } catch { return 'float'; }
}
let state: State = { ghosts: [], active: null, placement: storedPlacement(), request: null };
const sockets = new Map<number, GhostSocket>();
let keys = 0;
let serials = 0;
const listeners = new Set<() => void>();
function set(next: State): void {
  state = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The ghost socket for a session, signed by this browser's device in `Sec-WebSocket-Protocol`. */
async function openSocket(query: GhostQuery): Promise<GhostSocket> {
  const device = await currentDevice();
  if (!device) throw new Error('This browser is not signed in to GitSpace');
  const path = `${GHOST_PATH}?${new URLSearchParams(query)}`;
  const proof = await signDeviceRequest(device, { method: 'GET', path, body: new Uint8Array() });
  const url = new URL(path, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(url.href, [`${DEVICE_SOCKET_PROTOCOL}${proof}`]);
}

function update(key: number, change: (ghost: Ghost) => Ghost): void {
  if (state.ghosts.some(ghost => ghost.key === key)) set({ ...state, ghosts: state.ghosts.map(ghost => ghost.key === key ? change(ghost) : ghost) });
}
const find = (key: number): Ghost | undefined => state.ghosts.find(ghost => ghost.key === key);
const questions = (ghost: Ghost) => ghost.turns.filter(turn => turn.role === 'person').length;

/** Sends a question to a ready ghost; one not ready yet keeps it until it is. */
function send(key: number, text: string, about: number | null): void {
  const ghost = find(key);
  if (!ghost || ghost.ended || ghostBusy(ghost)) return;
  const socket = sockets.get(key);
  if (!ghost.ready || !socket) { update(key, current => ({ ...current, queued: { text, about } })); return; }
  socket.send(JSON.stringify(about === null ? { type: 'ask', text } : { type: 'ask', text, about }));
  update(key, current => ({ ...current, input: '', about: null, queued: null, turns: [...current.turns, { role: 'person', turn: questions(current) + 1, text, about }] }));
}

/** The live ghost already reading this session (the same conversation up to the same entry), if any. */
function reading(subject: GhostSubject): Ghost | undefined {
  return state.ghosts.find(ghost => !ghost.ended && ghost.subject.workspaceId === subject.workspaceId && ghost.subject.until === subject.until
    && (ghost.subject.conversationId === subject.conversationId || (subject.conversationId === null ? ghost.ready?.main === true : ghost.ready?.conversationId === subject.conversationId)));
}

/**
 * Opens a ghost of the session, or brings back the live one already reading it (it glows and comes to the front).
 * `about` puts the entry in its composer with "Why did the agent do this?"; `question` asks straight away (once it is
 * ready). Past `GHOST_PERSON_MAX` live ghosts the one opened longest ago ends, and faded ones beyond it are dropped.
 */
export function summonGhost(subject: GhostSubject, options: { about?: number; question?: string } = {}, open: (query: GhostQuery) => Promise<GhostSocket> = openSocket): void {
  const about = options.about ?? null;
  const existing = reading(subject);
  if (existing) {
    update(existing.key, ghost => ({ ...ghost, pulse: ghost.pulse + 1, ...(about === null ? {} : { about, input: GHOST_ABOUT_QUESTION }) }));
    set({ ...state, active: existing.key });
    if (options.question) send(existing.key, options.question, about);
    return;
  }
  const live = state.ghosts.filter(ghost => !ghost.ended);
  if (live.length >= GHOST_PERSON_MAX) closeGhost(live[0]!.key);
  const key = ++keys;
  const ghost: Ghost = { key, subject, openedAt: new Date().toISOString(), ready: null, expiresAt: null, turns: [], input: about === null ? '' : GHOST_ABOUT_QUESTION, about, queued: options.question ? { text: options.question, about } : null, ended: null, pulse: 0 };
  // A faded ghost of the same session gives up its place; past the cap the oldest ended ones go.
  const kept = state.ghosts.filter(item => !(item.ended && item.subject.workspaceId === subject.workspaceId && item.subject.conversationId === subject.conversationId));
  const extra = kept.length + 1 - GHOST_PERSON_MAX;
  const dropped = new Set(extra > 0 ? kept.filter(item => item.ended).slice(0, extra).map(item => item.key) : []);
  set({ ...state, ghosts: [...kept.filter(item => !dropped.has(item.key)), ghost], active: key });
  const ending = (message: string): void => update(key, current => current.ended ? current : { ...current, ended: { reason: 'failed', at: new Date().toISOString(), questions: questions(current), message } });
  const query: GhostQuery = { projectId: subject.projectId, workspaceId: subject.workspaceId, ...(subject.conversationId === null ? {} : { conversationId: subject.conversationId }), ...(subject.until === null ? {} : { until: String(subject.until) }) };
  open(query).then(opened => {
    if (!find(key) || find(key)?.ended) { opened.close(1000, 'Ghost dismissed'); return; }
    sockets.set(key, opened);
    opened.addEventListener('message', event => {
      const parsed = GhostServerMessageSchema.safeParse(typeof event.data === 'string' ? JSON.parse(event.data) : null);
      if (!parsed.success) return;
      update(key, current => applyGhostMessage(current, parsed.data));
      const queued = find(key)?.queued;
      if (parsed.data.type === 'ready' && queued) send(key, queued.text, queued.about);
    });
    opened.addEventListener('close', () => {
      if (sockets.get(key) === opened) sockets.delete(key);
      ending('The connection to the ghost closed. Nothing it read or said was kept.');
    });
  }, (error: unknown) => ending(error instanceof Error ? error.message : String(error)));
}

/** A ghost of the session a reference names (a tooling post's `history://` or `result://` reference), about its entry
 * when it names one. False, and nothing opens, when it names no session. */
export function askGhostAboutReference(input: { projectId: string; reference: string; workspaceName: string }): boolean {
  const named = ghostReference(input.reference);
  if (!named) return false;
  summonGhost({ projectId: input.projectId, workspaceId: named.workspaceId, workspaceName: input.workspaceName, archived: false, conversationId: named.conversationId, title: null, until: null }, named.entry === null ? {} : { about: named.entry });
  return true;
}

export function setGhostInput(key: number, text: string): void {
  update(key, ghost => ({ ...ghost, input: text }));
}

/** Asks the whole session again, not the entry it was asked about. */
export function clearGhostAbout(key: number): void {
  update(key, ghost => ({ ...ghost, about: null, input: ghost.input === GHOST_ABOUT_QUESTION ? '' : ghost.input }));
}

export function askGhost(key: number, text: string): void {
  send(key, text, find(key)?.about ?? null);
}

export function keepGhost(key: number): void {
  sockets.get(key)?.send(JSON.stringify({ type: 'keep' }));
}

/** Brings a ghost to the front (its window, or its tab), or with null shows none: floating, every ghost a pill; docked,
 * the start page. */
export function focusGhost(key: number | null): void {
  set({ ...state, active: key });
}

/** Floating or docked; the choice stays in this browser. */
export function setGhostPlacement(placement: GhostPlacement): void {
  try { globalThis.localStorage?.setItem(PLACEMENT_KEY, placement); } catch { /* The choice holds for this page. */ }
  set({ ...state, placement });
}

/** Ends a live ghost: its object drops everything, and its window shows its tombstone. */
export function closeGhost(key: number): void {
  const ghost = find(key);
  if (ghost && !ghost.ended) update(key, current => ({ ...current, ended: { reason: 'closed', at: new Date().toISOString(), questions: questions(current), message: null } }));
  const socket = sockets.get(key);
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'close' }));
  socket?.close(1000, 'Ghost closed');
  sockets.delete(key);
}

/** Removes a ghost (its tombstone, or the ghost itself, which then ends). */
export function dismissGhost(key: number): void {
  closeGhost(key);
  set({ ...state, ghosts: state.ghosts.filter(ghost => ghost.key !== key), active: state.active === key ? null : state.active });
}

/** Summons a new ghost in place of an ended one, of the same session. */
export function resummonGhost(key: number): void {
  const ghost = find(key);
  if (!ghost) return;
  dismissGhost(key);
  summonGhost(ghost.subject);
}

/** A citation of a ghost: its workspace's transcript at the entry (only for its main conversation, the one the
 * workspace view shows), or its drive at the lines in the version it read. Returns the subject to open, or null when
 * there is nothing to show there. */
export function citeGhost(key: number, cite: GhostCite): GhostSubject | null {
  const ghost = find(key);
  if (!ghost || cite.kind === 'chatter') return null;
  if (cite.kind === 'entry' && ghost.ready?.main === false) return null;
  showGhostCite(ghost.subject.workspaceId, cite);
  return ghost.subject;
}

/** Asks `workspaceId`'s view, once it shows, for a citation: its main transcript at the entry, or its drive at the
 * lines in the version the ghost read. An agent's ghost's answer (`ghost_ask`) cites this way too. */
export function showGhostCite(workspaceId: string, cite: Exclude<GhostCite, { kind: 'chatter' }>): void {
  set({ ...state, request: cite.kind === 'entry'
    ? { serial: ++serials, kind: 'entry', workspaceId, ordinal: cite.from * GHOST_ENTRY_ORDINALS }
    : { serial: ++serials, kind: 'drive', workspaceId, url: cite.lines ? `${cite.url}:${cite.lines[0]}-${cite.lines[1]}` : cite.url, hash: cite.hash } });
}

/** A ghost's draft for its workspace's agent: in that workspace's composer when it is live, or, archived, in the
 * composer of a new workspace of the project the person creates. Returns the subject to open. */
export function composeGhostDraft(key: number, text: string): GhostSubject | null {
  const ghost = find(key);
  if (!ghost) return null;
  set({ ...state, request: ghost.subject.archived ? { serial: ++serials, kind: 'create', projectId: ghost.subject.projectId, text } : { serial: ++serials, kind: 'compose', workspaceId: ghost.subject.workspaceId, text } });
  return ghost.subject;
}

/** The draft in a newly created workspace's composer, once its view shows. */
export function composeInWorkspace(workspaceId: string, text: string): void {
  set({ ...state, request: { serial: ++serials, kind: 'compose', workspaceId, text } });
}

/** The request waiting for `workspaceId`'s view (a project's new-workspace request reaches any view of the project). */
export function useGhostRequest(workspaceId: string, projectId: string | null = null): GhostRequest | null {
  const request = useSyncExternalStore(subscribe, () => state.request, () => null);
  if (!request) return null;
  return request.kind === 'create' ? request.projectId === projectId ? request : null : request.workspaceId === workspaceId ? request : null;
}

export function finishGhostRequest(serial: number): void {
  if (state.request?.serial === serial) set({ ...state, request: null });
}

const snapshot = (): GhostState => state;
export function useGhosts(): GhostState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
