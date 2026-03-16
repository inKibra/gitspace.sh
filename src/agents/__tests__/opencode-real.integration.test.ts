import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const OPENCODE_PATH = spawnSync('which', ['opencode'], { encoding: 'utf8' }).stdout.trim();
const shouldRun = Boolean(OPENCODE_PATH);

let root = '';
let workspacePath = '';

describe.if(shouldRun)('real opencode integration', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitspace-opencode-real-'));
    workspacePath = join(root, 'workspace');
    mkdirSync(workspacePath, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: workspacePath });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('uses opencode serve, keeps attach alive, and skips replay recording for agent PTYs', async () => {
    const resultFile = join(root, 'result.json');
    const scriptFile = join(root, 'run-opencode-real-test.ts');
    const script = `
      import { applyTmuxLiteSandboxEnvironment } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/lib/tmux-lite/protocol.ts')}';
      import { LocalSessionBackend } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/session/backends/local-session-backend.ts')}';
      import { listSessions, killServer } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/lib/tmux-lite/cli.ts')}';
      import { listReplaysOffline } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/lib/tmux-lite/replay/service.ts')}';
      import { readStoredRuntime, listStoredRuntimes } from '${import.meta.dir.replace('/src/agents/__tests__', '/src/agents/opencode-store.ts')}';
      import { spawnSync } from 'node:child_process';
      import { writeFileSync } from 'node:fs';

      process.env.HOME = ${JSON.stringify(root)};
      applyTmuxLiteSandboxEnvironment('real-opencode-test');

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
        const created = await backend.createAgentSession('demo:ws-1', 'integration test');
        const runtime = await readStoredRuntime('demo:ws-1');
        const ps = runtime?.pid
          ? spawnSync('ps', ['-p', String(runtime.pid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim()
          : '';

        await backend.attachAgentSession('demo:ws-1', created[0].id);
        await Bun.sleep(4000);

        const sessions = await listSessions();
        const agent = sessions.find((session) => session.kind === 'agent');
        const replays = listReplaysOffline({ workspaceId: 'demo:ws-1', includeDismissed: true });

        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
          created,
          runtime,
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
      cwd: '/Users/bradleat/gitspace/gitspace.sh/workspaces/machine-setup',
      encoding: 'utf8',
      timeout: 60_000,
    });

    if (result.status !== 0) {
      throw new Error(`integration subprocess failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    const payload = JSON.parse(readFileSync(resultFile, 'utf8')) as {
      created: Array<{ id: string; title: string }>;
      runtime: { username: string; pid?: number } | null;
      ps: string;
      agent?: { hidden?: boolean; kind?: string; exitCode?: number; metadata?: Record<string, string> };
      replays: Array<{ sessionName: string }>;
      error?: string;
    };

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
});
