// Throwaway visual check for ghosts (docs/GHOSTS-DESIGN.md milestones 4–8): the app's own shell (its sidebar rows,
// topbar, transcript entries and archived banner carry the ghost entry points) and the real ghost windows, fed by
// scripted sockets instead of ghost objects. `?state=` picks what shows: answer, reading, draft, warn, tombstone,
// several (three ghosts, two as pills), dock (the docked column), until (a ghost from a point in time).
// Static data only; not part of the app.
import { IconProvider, ShapeProvider, SizeProvider, TooltipProvider, untitledIcons } from '@gitspace/ui';
import type { GhostServerMessage } from '@gitspace/protocol-runtime';
import { StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { verticalSliceFixture } from './App.js';
import { GitSpaceShell } from './GitSpaceShell.js';
import { GhostLayer } from './ghost/GhostWindow.js';
import { setGhostPlacement, summonGhost, type GhostSocket, type GhostSubject } from './ghost/ghost-store.js';
import { restoreAppearance } from './appearance.js';

restoreAppearance();

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const ready = (title: string, entries: number, until: number | null = null): Extract<GhostServerMessage, { type: 'ready' }> => ({
  type: 'ready', ghostId: 'mock', conversationId: '1', title, main: true, entries, until, archived: false, driveAsOf: new Date().toISOString(), expiresAt: minutes(10), model: 'anthropic/claude-haiku-4-5',
});
/** What the scripted ghost answers, by question. */
const ANSWERS: Record<string, GhostServerMessage[]> = {
  'Why did it switch to polling?': [
    { type: 'read', turn: 1, index: 0, read: { kind: 'search', query: 'polling', hits: 9 }, done: true },
    { type: 'read', turn: 1, index: 1, read: { kind: 'read', from: 93, to: 117 }, done: true },
    { type: 'read', turn: 1, index: 2, read: { kind: 'drive', url: 'drive://workspace/notes/plan.md', generation: 42 }, done: true },
    { type: 'answer', turn: 1, parts: ['It dropped the socket push after the relay kept closing idle sockets at 60 s ', { kind: 'entry', from: 98 }, ', and chose `GET /status` polling every 5 s as a stopgap ', { kind: 'entry', from: 103, to: 117 }, '. The plan says to come back to push once the relay keeps sockets alive ', { kind: 'drive', url: 'drive://workspace/notes/plan.md', lines: [19, 20], generation: 42, hash: 'sha256:4f2a' }, '.'], draft: null, rounds: 2, truncated: false, expiresAt: minutes(10) },
  ],
  'What is it doing now?': [
    { type: 'read', turn: 1, index: 0, read: { kind: 'read', from: 139, to: 143 }, done: true },
    { type: 'read', turn: 1, index: 1, read: { kind: 'search', query: 'soak', hits: null }, done: false },
  ],
  'Merge it for me.': [
    { type: 'read', turn: 1, index: 0, read: { kind: 'read', from: 139, to: 143 }, done: true },
    { type: 'answer', turn: 1, parts: ['I can only read its transcript and the workspace drive, so I can’t merge anything. Here is a message you could send the agent; it last pushed the retry fix at ', { kind: 'entry', from: 141 }, '.'], draft: 'Please merge the relay retry fix once the checks pass. You left off at #141, after pushing the retry change and starting the soak.', rounds: 1, truncated: false, expiresAt: minutes(10) },
  ],
  'What did this summary leave out?': [
    { type: 'read', turn: 1, index: 0, read: { kind: 'read', from: 60, to: 88 }, done: true },
    { type: 'answer', turn: 1, parts: ['The summary at ', { kind: 'entry', from: 88 }, ' kept the decision to poll but dropped why: the relay’s 60 s idle close it measured at ', { kind: 'entry', from: 71 }, '.'], draft: null, rounds: 1, truncated: false, expiresAt: minutes(10) },
  ],
};
const QUESTION: Record<string, string> = { answer: 'Why did it switch to polling?', reading: 'What is it doing now?', draft: 'Merge it for me.', dock: 'Why did it switch to polling?', several: 'Why did it switch to polling?', until: 'What did this summary leave out?' };

/** A socket that plays the scripted ghost. */
class ScriptedSocket extends EventTarget {
  readyState: WebSocket['readyState'] = WebSocket.OPEN;
  play(messages: readonly GhostServerMessage[]): void {
    for (const message of messages) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  send(data: string): void {
    const request: unknown = JSON.parse(data);
    const text = typeof request === 'object' && request !== null && 'text' in request && typeof request.text === 'string' ? request.text : null;
    if (text !== null) queueMicrotask(() => this.play(ANSWERS[text] ?? []));
  }
  close(): void { this.readyState = WebSocket.CLOSED; }
}

const subject = (workspaceId: string, workspaceName: string, until: number | null = null): GhostSubject => ({ projectId: 'project-a', workspaceId, workspaceName, archived: false, conversationId: null, title: null, until });

/** Opens a scripted ghost of `of`, ready as `opened`, asking `question` once it is; `ended` ends it at once. */
function scripted(of: GhostSubject, opened: Extract<GhostServerMessage, { type: 'ready' }>, question?: string, ended = false): void {
  const socket = new ScriptedSocket();
  const handle: GhostSocket = socket;
  summonGhost(of, question ? { question } : {}, async () => handle);
  queueMicrotask(() => socket.play(ended ? [opened, { type: 'ended', reason: 'faded', endedAt: new Date().toISOString(), questions: 2 }] : [opened]));
}

function GhostMock() {
  const state = new URLSearchParams(window.location.search).get('state') ?? 'answer';
  useEffect(() => {
    setGhostPlacement(state === 'dock' ? 'dock' : 'float');
    if (state === 'several' || state === 'dock') {
      scripted(subject('workspace-b', 'typia-bench'), ready('Benchmarks', 61));
      scripted(subject('workspace-c', 'relay-retry'), { ...ready('Relay retry', 88), expiresAt: new Date(Date.now() + 45_000).toISOString() });
    }
    const until = state === 'until' ? 88 : null;
    const opened = state === 'warn' ? { ...ready('Workspace agent', 143), expiresAt: new Date(Date.now() + 45_000).toISOString() } : ready('Workspace agent', until === null ? 143 : until + 1, until);
    scripted(subject('workspace-a', 'agent-blame', until), opened, QUESTION[state], state === 'tombstone');
  }, [state]);
  const workspaces = [...verticalSliceFixture.workspaces, { ...verticalSliceFixture.workspaces[1]!, id: 'workspace-d', name: 'export-bucket-move', branch: 'export-bucket-move', closedAt: new Date('2026-11-12T10:00:00Z') }];
  return <div className="h-screen">
    <GitSpaceShell {...verticalSliceFixture} workspaces={workspaces} />
    <GhostLayer onOpenWorkspace={() => undefined} />
  </div>;
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing root');
const root: Root = import.meta.hot?.data.root ?? createRoot(container);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(<StrictMode><ShapeProvider defaultShape="rounded"><SizeProvider defaultSize="default"><IconProvider icons={untitledIcons}><TooltipProvider><GhostMock /></TooltipProvider></IconProvider></SizeProvider></ShapeProvider></StrictMode>);
