import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const OPENCODE_PATH = spawnSync('which', ['opencode'], { encoding: 'utf8' }).stdout.trim();
const shouldRun = Boolean(OPENCODE_PATH);

let root = '';
let workspacePath = '';

describe.if(shouldRun)('real opencode integration', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitspace-opencode-real-'));
    const projectPath = join(root, 'gitspace', 'demo');
    workspacePath = join(projectPath, 'workspaces', 'ws-1');
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(
      join(projectPath, '.config.json'),
      JSON.stringify({
        repository: 'demo/demo',
        workspaceStatus: {},
      }),
    );
    spawnSync('git', ['init', '-q'], { cwd: workspacePath });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('uses opencode serve, keeps attach alive, and skips replay recording for agent PTYs', async () => {
    const resultFile = join(root, 'result.json');
    const scriptFile = join(root, 'run-opencode-real-test.ts');
    const sandboxName = `real-opencode-${basename(root)}`;
    const script = `
      import { applyTmuxLiteSandboxEnvironment } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/lib/tmux-lite/protocol.ts')}';
      import { LocalSessionBackend } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/session/backends/local-session-backend.ts')}';
      import { listSessions, killServer } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/lib/tmux-lite/cli.ts')}';
      import { listReplaysOffline } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/lib/tmux-lite/replay/service.ts')}';
      import { OpenCodeClient } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/agents/opencode-client.ts')}';
      import { createOpenCodeBasicAuthHeader, defaultOpenCodeRuntimeManager } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/agents/opencode-runtime.ts')}';
      import { readStoredRuntime, listStoredRuntimes } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/agents/opencode-store.ts')}';
      import { spawnSync } from 'node:child_process';
      import { writeFileSync } from 'node:fs';

      async function waitForAgentSession() {
        const started = Date.now();
        while (Date.now() - started < 10000) {
          const sessions = await listSessions();
          const agent = sessions.find((session) => session.kind === 'agent');
          if (agent) {
            return { sessions, agent };
          }
          await Bun.sleep(200);
        }
        return { sessions: await listSessions(), agent: undefined };
      }

      process.env.HOME = ${JSON.stringify(root)};
      applyTmuxLiteSandboxEnvironment(${JSON.stringify(sandboxName)});

      const backend = new LocalSessionBackend({
        deps: {
          scanWorkspaces: async () => [{
            id: 'ws-1',
            name: 'ws-1',
            path: ${JSON.stringify(workspacePath)},
            projectName: 'demo',
            branch: 'main',
            sessionCount: 0,
            isStale: false,
          }],
        },
      });

      try {
        await backend.connect();
        const runtime = await defaultOpenCodeRuntimeManager.ensureMachineRuntime();
        const client = new OpenCodeClient({
          baseUrl: runtime.baseUrl,
          directory: ${JSON.stringify(workspacePath)},
          fetch: (input, init) => fetch(input, {
            ...init,
            headers: { ...(init?.headers ?? {}), authorization: createOpenCodeBasicAuthHeader(runtime) },
          }),
        });
        const createdSession = await client.createSession({ title: 'integration test' });
        const created = [{ id: createdSession.id, title: createdSession.title ?? createdSession.id }];
        const storedRuntime = await readStoredRuntime();
        const ps = runtime?.pid
          ? spawnSync('ps', ['-p', String(runtime.pid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim()
          : '';

        if (!created[0]) throw new Error('missing created session');
        await backend.attachAgentSession('demo:ws-1', created[0].id);
        const { sessions, agent } = await waitForAgentSession();
        const replays = listReplaysOffline({ workspaceId: 'demo:ws-1', includeDismissed: true });

        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
          created,
          runtime: storedRuntime ?? runtime,
          ps,
          agent,
          replays,
        }));
      } catch (error) {
        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }));
        process.exitCode = 1;
      } finally {
        try {
          const runtimes = await listStoredRuntimes();
          for (const runtime of runtimes) {
            if (runtime.pid) {
              try { process.kill(runtime.pid, 'SIGTERM'); } catch {}
            }
          }
        } catch {}
        try { await killServer(); } catch {}
        await Bun.sleep(50);
        process.exit(process.exitCode ?? 0);
      }
    `;
    writeFileSync(scriptFile, script);

    const result = spawnSync('bun', [scriptFile], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
    });

    const payload = JSON.parse(readFileSync(resultFile, 'utf8')) as {
      created: Array<{ id: string; title: string }>;
      runtime: { username: string; pid?: number } | null;
      ps: string;
      agent?: { hidden?: boolean; kind?: string; exitCode?: number; metadata?: Record<string, string> };
      replays: Array<{ sessionName: string }>;
      error?: string;
    };

    if (result.status !== 0) {
      throw new Error(`integration subprocess failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\npayload:\n${JSON.stringify(payload, null, 2)}`);
    }

    expect(payload.error).toBeUndefined();

    expect(payload.created).toHaveLength(1);
    expect(payload.runtime?.username).toBe('opencode');
    expect(payload.ps).toContain('opencode serve');
    expect(payload.ps).not.toContain('opencode web');
    expect(payload.agent).toBeDefined();
    expect(payload.agent?.kind).toBe('agent');
    expect(payload.agent?.hidden).toBe(true);
    expect(payload.agent?.exitCode).toBeUndefined();
    expect(payload.agent?.metadata?.workspaceId).toBe('demo:ws-1');
    expect(payload.replays.filter((replay) => replay.sessionName.startsWith('agent:'))).toEqual([]);
  }, 70_000);

  test('archived session does not reappear after attaching a different session', async () => {
    const resultFile = join(root, 'result-archive.json');
    const scriptFile = join(root, 'run-opencode-archive-test.ts');
    const sandboxName = `real-opencode-archive-${basename(root)}`;
    const runtimeStoreDir = join(root, 'runtime-store-archive');
    const script = `
      import { applyTmuxLiteSandboxEnvironment } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/lib/tmux-lite/protocol.ts')}';
      import { LocalSessionBackend } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/session/backends/local-session-backend.ts')}';
      import { getMachineSnapshot, killServer } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/lib/tmux-lite/cli.ts')}';
      import { OpenCodeClient } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/agents/opencode-client.ts')}';
      import { listStoredRuntimes } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/agents/opencode-store.ts')}';
      import { createOpenCodeBasicAuthHeader, defaultOpenCodeRuntimeManager } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/agents/opencode-runtime.ts')}';
      import { mkdirSync, writeFileSync } from 'node:fs';

      process.env.HOME = ${JSON.stringify(root)};
      process.env.OPENCODE_RUNTIME_STORE_DIR = ${JSON.stringify(runtimeStoreDir)};
      mkdirSync(process.env.OPENCODE_RUNTIME_STORE_DIR, { recursive: true });
      applyTmuxLiteSandboxEnvironment(${JSON.stringify(sandboxName)});

      const backend = new LocalSessionBackend({
        deps: {
          scanWorkspaces: async () => [{
            id: 'ws-1',
            name: 'ws-1',
            path: ${JSON.stringify(workspacePath)},
            projectName: 'demo',
            branch: 'main',
            sessionCount: 0,
            isStale: false,
          }],
        },
      });

      try {
        await backend.connect();
        const runtime = await defaultOpenCodeRuntimeManager.ensureMachineRuntime();
        const authHeader = createOpenCodeBasicAuthHeader(runtime);
        const client = new OpenCodeClient({
          baseUrl: runtime.baseUrl,
          directory: ${JSON.stringify(workspacePath)},
          fetch: (input, init) => fetch(input, {
            ...init,
            headers: { ...(init?.headers ?? {}), authorization: authHeader },
          }),
        });

        // Create session A and attach it.
        const sessionA = await client.createSession({ title: 'session-A to be archived' });
        await backend.attachAgentSession('demo:ws-1', sessionA.id);

        // Snapshot after attach: session A must be present.
        const snapshotAfterAttach = await getMachineSnapshot();
        const sessionAAfterAttach = snapshotAfterAttach.agentSessionsById[sessionA.id];

        // Archive session A via the IPC path (goes through daemon's agent-control.ts).
        await backend.archiveAgentSession('demo:ws-1', sessionA.id);

        // Snapshot immediately after archive: A must be archived.
        const snapshotAfterArchive = await getMachineSnapshot();
        const sessionAAfterArchive = snapshotAfterArchive.agentSessionsById[sessionA.id];

        // Create session B and attach it — this is the trigger that previously
        // caused archived sessions to reappear (via syncKnownSessions).
        const sessionB = await client.createSession({ title: 'session-B live' });
        await backend.attachAgentSession('demo:ws-1', sessionB.id);

        // Wait a moment for any reconcile/SSE to settle.
        await Bun.sleep(1500);

        // Final snapshot: session A must still be archived (not 'waiting'/'running').
        const snapshotFinal = await getMachineSnapshot();
        const sessionAFinal = snapshotFinal.agentSessionsById[sessionA.id];
        const sessionBFinal = snapshotFinal.agentSessionsById[sessionB.id];
        const workspaceFinal = snapshotFinal.workspacesById['demo:ws-1'];

        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
          sessionAId: sessionA.id,
          sessionBId: sessionB.id,
          sessionAAfterAttach: sessionAAfterAttach ? { state: sessionAAfterAttach.state } : null,
          sessionAAfterArchive: sessionAAfterArchive ? { state: sessionAAfterArchive.state } : null,
          sessionAFinal: sessionAFinal ? { state: sessionAFinal.state } : null,
          sessionBFinal: sessionBFinal ? { state: sessionBFinal.state } : null,
          workspaceSummary: workspaceFinal?.summary ?? null,
        }));
      } catch (error) {
        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }));
        process.exitCode = 1;
      } finally {
        try {
          const runtimes = await listStoredRuntimes();
          for (const runtime of runtimes) {
            if (runtime.pid) { try { process.kill(runtime.pid, 'SIGTERM'); } catch {} }
          }
        } catch {}
        try { await killServer(); } catch {}
        await Bun.sleep(50);
        process.exit(process.exitCode ?? 0);
      }
    `;
    writeFileSync(scriptFile, script);

    const result = spawnSync('bun', [scriptFile], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 90_000,
    });

    const payload = JSON.parse(readFileSync(resultFile, 'utf8')) as {
      sessionAId?: string;
      sessionBId?: string;
      sessionAAfterAttach?: { state: string } | null;
      sessionAAfterArchive?: { state: string } | null;
      sessionAFinal?: { state: string } | null;
      sessionBFinal?: { state: string } | null;
      workspaceSummary?: {
        agentCount?: number;
        archivedAgentCount?: number;
        waitingAgentCount?: number;
      } | null;
      error?: string;
    };

    if (result.status !== 0) {
      throw new Error(`archive-reappear subprocess failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\npayload:\n${JSON.stringify(payload, null, 2)}`);
    }

    expect(payload.error).toBeUndefined();

    // Session A was present and trackable after attach.
    expect(payload.sessionAAfterAttach?.state).not.toBe('archived');

    // Session A moved to archived after archiveAgentSession.
    expect(payload.sessionAAfterArchive?.state).toBe('archived');

    // After attaching session B, session A must STILL be archived — not 'waiting'.
    expect(payload.sessionAFinal?.state).toBe('archived');

    // Session B should be tracked as a live session.
    expect(payload.sessionBFinal).not.toBeNull();
    expect(payload.sessionBFinal?.state).not.toBe('archived');

    // Workspace summary: archived count reflects session A, it should NOT be
    // counted as a waiting agent.
    expect((payload.workspaceSummary?.archivedAgentCount ?? 0) >= 1).toBe(true);
  }, 100_000);

  test('transitions back to waiting/idle after model finishes writing', async () => {
    const resultFile = join(root, 'result-idle.json');
    const scriptFile = join(root, 'run-opencode-idle-test.ts');
    const sandboxName = `real-opencode-idle-${basename(root)}`;
    const runtimeStoreDir = join(root, 'runtime-store-idle');
    const script = `
      import { applyTmuxLiteSandboxEnvironment } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/lib/tmux-lite/protocol.ts')}';
      import { LocalSessionBackend } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/session/backends/local-session-backend.ts')}';
      import { getAgentState, getMachineSnapshot, killServer } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/lib/tmux-lite/cli.ts')}';
      import { OpenCodeClient } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/agents/opencode-client.ts')}';
      import { readStoredRuntime, listStoredRuntimes } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/agents/opencode-store.ts')}';
      import { createOpenCodeBasicAuthHeader, defaultOpenCodeRuntimeManager } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/agents/opencode-runtime.ts')}';
      import { mkdirSync, writeFileSync } from 'node:fs';

      async function waitForRunningThenIdle(workspaceId, sessionId, runtime, workspacePath) {
        const authHeader = createOpenCodeBasicAuthHeader(runtime);
        const client = new OpenCodeClient({
          baseUrl: runtime.baseUrl,
          directory: workspacePath,
          fetch: (input, init) => fetch(input, {
            ...init,
            headers: { ...(init?.headers ?? {}), authorization: authHeader },
          }),
        });

        // Send a SHORT prompt — fast enough to complete, long enough to observe busy first.
        const promptUrl = new URL(runtime.baseUrl + '/session/' + sessionId + '/prompt_async');
        promptUrl.searchParams.set('directory', workspacePath);
        const promptResponse = await fetch(promptUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: authHeader },
          body: JSON.stringify({
            parts: [{ type: 'text', text: 'Reply with exactly three words: one two three. Nothing else.' }],
          }),
        });
        const promptStatus = promptResponse.status;

        const history = [];
        let runningObserved = false;
        let idleObserved = false;
        const started = Date.now();

        // Phase 1: wait up to 30s for 'running' to appear.
        while (Date.now() - started < 30000) {
          const [statuses, agentState, snapshot] = await Promise.all([
            client.getSessionStatuses(),
            getAgentState(),
            getMachineSnapshot(),
          ]);
          const workspaceAgentState = agentState.find((item) => item.workspaceId === workspaceId) ?? null;
          const machineSession = snapshot.agentSessionsById[sessionId] ?? null;
          const sample = {
            phase: 'waiting-for-running',
            statuses,
            workspaceStatuses: workspaceAgentState?.statuses ?? {},
            machineSessionState: machineSession?.state ?? null,
            runningAgentCount: snapshot.workspacesById[workspaceId]?.summary.runningAgentCount ?? null,
            waitingAgentCount: snapshot.workspacesById[workspaceId]?.summary.waitingAgentCount ?? null,
          };
          history.push(sample);
          if (machineSession?.state === 'running') {
            runningObserved = true;
            break;
          }
          await Bun.sleep(200);
        }

        if (!runningObserved) {
          return { promptStatus, runningObserved: false, idleObserved: false, history };
        }

        // Phase 2: wait up to 60s for state to transition back to 'waiting'.
        const idleStart = Date.now();
        while (Date.now() - idleStart < 60000) {
          const [statuses, agentState, snapshot] = await Promise.all([
            client.getSessionStatuses(),
            getAgentState(),
            getMachineSnapshot(),
          ]);
          const workspaceAgentState = agentState.find((item) => item.workspaceId === workspaceId) ?? null;
          const machineSession = snapshot.agentSessionsById[sessionId] ?? null;
          const sample = {
            phase: 'waiting-for-idle',
            statuses,
            workspaceStatuses: workspaceAgentState?.statuses ?? {},
            machineSessionState: machineSession?.state ?? null,
            runningAgentCount: snapshot.workspacesById[workspaceId]?.summary.runningAgentCount ?? null,
            waitingAgentCount: snapshot.workspacesById[workspaceId]?.summary.waitingAgentCount ?? null,
          };
          history.push(sample);
          if (machineSession?.state === 'waiting') {
            idleObserved = true;
            break;
          }
          await Bun.sleep(500);
        }

        const [finalStatuses, finalAgentState, finalSnapshot] = await Promise.all([
          client.getSessionStatuses(),
          getAgentState(),
          getMachineSnapshot(),
        ]);
        const finalWorkspaceAgentState = finalAgentState.find((item) => item.workspaceId === workspaceId) ?? null;
        const finalMachineSession = finalSnapshot.agentSessionsById[sessionId] ?? null;
        return {
          promptStatus,
          runningObserved,
          idleObserved,
          final: {
            statuses: finalStatuses,
            workspaceStatuses: finalWorkspaceAgentState?.statuses ?? {},
            machineSessionState: finalMachineSession?.state ?? null,
            runningAgentCount: finalSnapshot.workspacesById[workspaceId]?.summary.runningAgentCount ?? null,
            waitingAgentCount: finalSnapshot.workspacesById[workspaceId]?.summary.waitingAgentCount ?? null,
          },
          history,
        };
      }

      process.env.HOME = ${JSON.stringify(root)};
      process.env.OPENCODE_RUNTIME_STORE_DIR = ${JSON.stringify(runtimeStoreDir)};
      mkdirSync(process.env.OPENCODE_RUNTIME_STORE_DIR, { recursive: true });
      applyTmuxLiteSandboxEnvironment(${JSON.stringify(sandboxName)});

      const backend = new LocalSessionBackend({
        deps: {
          scanWorkspaces: async () => [{
            id: 'ws-1',
            name: 'ws-1',
            path: ${JSON.stringify(workspacePath)},
            projectName: 'demo',
            branch: 'main',
            sessionCount: 0,
            isStale: false,
          }],
        },
      });

      try {
        await backend.connect();
        const runtime = await defaultOpenCodeRuntimeManager.ensureMachineRuntime();
        const client = new OpenCodeClient({
          baseUrl: runtime.baseUrl,
          directory: ${JSON.stringify(workspacePath)},
          fetch: (input, init) => fetch(input, {
            ...init,
            headers: { ...(init?.headers ?? {}), authorization: createOpenCodeBasicAuthHeader(runtime) },
          }),
        });
        const createdSession = await client.createSession({ title: 'integration idle transition' });
        const sessionId = createdSession.id;
        if (!sessionId) throw new Error('missing created session id');
        await backend.attachAgentSession('demo:ws-1', sessionId);

        const result = await waitForRunningThenIdle('demo:ws-1', sessionId, runtime, ${JSON.stringify(workspacePath)});

        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ sessionId, result }));
      } catch (error) {
        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }));
        process.exitCode = 1;
      } finally {
        try {
          const runtimes = await listStoredRuntimes();
          for (const runtime of runtimes) {
            if (runtime.pid) { try { process.kill(runtime.pid, 'SIGTERM'); } catch {} }
          }
        } catch {}
        try { await killServer(); } catch {}
        await Bun.sleep(50);
        process.exit(process.exitCode ?? 0);
      }
    `;
    writeFileSync(scriptFile, script);

    const result = spawnSync('bun', [scriptFile], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120_000,
    });

    const payload = JSON.parse(readFileSync(resultFile, 'utf8')) as {
      sessionId?: string;
      result?: {
        promptStatus: number;
        runningObserved: boolean;
        idleObserved: boolean;
        final?: {
          statuses?: Record<string, { type: string }>;
          workspaceStatuses?: Record<string, { type: string }>;
          machineSessionState?: string | null;
          runningAgentCount?: number | null;
          waitingAgentCount?: number | null;
        };
        history: Array<{
          phase: string;
          machineSessionState?: string | null;
          runningAgentCount?: number | null;
        }>;
      };
      error?: string;
    };

    if (result.status !== 0) {
      throw new Error(`idle-transition subprocess failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\npayload:\n${JSON.stringify(payload, null, 2)}`);
    }

    expect(payload.error).toBeUndefined();
    expect(payload.result?.promptStatus).toBe(204);
    expect(payload.result?.runningObserved).toBe(true);
    expect(payload.result?.idleObserved).toBe(true);
    expect(payload.result?.final?.machineSessionState).toBe('waiting');
    expect((payload.result?.final?.runningAgentCount ?? 1) === 0).toBe(true);
  }, 140_000);

  test('isolates opencode runtime store and propagates busy status into tmux-lite state', async () => {
    const resultFile = join(root, 'result-busy.json');
    const scriptFile = join(root, 'run-opencode-busy-test.ts');
    const sandboxName = `real-opencode-busy-${basename(root)}`;
    const runtimeStoreDir = join(root, 'runtime-store');
    const script = `
      import { applyTmuxLiteSandboxEnvironment } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/lib/tmux-lite/protocol.ts')}';
      import { LocalSessionBackend } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/session/backends/local-session-backend.ts')}';
      import { getAgentState, getMachineSnapshot, killServer } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/lib/tmux-lite/cli.ts')}';
      import { OpenCodeClient } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/agents/opencode-client.ts')}';
      import { readStoredRuntime, listStoredRuntimes, getStoredRuntimePath } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/agents/opencode-store.ts')}';
      import { createOpenCodeBasicAuthHeader, defaultOpenCodeRuntimeManager } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/agents/opencode-runtime.ts')}';
      import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';

      async function waitForBusy(workspaceId, sessionId, runtime, workspacePath) {
        const authHeader = createOpenCodeBasicAuthHeader(runtime);
        const client = new OpenCodeClient({
          baseUrl: runtime.baseUrl,
          directory: workspacePath,
          fetch: (input, init) => fetch(input, {
            ...init,
            headers: { ...(init?.headers ?? {}), authorization: authHeader },
          }),
        });

        const promptUrl = new URL(runtime.baseUrl + '/session/' + sessionId + '/prompt_async');
        promptUrl.searchParams.set('directory', workspacePath);
        const promptResponse = await fetch(promptUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: authHeader,
          },
          body: JSON.stringify({
            parts: [
              {
                type: 'text',
                text: 'Write a detailed numbered list from 1 to 150 about integration testing. Do not stop early. One sentence per item.',
              },
            ],
          }),
        });

        const promptText = await promptResponse.text();
        const started = Date.now();
        const history = [];
        while (Date.now() - started < 30000) {
          const [statuses, agentState, snapshot] = await Promise.all([
            client.getSessionStatuses(),
            getAgentState(),
            getMachineSnapshot(),
          ]);
          const workspaceAgentState = agentState.find((item) => item.workspaceId === workspaceId) ?? null;
          const machineSession = snapshot.agentSessionsById[sessionId] ?? null;
          const sample = {
            statuses,
            workspaceStatuses: workspaceAgentState?.statuses ?? {},
            machineSessionState: machineSession?.state ?? null,
            runningAgentCount: snapshot.workspacesById[workspaceId]?.summary.runningAgentCount ?? null,
          };
          history.push(sample);
          if (
            statuses[sessionId]?.type === 'busy'
            && workspaceAgentState?.statuses?.[sessionId]?.type === 'busy'
            && machineSession?.state === 'running'
            && snapshot.workspacesById[workspaceId]?.summary.runningAgentCount > 0
          ) {
            return {
              promptStatus: promptResponse.status,
              promptText,
              final: sample,
              history,
            };
          }
          await Bun.sleep(250);
        }

        return {
          promptStatus: promptResponse.status,
          promptText,
          final: history[history.length - 1] ?? null,
          history,
        };
      }

      process.env.HOME = ${JSON.stringify(root)};
      process.env.OPENCODE_RUNTIME_STORE_DIR = ${JSON.stringify(runtimeStoreDir)};
      mkdirSync(process.env.OPENCODE_RUNTIME_STORE_DIR, { recursive: true });
      applyTmuxLiteSandboxEnvironment(${JSON.stringify(sandboxName)});

      const backend = new LocalSessionBackend({
        deps: {
          scanWorkspaces: async () => [{
            id: 'ws-1',
            name: 'ws-1',
            path: ${JSON.stringify(workspacePath)},
            projectName: 'demo',
            branch: 'main',
            sessionCount: 0,
            isStale: false,
          }],
        },
      });

      try {
        await backend.connect();
        const runtime = await defaultOpenCodeRuntimeManager.ensureMachineRuntime();
        const client = new OpenCodeClient({
          baseUrl: runtime.baseUrl,
          directory: ${JSON.stringify(workspacePath)},
          fetch: (input, init) => fetch(input, {
            ...init,
            headers: { ...(init?.headers ?? {}), authorization: createOpenCodeBasicAuthHeader(runtime) },
          }),
        });
        const createdSession = await client.createSession({ title: 'integration busy propagation' });
        const created = [{ id: createdSession.id, title: createdSession.title ?? createdSession.id }];
        if (!created[0]) {
          throw new Error('missing created session');
        }
        await backend.attachAgentSession('demo:ws-1', created[0].id);

        const storedRuntime = await readStoredRuntime();
        const runtimePath = getStoredRuntimePath();
        const ps = runtime.pid
          ? spawnSync('ps', ['-p', String(runtime.pid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim()
          : '';

        const busy = await waitForBusy('demo:ws-1', created[0].id, runtime, ${JSON.stringify(workspacePath)});

        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
          created,
          runtime: storedRuntime ?? runtime,
          runtimePath,
          runtimePathExists: existsSync(runtimePath),
          ps,
          busy,
        }));
      } catch (error) {
        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }));
        process.exitCode = 1;
      } finally {
        try {
          const runtimes = await listStoredRuntimes();
          for (const runtime of runtimes) {
            if (runtime.pid) {
              try { process.kill(runtime.pid, 'SIGTERM'); } catch {}
            }
          }
        } catch {}
        try { await killServer(); } catch {}
        await Bun.sleep(50);
        process.exit(process.exitCode ?? 0);
      }
    `;
    writeFileSync(scriptFile, script);

    const result = spawnSync('bun', [scriptFile], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 90_000,
    });

    const payload = JSON.parse(readFileSync(resultFile, 'utf8')) as {
      created?: Array<{ id: string; title: string }>;
      runtime?: { username: string; pid?: number } | null;
      runtimePath?: string;
      runtimePathExists?: boolean;
      ps?: string;
      busy?: {
        promptStatus: number;
        promptText: string;
        final: {
          statuses?: Record<string, { type: string }>;
          workspaceStatuses?: Record<string, { type: string }>;
          machineSessionState?: string | null;
          runningAgentCount?: number | null;
        } | null;
        history: Array<{
          statuses?: Record<string, { type: string }>;
          workspaceStatuses?: Record<string, { type: string }>;
          machineSessionState?: string | null;
          runningAgentCount?: number | null;
        }>;
      };
      error?: string;
    };

    if (result.status !== 0) {
      throw new Error(`busy integration subprocess failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\npayload:\n${JSON.stringify(payload, null, 2)}`);
    }

    expect(payload.error).toBeUndefined();
    expect(payload.created).toHaveLength(1);
    expect(payload.runtime?.username).toBe('opencode');
    expect(payload.ps).toContain('opencode serve');
    expect(payload.runtimePath).toBe(join(runtimeStoreDir, 'runtimes', 'machine.json'));
    expect(payload.runtimePathExists).toBe(true);
    expect(existsSync(join(runtimeStoreDir, 'runtimes', 'machine.json'))).toBe(true);
    expect(payload.busy?.promptStatus).toBe(204);
    expect(payload.busy?.final?.statuses?.[payload.created![0].id]?.type).toBe('busy');
    expect(payload.busy?.final?.workspaceStatuses?.[payload.created![0].id]?.type).toBe('busy');
    expect(payload.busy?.final?.machineSessionState).toBe('running');
    expect((payload.busy?.final?.runningAgentCount ?? 0) > 0).toBe(true);
  }, 100_000);
});
