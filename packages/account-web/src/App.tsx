import type { DeploymentStatusView } from '@gitspace/protocol';
import type { WorkspaceStatusSummary } from '@gitspace/protocol/workspace-status';
import type { SidebarDeploymentProps } from './AppSidebar.js';
import { GitSpaceShell, type GitSpaceShellProps, type WorkspaceView } from './GitSpaceShell.js';
import { LaunchSheet } from './LaunchSheet.js';
import { launchTrackFrom, type LaunchTrack } from './release.js';

const status = (primaryColor: WorkspaceStatusSummary['primaryColor']): WorkspaceStatusSummary => ({
  primaryColor,
  agents: { green: primaryColor === 'green' ? 1 : 0, blue: primaryColor === 'blue' ? 1 : 0, orange: primaryColor === 'orange' ? 1 : 0, red: primaryColor === 'red' ? 1 : 0 },
  services: { green: 0, red: 0 },
  terminals: { green: 0, red: 0 },
});

const unrelated: Pick<WorkspaceView, 'relations' | 'stack'> = { relations: { dependsOn: [], relatedTo: [], stackedOn: null }, stack: { blockedBy: [], blocking: [], findings: [] } };

export const verticalSliceFixture: GitSpaceShellProps = {
  project: { id: 'project-a', name: 'GitSpace', repository: 'gitspace.sh', connected: true },
  workspace: { kind: 'workspace', id: 'workspace-a', projectId: 'project-a', projectName: 'GitSpace', name: 'agent-blame', branch: 'develop', phase: 'code', generation: 1, possessedBy: 'Darktop', holder: { kind: 'held', machineId: 'darktop', label: 'Darktop' }, status: status('green'), closedAt: null, ...unrelated },
  baseSpace: { kind: 'project', id: 'project-a', projectId: 'project-a', projectName: 'GitSpace', name: 'GitSpace', branch: 'develop', phase: null, generation: 1, possessedBy: 'Darktop', holder: { kind: 'held', machineId: 'darktop', label: 'Darktop' }, status: status('blue'), closedAt: null },
  workspaces: [
    { kind: 'workspace', id: 'workspace-a', projectId: 'project-a', projectName: 'GitSpace', name: 'agent-blame', branch: 'develop', phase: 'code', generation: 1, possessedBy: 'Darktop', holder: { kind: 'held', machineId: 'darktop', label: 'Darktop' }, status: status('green'), closedAt: null, ...unrelated },
    { kind: 'workspace', id: 'workspace-b', projectId: 'project-a', projectName: 'GitSpace', name: 'relay-hardening', branch: 'relay-hardening', phase: 'review', generation: 1, possessedBy: 'Darktop', holder: { kind: 'held', machineId: 'darktop', label: 'Darktop' }, status: status('orange'), closedAt: null, ...unrelated },
    { kind: 'workspace', id: 'workspace-c', projectId: 'project-b', projectName: 'Website', name: 'release', branch: 'release/1.0', phase: 'ship', generation: 1, possessedBy: 'Studio', holder: { kind: 'held', machineId: 'studio', label: 'Studio' }, status: status('blue'), closedAt: null, ...unrelated },
  ],
  mainAgent: { id: 'session-a', title: 'Workspace agent', state: 'running', model: 'GPT-5.6' },
  turns: [{
    id: 'turn-1', type: 'turn', status: 'done',
    user: { id: 'turn-1-user', type: 'message', role: 'user', text: 'Build the GitSpace 1.0 working loop.' },
    items: [
      { id: 'turn-1-thinking', type: 'thinking', text: 'I should update the shell and preserve workspace status semantics.' },
      { id: 'turn-1-tool', type: 'tool-call', toolCallId: 'write-1', tool: 'write', target: 'packages/account-web/src/GitSpaceShell.tsx', status: 'done', result: [{ id: 'write-result', type: 'code', text: 'Created the new panel shell.', language: 'text' }] },
      { id: 'turn-1-message', type: 'message', role: 'assistant', text: 'The workspace now has one main agent, nested side agents, and contextual project surfaces.' },
    ],
    sideAgents: [{ id: 'turn-1-side', type: 'side-agent', agentId: 'reviewer', label: 'UX review', agent: 'reviewer', status: 'done', summary: 'Panel hierarchy is consistent.' }],
  }],
  transport: [],
  artifacts: [
    { url: 'local://base/reference.txt', name: 'reference.txt', path: 'reference.txt', scope: 'base', size: 824, mediaType: 'text/plain' },
    { url: 'local://workspace/apps/demo/index.html', name: 'index.html', path: 'apps/demo/index.html', scope: 'workspace', size: 1842, mediaType: 'text/html' },
  ],
};

/**
 * One launched release from `workspace-a` (worker/frontend applied, machine
 * and OMP converging) while a second launch from `workspace-b` builds here.
 */
export const deploymentStatusFixture: DeploymentStatusView = {
  desired: { worker: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', machine: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', omp: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', frontend: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', updatedAt: '2026-08-30T10:00:00.000Z' },
  current: {
    worker: { sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', version: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' },
    machines: { darktop: { sha: null, ompSha: null, generation: 'gen-0f3a9c' }, studio: { sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', ompSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', generation: 'gen-77ab21' } },
  },
  releases: [{
    sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    label: 'agent-blame @ a1b2c3d',
    workspaceId: 'workspace-a',
    builtBy: 'darktop',
    createdAt: '2026-08-30T09:58:00.000Z',
    artifacts: {
      worker: { key: 'releases/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/worker.mjs', hash: `sha256:${'1'.repeat(64)}`, size: 1024 },
      machine: { key: 'releases/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/machine.js', hash: `sha256:${'2'.repeat(64)}`, size: 2048 },
      omp: { key: 'releases/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/omp.js', hash: `sha256:${'4'.repeat(64)}`, size: 8192 },
      frontend: { key: 'releases/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0/frontend', hash: `sha256:${'3'.repeat(64)}`, size: 4096 },
    },
    omp: { upstreamVersion: '18.1.10', bunVersion: '1.4.0', packages: { '@oh-my-pi/pi-coding-agent': '18.1.10' }, patches: [] },
    status: { worker: 'applied', frontend: 'applied', machines: { studio: 'applied' }, omps: { studio: 'applied' } },
    error: null,
  }],
  thisMachine: { machineId: 'darktop', sha: null, ompSha: null, ompDraining: 0, generation: 'gen-0f3a9c' },
  launch: {
    launchId: 'launch-7',
    workspaceId: 'workspace-b',
    targets: ['worker', 'machine', 'omp', 'frontend'],
    sha: 'b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6',
    phase: 'build',
    message: 'building machine daemon',
    status: 'running',
    error: null,
    startedAt: '2026-08-30T10:04:00.000Z',
    updatedAt: '2026-08-30T10:05:10.000Z',
  },
};

/** The running launch above as this browser followed it: install done, worker built and uploaded, machine building. */
export const launchTrackFixture: LaunchTrack = {
  ...launchTrackFrom(deploymentStatusFixture.launch!),
  log: [
    { phase: 'install', message: 'bun install --frozen-lockfile in /srv/workspaces/relay-hardening', at: '2026-08-30T10:04:05.000Z' },
    { phase: 'build', message: 'building tenant worker', at: '2026-08-30T10:04:30.000Z' },
    { phase: 'upload', message: 'uploading releases/b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6/worker.mjs', at: '2026-08-30T10:05:00.000Z' },
    { phase: 'build', message: 'building machine daemon', at: '2026-08-30T10:05:10.000Z' },
  ],
};

export const sidebarDeploymentFixture: SidebarDeploymentProps = {
  status: deploymentStatusFixture,
  launch: launchTrackFixture,
  isGitSpaceProject: true,
  onLaunch: () => undefined,
  onRevert: () => undefined,
};

export function App() {
  return <>
    <GitSpaceShell {...verticalSliceFixture} deployment={sidebarDeploymentFixture} />
    <LaunchSheet launch={launchTrackFixture} open onOpenChange={() => undefined} onRetry={() => undefined} />
  </>;
}
