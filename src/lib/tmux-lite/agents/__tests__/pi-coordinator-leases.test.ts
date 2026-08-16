import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiCoordinator, type PiWorkspaceTarget, type SessionHostFactory } from '../pi-coordinator.js';
import type { AgentSessionHost } from '../session-host.js';
import { encodeSessionDirName } from '../pi-session-files.js';

const workspacePath = mkdtempSync(join(tmpdir(), 'pi-lease-workspace-'));
const sessionsRoot = mkdtempSync(join(tmpdir(), 'pi-lease-sessions-'));
const target: PiWorkspaceTarget = {
  workspaceId: 'project:workspace',
  workspaceName: 'workspace',
  workspacePath,
  projectName: 'project',
};

function createPiSessionFile(agentSessionId: string): void {
  const sessionDir = join(sessionsRoot, encodeSessionDirName(workspacePath));
  mkdirSync(sessionDir, { recursive: true });
  const header = JSON.stringify({
    type: 'session',
    id: agentSessionId,
    cwd: workspacePath,
    timestamp: '2026-08-01T00:00:00.000Z',
  });
  writeFileSync(join(sessionDir, `2026-08-01T00-00-00-000Z_${agentSessionId}.jsonl`), `${header}\n`);
}

for (const id of ['session-a', 'session-b', 'session-c']) createPiSessionFile(id);

interface FakeHostControl {
  host: AgentSessionHost;
  disposeCount: number;
}

function createCoordinator(): {
  coordinator: PiCoordinator;
  hosts: Map<string, FakeHostControl>;
  factoryCalls: { count: number };
} {
  const hosts = new Map<string, FakeHostControl>();
  const factoryCalls = { count: 0 };
  const hostFactory: SessionHostFactory = async (_target, boot) => {
    factoryCalls.count += 1;
    if (boot.mode !== 'open') throw new Error('test host only supports reopening sessions');
    const fileName = basename(boot.sessionFilePath);
    const agentSessionId = fileName.slice(fileName.indexOf('_') + 1, -'.jsonl'.length);
    const control = { host: undefined as unknown as AgentSessionHost, disposeCount: 0 };
    control.host = {
      sessionId: agentSessionId,
      dispose: async () => {
        control.disposeCount += 1;
      },
      kill: () => {},
      prompt: async () => {},
      interrupt: async () => false,
      compact: async () => false,
      removeQueuedMessage: async () => null,
      setModel: async () => false,
      getControlInfo: async () => ({} as never),
      cycleRole: async () => false,
      applyRole: async () => false,
      setThinkingLevel: async () => false,
      setApprovalMode: async () => false,
      setSetting: async () => false,
      getTools: async () => [],
      getHistory: async () => [],
      navigateHistory: async () => ({ ok: false }),
      getSessionTree: async () => [],
      readTranscriptRange: async () => ({ blocks: [], oldestCursor: null, hasMore: false }),
      listSessionCommands: async () => [],
      getGoalMode: async () => ({ enabled: false, available: true }),
      setGoalMode: async () => ({ enabled: false, available: true }),
      shake: async () => ({ mode: 'images', toolResultsDropped: 0, blocksDropped: 0, imagesDropped: 0, tokensFreed: 0 }),
      enableUI: () => {},
      uiEnabled: false,
      resolveDialog: async () => false,
      setEditorTextFromClient: () => {},
      setTitle: () => {},
    } as unknown as AgentSessionHost;
    hosts.set(agentSessionId, control);
    return control.host;
  };
  return { coordinator: new PiCoordinator(sessionsRoot, { hostFactory }), hosts, factoryCalls };
}

afterAll(() => {
  rmSync(workspacePath, { recursive: true, force: true });
  rmSync(sessionsRoot, { recursive: true, force: true });
});

describe('PiCoordinator viewer leases', () => {
  // Leases record ATTENTION, never lifetime. Losing the last viewer means
  // nobody is watching — not that the work should stop. A session with no turn
  // in flight may still owe a queued message, a pending human answer, or a
  // running subagent, none of which survive disposal, so releasing a lease must
  // never dispose a host.
  it('tracks lease counts exactly and never disposes the host on release', async () => {
    const { coordinator, hosts } = createCoordinator();
    expect(await coordinator.openAgentSession(target, 'session-a', 'sock-a:pane-1')).toBe(1);
    expect(await coordinator.openAgentSession(target, 'session-a', 'sock-b:pane-2')).toBe(2);

    expect(coordinator.releaseAgentLease('session-a', 'sock-a:pane-1')).toEqual({ workspaceId: target.workspaceId, remaining: 1 });
    await Promise.resolve();
    expect(hosts.get('session-a')?.disposeCount).toBe(0);

    // Last viewer gone: the count reaches zero, the host keeps running.
    expect(coordinator.releaseAgentLease('session-a', 'sock-b:pane-2')).toEqual({ workspaceId: target.workspaceId, remaining: 0 });
    await Promise.resolve();
    expect(hosts.get('session-a')?.disposeCount).toBe(0);
  });

  it('returns null for an unknown lease without disposing a host', () => {
    const { coordinator, hosts } = createCoordinator();

    expect(coordinator.releaseAgentLease('session-a', 'missing-lease')).toBeNull();
    expect(hosts.size).toBe(0);
  });

  it('releases one owner across multiple sessions while preserving another owner', async () => {
    const { coordinator, hosts } = createCoordinator();

    await coordinator.openAgentSession(target, 'session-b', 'sock1:pane-b');
    await coordinator.openAgentSession(target, 'session-b', 'sock2:pane-b');
    await coordinator.openAgentSession(target, 'session-c', 'sock1:pane-c');
    await coordinator.openAgentSession(target, 'session-c', 'sock2:pane-c');

    coordinator.releaseAgentLeasesForOwner('sock1:');
    expect(coordinator.releaseAgentLease('session-b', 'sock1:pane-b')).toBeNull();
    expect(coordinator.releaseAgentLease('session-c', 'sock1:pane-c')).toBeNull();
    expect(hosts.get('session-b')?.disposeCount).toBe(0);
    expect(hosts.get('session-c')?.disposeCount).toBe(0);

    // A disconnecting client stops watching everything it was watching; a
    // dropped connection is not an instruction to abandon work.
    expect(coordinator.releaseAgentLease('session-b', 'sock2:pane-b')).toEqual({ workspaceId: target.workspaceId, remaining: 0 });
    expect(coordinator.releaseAgentLease('session-c', 'sock2:pane-c')).toEqual({ workspaceId: target.workspaceId, remaining: 0 });
    await Promise.resolve();
    expect(hosts.get('session-b')?.disposeCount).toBe(0);
    expect(hosts.get('session-c')?.disposeCount).toBe(0);
  });


  it('rejects an open when the Pi session file does not exist', async () => {
    const { coordinator, hosts, factoryCalls } = createCoordinator();

    await expect(coordinator.openAgentSession(target, 'missing-session', 'sock:pane')).rejects.toThrow("Pi session 'missing-session' not found");
    expect(factoryCalls.count).toBe(0);
    expect(hosts.size).toBe(0);
  });
});
