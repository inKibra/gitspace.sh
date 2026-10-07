// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema, SessionControlSchema } from '@gitspace/protocol-runtime';
import { useRuntimeInspectorState, type RuntimeInspectorState } from './useRuntimeInspectorState.js';
import type { RuntimeInspectorContext } from './RuntimeWorkspace.js';
const rpc = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: rpc } }));
function context(workspaceId: string, conversationId = 'child'): RuntimeInspectorContext {
  return { snapshot: RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId, cursor: 1, conversations: [{ id: 'main', parentId: null, title: 'Main', status: 'idle', messages: [] }, { id: 'child', parentId: 'main', title: 'Child', status: 'running', messages: [] }], tasks: [], attachments: [], questions: [], documents: {} }), conversationId, sessionId: conversationId, turns: [], scope: { kind: 'workspace', id: workspaceId, name: workspaceId, branch: 'main', phase: 'code', closedAt: null, projectId: 'project', projectName: 'Project', generation: 0, possessedBy: '', holder: { kind: 'unknown' }, status: { primaryColor: 'dim', agents: { green: 0, blue: 0, orange: 0, red: 0 }, services: { green: 0, red: 0 }, terminals: { green: 0, red: 0 } }, relations: { dependsOn: [], relatedTo: [], stackedOn: null }, stack: { blockedBy: [], blocking: [], findings: [] } }, workspaces: [], onClose() {}, async onAskAgent() {} };
}
const control = SessionControlSchema.parse({ sessionId: 'main', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, approvalMode: 'write', context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, historyAnchorId: null, history: [], goal: null, pendingAsk: null });
const result = { status: 'ok', value: { control, setup: { sessionId: 'main', agents: [] } } };
let root: Root;
let state: RuntimeInspectorState | null;
function View({ value }: { value: RuntimeInspectorContext }) { state = useRuntimeInspectorState(value); return null; }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); rpc.session.mockReset(); root = createRoot(document.createElement('div')); });
afterEach(async () => { await act(() => root.unmount()); vi.unstubAllGlobals(); });
it('loads and saves main setup without a machine even when a child is inspected', async () => {
  rpc.session.mockResolvedValue(result);
  await act(() => root.render(<View value={context('a')} />));
  await act(async () => { state!.agentSetup.load(); });
  expect(rpc.session.mock.calls[0]?.[0].conversationId).toBe('main');
  expect(state!.agentSetup.sessionId).toBe('main');
  await act(async () => { await state!.agentSetup.save({ path: '.agents/agents/scout.md', expectedRevision: null, content: 'source' }); });
  expect(rpc.session.mock.calls[1]?.[0].conversationId).toBe('main');
});
it('allows a new workspace to load while the old workspace request is pending and ignores its late result', async () => {
  const old = Promise.withResolvers<typeof result>();
  rpc.session.mockReturnValueOnce(old.promise).mockResolvedValueOnce(result);
  await act(() => root.render(<View value={context('a', 'main')} />));
  await act(async () => { state!.agentSetup.load(); });
  await act(() => root.render(<View value={context('b', 'main')} />));
  await act(async () => { state!.agentSetup.load(); });
  expect(state!.agentSetup.status).toBe('ready');
  await act(async () => old.resolve({ ...result, value: { ...result.value, setup: { sessionId: 'old', agents: [] } } }));
  expect(state!.agentSetup.report?.sessionId).toBe('main');
});
