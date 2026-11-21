// Throwaway visual check for ghosts (docs/GHOSTS-DESIGN.md milestone 4): the app's own shell (its sidebar rows and
// topbar carry the ghost buttons) and the real ghost window, fed by a scripted socket instead of a ghost object.
// `?state=` picks what the window shows: answer, reading, draft, warn, tombstone. Static data only; not part of the app.
import { IconProvider, ShapeProvider, SizeProvider, TooltipProvider, untitledIcons } from '@gitspace/ui';
import type { GhostServerMessage } from '@gitspace/protocol-runtime';
import { StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { verticalSliceFixture } from './App.js';
import { GitSpaceShell } from './GitSpaceShell.js';
import { GhostLayer } from './ghost/GhostWindow.js';
import { askGhost, summonGhost, type GhostSocket } from './ghost/ghost-store.js';
import { restoreAppearance } from './appearance.js';

restoreAppearance();

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const ready: Extract<GhostServerMessage, { type: 'ready' }> = { type: 'ready', ghostId: 'mock', conversationId: '1', title: 'Workspace agent', entries: 143, archived: false, driveAsOf: new Date().toISOString(), expiresAt: minutes(10), model: 'anthropic/claude-haiku-4-5' };
/** What the scripted ghost answers, by question. */
const ANSWERS: Record<string, GhostServerMessage[]> = {
  'Why did it switch to polling?': [
    { type: 'read', turn: 1, index: 0, read: { kind: 'search', query: 'polling', hits: 9 }, done: true },
    { type: 'read', turn: 1, index: 1, read: { kind: 'read', from: 93, to: 117 }, done: true },
    { type: 'read', turn: 1, index: 2, read: { kind: 'drive', url: 'drive://workspace/notes/plan.md', generation: 42 }, done: true },
    { type: 'answer', turn: 1, parts: ['It dropped the socket push after the relay kept closing idle sockets at 60 s ', { kind: 'entry', from: 98 }, ', and chose `GET /status` polling every 5 s as a stopgap ', { kind: 'entry', from: 103, to: 117 }, '. The plan says to come back to push once the relay keeps sockets alive ', { kind: 'drive', url: 'drive://workspace/notes/plan.md', lines: [19, 20], generation: 42 }, '.'], draft: null, rounds: 2, truncated: false, expiresAt: minutes(10) },
  ],
  'What is it doing now?': [
    { type: 'read', turn: 1, index: 0, read: { kind: 'read', from: 139, to: 143 }, done: true },
    { type: 'read', turn: 1, index: 1, read: { kind: 'search', query: 'soak', hits: null }, done: false },
  ],
  'Merge it for me.': [
    { type: 'read', turn: 1, index: 0, read: { kind: 'read', from: 139, to: 143 }, done: true },
    { type: 'answer', turn: 1, parts: ['I can only read its transcript and the workspace drive, so I can’t merge anything. Here is a message you could send the agent; it last pushed the retry fix at ', { kind: 'entry', from: 141 }, '.'], draft: 'Please merge the relay retry fix once the checks pass. You left off at #141, after pushing the retry change and starting the soak.', rounds: 1, truncated: false, expiresAt: minutes(10) },
  ],
};
const QUESTION: Record<string, string> = { answer: 'Why did it switch to polling?', reading: 'What is it doing now?', draft: 'Merge it for me.' };

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

function GhostMock() {
  const state = new URLSearchParams(window.location.search).get('state') ?? 'answer';
  useEffect(() => {
    const socket = new ScriptedSocket();
    const opened: GhostSocket = socket;
    summonGhost({ projectId: 'project-a', workspaceId: 'workspace-a', workspaceName: 'agent-blame', archived: false }, async () => opened);
    queueMicrotask(() => {
      socket.play([state === 'warn' ? { ...ready, expiresAt: new Date(Date.now() + 45_000).toISOString() } : ready]);
      const question = QUESTION[state];
      if (question) askGhost(question);
      if (state === 'tombstone') socket.play([{ type: 'ended', reason: 'faded', endedAt: new Date().toISOString(), questions: 2 }]);
    });
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
