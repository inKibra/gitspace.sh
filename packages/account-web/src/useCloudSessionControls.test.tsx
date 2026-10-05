// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema, SessionControlSchema, type SessionControlView } from '@gitspace/protocol-runtime';
import { useCloudSessionControls, type CloudSessionControls } from './useCloudSessionControls.js';

const rpc = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: rpc } }));
const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 1, conversations: [], tasks: [], attachments: [], questions: [], documents: {} });
function control(sessionId: string) { return SessionControlSchema.parse({ sessionId, role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, approvalMode: 'write', context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, historyAnchorId: null, history: [], goal: null, pendingAsk: null }); }
let root: Root;
let container: HTMLDivElement;
let state: CloudSessionControls;
function View({ conversationId }: { conversationId: string }) { state = useCloudSessionControls(snapshot, conversationId); return <span>{state.result?.control.sessionId ?? 'loading'}</span>; }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); rpc.session.mockReset(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('does not expose one conversation controls while another conversation is loading', async () => {
  const next = Promise.withResolvers<{ status: 'ok'; value: { control: SessionControlView } }>();
  rpc.session.mockResolvedValueOnce({ status: 'ok', value: { control: control('main') } }).mockReturnValueOnce(next.promise);
  await act(() => root.render(<View conversationId="main" />));
  expect(container.textContent).toBe('main');
  await act(() => root.render(<View conversationId="child" />));
  expect(container.textContent).toBe('loading');
  expect(state.result).toBeNull();
  await act(async () => next.resolve({ status: 'ok', value: { control: control('child') } }));
  expect(container.textContent).toBe('child');
});

it('keeps provider catalog errors actionable and recovers controls on retry', async () => {
  rpc.session.mockResolvedValueOnce({ status: 'error', error: new Error('Provider catalog unavailable') }).mockResolvedValueOnce({ status: 'ok', value: { control: control('main') } });
  await act(() => root.render(<View conversationId="main" />));
  expect(state.error).toContain('Provider catalog unavailable');
  expect(state.result).toBeNull();
  await act(async () => { await state.run({ type: 'control' }); });
  expect(state.error).toBeNull();
  expect(container.textContent).toBe('main');
});
