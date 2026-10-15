// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema, type RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { emptyLifecycleState, executionHash } from '@gitspace/protocol-environment';
import { emptyWorkspaceStatus } from '@gitspace/protocol-workspace';
import type { WorkspaceEnvironmentView } from '@gitspace/protocol/rpc-contract';
import { LiveEnvironment } from './LiveEnvironment.js';

const rpc = vi.hoisted(() => ({
  sync: vi.fn(), approve: vi.fn(), revokeApproval: vi.fn(), runChecks: vi.fn(), runPhase: vi.fn(), putValue: vi.fn(),
  setProfile: vi.fn(), cancelRun: vi.fn(), runLog: vi.fn(), cache: vi.fn(), detach: vi.fn(), createTerminal: vi.fn(),
}));
const reads = vi.hoisted(() => new Map<string, unknown>());
const fleet = vi.hoisted(() => ({ machines: [] as { id: string; label: string; state: string; kind: string }[] }));
vi.mock('../rpc-client.js', () => ({
  rpcClient: {
    environment: { get: 'environment', approve: rpc.approve, revokeApproval: rpc.revokeApproval, runChecks: rpc.runChecks, runPhase: rpc.runPhase, putValue: rpc.putValue, setProfile: rpc.setProfile, cancelRun: rpc.cancelRun, runLog: rpc.runLog },
    runtime: { snapshot: 'snapshot', sync: rpc.sync, attachment: { cache: { request: rpc.cache }, detach: rpc.detach } },
    terminals: { create: rpc.createTerminal },
  },
}));
vi.mock('result-rpc/react', () => ({
  useResultQuery: (procedure: string) => reads.has(procedure) ? { state: 'success', value: reads.get(procedure), fetch: 'idle', refetch: async () => {} } : { state: 'pending', fetch: 'idle', refetch: async () => {} },
}));
vi.mock('../SynchronizationProvider.js', () => ({
  useAccountMachines: () => ({ state: 'success', value: fleet.machines, refetch: async () => {} }),
  useEnvironmentSynchronization: () => ({ value: undefined }),
}));
vi.mock('../RuntimeBrowser.js', () => ({ RuntimeBrowserGroups: () => null }));

const stamp = '2026-10-14T09:00:00.000Z';
const commit = 'a'.repeat(40);
const prepare = { content: '#!/bin/sh\npnpm install\n', fileName: '10-dependencies.sh' };
const login = { content: '#!/bin/sh\nread -r MFA\naws sts get-session-token\n', fileName: '30-aws-login.sh' };
const prepareHash = await executionHash({ kind: 'script', command: prepare.content });
const loginHash = await executionHash({ kind: 'script', command: login.content });
const nodeHash = await executionHash({ kind: 'check', command: 'node --version' });

function environment(): WorkspaceEnvironmentView {
  const lifecycle = emptyLifecycleState('project', 'workspace');
  return {
    spaceId: 'workspace', projectId: 'project',
    bundleJson: JSON.stringify({ version: 1, defaultProfile: 'base', profiles: { base: { checks: ['node'], secrets: ['NPM_TOKEN'], values: ['ADMIN_EMAILS'] } }, checks: { node: { kind: 'command', label: 'Node 24', command: 'node --version' } }, values: { ADMIN_EMAILS: {} }, browser: { origins: [] } }),
    selectedProfile: 'base', effective: { name: 'base', checks: ['node'], secrets: ['NPM_TOKEN'], values: ['ADMIN_EMAILS'], notes: [] },
    configuredSecrets: ['NPM_TOKEN'], secretMetadata: [{ projectId: 'project', name: 'NPM_TOKEN', revision: 1, updatedAt: stamp, updatedBy: 'device', source: 'project' }],
    values: { global: {}, project: { ADMIN_EMAILS: 'ops@example.com' }, workspace: {}, effective: { ADMIN_EMAILS: 'ops@example.com' } },
    executions: [
      { id: 'node', kind: 'check', label: 'Node 24', command: 'node --version', hash: nodeHash, content: 'node --version', approval: 'project', phase: null, fileName: null },
      { id: `machine/prepare:${login.fileName}`, kind: 'script', label: login.fileName, command: login.fileName, hash: loginHash, content: login.content, approval: 'project', phase: 'machine/prepare', fileName: login.fileName, interactive: true },
      { id: `workspace/materialize:${prepare.fileName}`, kind: 'script', label: prepare.fileName, command: prepare.fileName, hash: prepareHash, content: prepare.content, approval: null, phase: 'workspace/materialize', fileName: prepare.fileName, interactive: false },
    ],
    runs: [],
    lifecycle: { ...lifecycle, bundleJson: '{}', approvals: [{ scope: 'project', executionHash: nodeHash, approvedBy: 'device', approvedAt: stamp }, { scope: 'project', executionHash: loginHash, approvedBy: 'device', approvedAt: stamp }] },
  };
}

type MachineFixture = { id: string; online?: boolean; ready?: boolean; platform?: string; unsent?: number | null };
function snapshot(machines: MachineFixture[], conflicts: string[] = []): RuntimeSnapshot {
  return RuntimeSnapshotSchema.parse({
    version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 1, conversations: [], tasks: [], questions: [],
    attachments: machines.map(machine => ({ projectId: 'project', workspaceId: 'workspace', attachmentId: `attachment-${machine.id}`, machineId: machine.id, generation: 2, checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: stamp, cache: { state: 'live', platform: machine.platform ?? 'linux', lastSyncAt: stamp, setup: [] } })),
    documents: {
      'gitspace.code': { checkpointRef: 'refs/gitspace/checkpoint', headCommit: commit, branch: 'main', indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: commit, worktreeTree: commit, trackedWorktreeTree: commit },
      'gitspace.status': {
        summary: emptyWorkspaceStatus, cloud: { version: commit, conflicts },
        machines: machines.map(machine => ({ machineId: machine.id, attachmentId: `attachment-${machine.id}`, generation: 2, online: machine.online ?? true, ready: machine.ready ?? true, setup: [], sync: { lastSyncAt: stamp, unsent: machine.unsent === undefined ? 2 : machine.unsent, unapplied: false, problem: null, conflicts } })),
      },
    },
  });
}

let root: Root;
let container: HTMLDivElement;
let animationDescriptor: PropertyDescriptor | undefined;
const openTerminal = vi.fn();
const render = (runtime: RuntimeSnapshot) => act(() => root.render(<LiveEnvironment projectId="project" projectName="Golconda" workspaceName="Work" spaceId="workspace" workspace onOpenAgent={() => {}} runtimeContext={{ snapshot: runtime, onOpenTerminal: openTerminal }} />));
const buttons = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent === text);
const click = async (text: string, scope: ParentNode = document) => {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => { button!.click(); });
};
const chooseMenuItem = async (trigger: string, label: string) => {
  await act(async () => { document.querySelector<HTMLButtonElement>(`button[aria-label="${trigger}"]`)!.click(); });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(candidate => candidate.textContent?.includes(label));
  expect(item, label).toBeDefined();
  await act(async () => { item!.click(); });
};
const machineCard = (name: string) => document.querySelector(`[aria-label="Machine ${name}"]`)!;
const step = (name: string) => document.querySelector(`[aria-label="Setup step ${name}"]`)!;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  for (const mock of Object.values(rpc)) mock.mockReset().mockResolvedValue({ status: 'ok', value: {} });
  openTerminal.mockReset();
  reads.clear();
  reads.set('environment', environment());
  fleet.machines = [{ id: 'darktop', label: 'Darktop', state: 'online', kind: 'physical' }, { id: 'sandbox', label: 'Sandbox', state: 'sleeping', kind: 'sandbox' }, { id: 'mbp', label: 'MacBook Pro', state: 'offline', kind: 'physical' }];
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
  vi.unstubAllGlobals();
});

it('shows one status per machine from the status document, and No machine when none is attached', async () => {
  await render(snapshot([{ id: 'darktop' }, { id: 'sandbox', online: false, ready: false }, { id: 'mbp', online: false, ready: false, platform: 'darwin' }]));
  expect(machineCard('Darktop').querySelector('[role="status"]')?.textContent).toBe('Linux · online');
  expect(machineCard('Sandbox').querySelector('[role="status"]')?.textContent).toBe('Paused');
  expect(machineCard('MacBook Pro').querySelector('[role="status"]')?.textContent).toBe('Offline');
  await render(snapshot([{ id: 'darktop', ready: false, platform: 'darwin' }]));
  expect(machineCard('Darktop').querySelector('[role="status"]')?.textContent).toBe('macOS · starting');
  await render(snapshot([]));
  expect(document.querySelector('[aria-label="Machines"]')?.textContent).toContain('No machine');
  expect(document.querySelector('[aria-label="Overview"] [role="status"]')?.textContent).toContain('No machine');
});

it('lists the named setup steps with approvals and interactive scripts', async () => {
  rpc.runPhase.mockResolvedValue({ status: 'ok', value: { machineId: 'darktop', terminalName: 'lifecycle-1' } });
  await render(snapshot([{ id: 'darktop' }]));
  for (const name of ['Prepare machine', 'Prepare checkout', 'Checks', 'Agent setup']) expect(step(name), name).not.toBeNull();
  // An unapproved script needs approval; approving reviews its exact content first.
  expect(step('Prepare checkout').textContent).toContain('Needs approval');
  await click('Review & approve', step('Prepare checkout'));
  expect(document.body.textContent).toContain('pnpm install');
  await click('Approve this content');
  expect(rpc.approve).toHaveBeenCalledWith({ spaceId: 'workspace', scope: 'workspace', executionHash: prepareHash });
  // An approved interactive script runs only in a terminal on the machine, which then opens.
  const loginRow = step('Prepare machine').querySelector(`[aria-label="Script ${login.fileName}"]`)!;
  expect(loginRow.textContent).toContain('Interactive');
  expect(loginRow.textContent).not.toContain('Needs approval');
  await click('Run in terminal', loginRow);
  expect(rpc.runPhase).toHaveBeenCalledWith({ spaceId: 'workspace', machineId: 'darktop', runId: expect.any(String), phase: 'machine/prepare', rerun: true, interactive: true });
  expect(openTerminal).toHaveBeenCalledWith('darktop', 'lifecycle-1');
  await click('Revoke', loginRow);
  expect(rpc.revokeApproval).toHaveBeenCalledWith({ spaceId: 'workspace', scope: 'project', executionHash: loginHash });
  await click('Run checks', step('Checks'));
  expect(rpc.runChecks).toHaveBeenCalledWith({ spaceId: 'workspace', machineId: 'darktop', runId: expect.any(String) });
});

it('lists secrets and values by name and never renders a value', async () => {
  await render(snapshot([{ id: 'darktop' }]));
  const values = document.querySelector('[aria-label="Values"]')!;
  expect(values.querySelector('[aria-label="Secret NPM_TOKEN"]')?.textContent?.replaceAll('NPM_TOKENproject secret', '')).toBe('');
  expect(values.querySelector('[aria-label="Value ADMIN_EMAILS"]')?.textContent).toContain('project');
  expect(values.textContent).not.toContain('ops@example.com');
  await click('Edit', values);
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input')!;
    expect(input.value).toBe('ops@example.com');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'team@example.com');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Save');
  expect(rpc.putValue).toHaveBeenCalledWith({ spaceId: 'workspace', scope: 'workspace', name: 'ADMIN_EMAILS', value: 'team@example.com' });
});

it('runs the sync line through the sync operations on that machine', async () => {
  rpc.sync.mockImplementation(async ({ args }: { args: { method: string } }) => ({ status: 'ok', value: args.method === 'diff'
    ? { method: 'diff', unsent: [{ status: 'M', path: 'src/app.ts' }], unsentTruncated: false, notOnMachine: [{ status: 'A', path: 'docs/new.md' }], notOnMachineTruncated: false }
    : args.method === 'now' ? { method: 'now', version: commit, conflicts: [] } : { method: 'resolve', resolved: 'src/a.ts', keep: 'machine', backup: 'refs/gitspace/backups/cloud/1', conflicts: [] } }));
  await render(snapshot([{ id: 'darktop' }, { id: 'mbp', online: false, ready: false }], ['src/a.ts']));
  expect(machineCard('Darktop').textContent).toContain('2 unsent changes');
  await click('Sync now', machineCard('Darktop'));
  expect(rpc.sync).toHaveBeenLastCalledWith({ projectId: 'project', workspaceId: 'workspace', requestId: expect.any(String), args: { method: 'now', on: 'darktop' } });
  await click('Show unsent changes', machineCard('Darktop'));
  expect(rpc.sync).toHaveBeenLastCalledWith({ projectId: 'project', workspaceId: 'workspace', requestId: expect.any(String), args: { method: 'diff', on: 'darktop' } });
  expect(document.querySelector('[aria-label="Unsent changes"]')?.textContent).toContain('M src/app.ts');
  expect(document.querySelector('[aria-label="Unsent changes"]')?.textContent).toContain('A docs/new.md');
  await click('Close');
  // An offline machine cannot send or list its changes.
  expect([...machineCard('MacBook Pro').querySelectorAll('button')].filter(button => ['Sync now', 'Show unsent changes'].includes(button.textContent ?? '')).every(button => button.disabled)).toBe(true);
  await click('Keep machine', document.querySelector('[aria-label="Sync conflicts"]')!);
  expect(rpc.sync).toHaveBeenLastCalledWith({ projectId: 'project', workspaceId: 'workspace', requestId: expect.any(String), args: { method: 'resolve', path: 'src/a.ts', keep: 'machine' } });
  expect(rpc.sync).toHaveBeenCalledTimes(3);
});

it('opens a terminal in the checkout and runs checks from the machine menu', async () => {
  rpc.createTerminal.mockResolvedValue({ status: 'ok', value: { name: 'shell-1' } });
  await render(snapshot([{ id: 'darktop' }]));
  await chooseMenuItem('Darktop actions', 'Open terminal');
  expect(rpc.createTerminal).toHaveBeenCalledWith({ spaceId: 'workspace', machineId: 'darktop' });
  expect(openTerminal).toHaveBeenCalledWith('darktop', 'shell-1');
  await chooseMenuItem('Darktop actions', 'Run checks');
  expect(rpc.runChecks).toHaveBeenCalledWith({ spaceId: 'workspace', machineId: 'darktop', runId: expect.any(String) });
});

it('runs setup only on the chosen machine and never substitutes another after it is detached', async () => {
  await render(snapshot([{ id: 'darktop' }, { id: 'mbp' }]));
  expect(buttons('Run checks').some(button => !button.disabled)).toBe(false);
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Setup machine"]')!;
  await act(() => { select.value = 'mbp'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('Run checks', step('Checks'));
  expect(rpc.runChecks).toHaveBeenCalledWith({ spaceId: 'workspace', machineId: 'mbp', runId: expect.any(String) });
  await render(snapshot([{ id: 'darktop' }, { id: 'sandbox' }]));
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="Setup machine"]')!.value).toBe('');
  expect(buttons('Run checks').some(button => !button.disabled)).toBe(false);
});

it('requires explicit LFS consent before detaching a machine', async () => {
  const runtime = snapshot([{ id: 'darktop', online: false, ready: false }]);
  runtime.documents['gitspace.code'] = { ...RuntimeGitCheckpointSchema.parse(runtime.documents['gitspace.code']), lfs: { objects: [], heldBack: [{ path: 'assets/local.psd', kind: 'modified' }] } };
  await render(runtime);
  await chooseMenuItem('Darktop actions', 'Detach');
  expect(document.body.textContent).toContain('assets/local.psd');
  await click('Cancel');
  expect(rpc.detach).not.toHaveBeenCalled();
  await chooseMenuItem('Darktop actions', 'Detach');
  await click('Continue without them');
  expect(rpc.detach).toHaveBeenCalledWith({ projectId: 'project', workspaceId: 'workspace', machineId: 'darktop', attachmentId: 'attachment-darktop', generation: 2 });
});
