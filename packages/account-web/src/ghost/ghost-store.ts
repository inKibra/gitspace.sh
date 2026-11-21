import { GHOST_ENTRY_ORDINALS, GHOST_PATH, GhostServerMessageSchema, type GhostCite, type GhostPart, type GhostQuery, type GhostRead, type GhostServerMessage } from '@gitspace/protocol-runtime';
import { DEVICE_SOCKET_PROTOCOL } from '@gitspace/protocol/socket-auth';
import { useSyncExternalStore } from 'react';
import { signDeviceRequest } from '../device.js';
import { currentDevice } from '../device-session.js';

/** The workspace a ghost was summoned from: the row or topbar knows its name and whether it is archived. */
export type GhostSubject = { projectId: string; workspaceId: string; workspaceName: string; archived: boolean };
export type GhostReadLine = { index: number; read: GhostRead; done: boolean; failed: string | null };
export type GhostTurn =
  | { role: 'person'; turn: number; text: string }
  | { role: 'ghost'; turn: number; reads: GhostReadLine[]; round: number; text: string; parts: GhostPart[] | null; draft: string | null; truncated: boolean; failed: string | null };
export type GhostAnswer = Extract<GhostTurn, { role: 'ghost' }>;
export type GhostReady = Omit<Extract<GhostServerMessage, { type: 'ready' }>, 'type' | 'expiresAt'>;
export type GhostEnding = { reason: Extract<GhostServerMessage, { type: 'ended' }>['reason']; at: string; questions: number; message: string | null };
/** The browser's ghost: everything it said lives here and in its server object, nowhere else. A reload ends it. */
export type Ghost = {
  key: number;
  subject: GhostSubject;
  openedAt: string;
  ready: GhostReady | null;
  expiresAt: number | null;
  turns: GhostTurn[];
  input: string;
  ended: GhostEnding | null;
  /** Bumped when the ghost is summoned again: the window glows. */
  pulse: number;
};
/** What a citation or a draft asks of the workspace view, once it shows `workspaceId`. */
export type GhostRequest = { serial: number; workspaceId: string } & ({ kind: 'entry'; ordinal: number } | { kind: 'drive'; url: string } | { kind: 'compose'; text: string });

/** The ghost answering `turn`, as it reads and writes. */
function answering(ghost: Ghost, turn: number, change: (answer: GhostAnswer) => GhostAnswer): Ghost {
  const blank: GhostAnswer = { role: 'ghost', turn, reads: [], round: 0, text: '', parts: null, draft: null, truncated: false, failed: null };
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
    case 'answer': return { ...answering(ghost, message.turn, answer => ({ ...answer, parts: message.parts, draft: message.draft, truncated: message.truncated })), expiresAt: Date.parse(message.expiresAt) };
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
type State = { ghost: Ghost | null; request: GhostRequest | null };
let state: State = { ghost: null, request: null };
let socket: GhostSocket | null = null;
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
  if (state.ghost?.key === key) set({ ...state, ghost: change(state.ghost) });
}

/** Opens a ghost of the workspace's main conversation, or brings back the live one already reading it. One ghost at a
 * time: a ghost of another workspace ends the one before. */
export function summonGhost(subject: GhostSubject, open: (query: GhostQuery) => Promise<GhostSocket> = openSocket): void {
  const current = state.ghost;
  if (current && !current.ended && current.subject.workspaceId === subject.workspaceId) {
    set({ ...state, ghost: { ...current, pulse: current.pulse + 1 } });
    return;
  }
  closeGhost();
  const key = ++keys;
  set({ ...state, ghost: { key, subject, openedAt: new Date().toISOString(), ready: null, expiresAt: null, turns: [], input: '', ended: null, pulse: 0 } });
  const ending = (message: string): void => update(key, ghost => ghost.ended ? ghost : { ...ghost, ended: { reason: 'failed', at: new Date().toISOString(), questions: ghost.turns.filter(turn => turn.role === 'person').length, message } });
  open({ projectId: subject.projectId, workspaceId: subject.workspaceId }).then(opened => {
    if (state.ghost?.key !== key) { opened.close(1000, 'Ghost dismissed'); return; }
    socket = opened;
    opened.addEventListener('message', event => {
      const parsed = GhostServerMessageSchema.safeParse(typeof event.data === 'string' ? JSON.parse(event.data) : null);
      if (parsed.success) update(key, ghost => applyGhostMessage(ghost, parsed.data));
    });
    opened.addEventListener('close', () => {
      if (socket === opened) socket = null;
      ending('The connection to the ghost closed. Nothing it read or said was kept.');
    });
  }, (error: unknown) => ending(error instanceof Error ? error.message : String(error)));
}

export function setGhostInput(text: string): void {
  if (state.ghost) set({ ...state, ghost: { ...state.ghost, input: text } });
}

export function askGhost(text: string): void {
  const ghost = state.ghost;
  if (!ghost?.ready || ghost.ended || ghostBusy(ghost) || !socket) return;
  const turn = ghost.turns.filter(item => item.role === 'person').length + 1;
  socket.send(JSON.stringify({ type: 'ask', text }));
  set({ ...state, ghost: { ...ghost, input: '', turns: [...ghost.turns, { role: 'person', turn, text }] } });
}

export function keepGhost(): void {
  socket?.send(JSON.stringify({ type: 'keep' }));
}

/** Ends the live ghost: its object drops everything, and the window shows its tombstone. */
export function closeGhost(): void {
  const current = state.ghost;
  if (current && !current.ended) {
    const ended: GhostEnding = { reason: 'closed', at: new Date().toISOString(), questions: current.turns.filter(turn => turn.role === 'person').length, message: null };
    set({ ...state, ghost: { ...current, ended } });
  }
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'close' }));
  socket?.close(1000, 'Ghost closed');
  socket = null;
}

/** Removes the ghost's window (its tombstone, or the ghost itself, which then ends). */
export function dismissGhost(): void {
  closeGhost();
  set({ ...state, ghost: null });
}

/** A citation of the ghost: its workspace's transcript at the entry, or its drive at the lines. */
export function citeGhost(cite: GhostCite): GhostSubject | null {
  const ghost = state.ghost;
  if (!ghost) return null;
  const workspaceId = ghost.subject.workspaceId;
  set({ ...state, request: cite.kind === 'entry'
    ? { serial: ++serials, workspaceId, kind: 'entry', ordinal: cite.from * GHOST_ENTRY_ORDINALS }
    : { serial: ++serials, workspaceId, kind: 'drive', url: cite.lines ? `${cite.url}:${cite.lines[0]}-${cite.lines[1]}` : cite.url } });
  return ghost.subject;
}

/** The ghost's draft in its workspace's composer, for the person to send. */
export function composeGhostDraft(text: string): GhostSubject | null {
  const ghost = state.ghost;
  if (!ghost) return null;
  set({ ...state, request: { serial: ++serials, workspaceId: ghost.subject.workspaceId, kind: 'compose', text } });
  return ghost.subject;
}

/** The request waiting for `workspaceId`'s view, if any. */
export function useGhostRequest(workspaceId: string): GhostRequest | null {
  const request = useSyncExternalStore(subscribe, () => state.request, () => null);
  return request?.workspaceId === workspaceId ? request : null;
}

export function finishGhostRequest(serial: number): void {
  if (state.request?.serial === serial) set({ ...state, request: null });
}

export function useGhost(): Ghost | null {
  return useSyncExternalStore(subscribe, () => state.ghost, () => null);
}
