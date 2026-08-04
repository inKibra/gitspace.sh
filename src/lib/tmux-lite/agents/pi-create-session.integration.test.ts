import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { removeTmuxLiteSandbox } from '../protocol.js';

let root = '';
let workspaceOnePath = '';
let workspaceTwoPath = '';
// Single source of truth for the sandbox key: the subprocess applies it and
// afterEach removes it. Deriving it twice is how the /tmp leak started.
let sandboxName = '';
// The OMP agent dir this run is pinned to. Set POSITIVELY in the subprocess env
// (not merely unset): an inherited absolute PI_CODING_AGENT_DIR outranks HOME,
// and clearing it only falls back to ~/.omp/agent — also real host state. Either
// way the run reads (and can write) the developer's live agent dir.
let piAgentDir = '';

function writeWorkspaceProjectConfig(projectPath: string): void {
  writeFileSync(
    join(projectPath, '.config.json'),
    JSON.stringify({ repository: 'demo/demo', workspaceStatus: {} }),
  );
}

setDefaultTimeout(30_000);


describe('Pi session creation integration', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitspace-pi-create-'));
    sandboxName = `pi-create-${basename(root)}`;
    piAgentDir = join(root, 'gitspace', '.pi');
    const projectPath = join(root, 'gitspace', 'demo');
    workspaceOnePath = join(projectPath, 'workspaces', 'ws-1');
    workspaceTwoPath = join(projectPath, 'workspaces', 'ws-2');
    mkdirSync(workspaceOnePath, { recursive: true });
    mkdirSync(workspaceTwoPath, { recursive: true });
    writeWorkspaceProjectConfig(projectPath);
    spawnSync('git', ['init', '-q'], { cwd: workspaceOnePath });
    spawnSync('git', ['init', '-q'], { cwd: workspaceTwoPath });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    removeTmuxLiteSandbox(sandboxName);
  });

  test('creates a Pi session file for a non-current workspace under the expected managed root', async () => {
    const resultFile = join(root, 'pi-create-result.json');
    const scriptFile = join(root, 'run-pi-create-test.ts');
    const script = `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { applyTmuxLiteSandboxEnvironment } from '${import.meta.dir.replace('/src/lib/tmux-lite/agents', '/src/lib/tmux-lite/protocol.ts')}';
      import { LocalSessionBackend } from '${import.meta.dir.replace('/src/lib/tmux-lite/agents', '/src/session/backends/local-session-backend.ts')}';
      import { killServer } from '${import.meta.dir.replace('/src/lib/tmux-lite/agents', '/src/lib/tmux-lite/cli.ts')}';
      import { encodeSessionDirName, listPiSessions } from '${import.meta.dir.replace('/src/lib/tmux-lite/agents', '/src/lib/tmux-lite/agents/pi-session-files.ts')}';
      import { getPiAgentDir } from '${import.meta.dir.replace('/src/lib/tmux-lite/agents', '/src/lib/tmux-lite/agents/pi-runtime.ts')}';

      // HOME and PI_CODING_AGENT_DIR arrive via the subprocess env, not an
      // assignment here: OMP captures the agent dir when pi-utils is imported,
      // and the ESM imports above already ran by the time this line would run.
      applyTmuxLiteSandboxEnvironment(${JSON.stringify(sandboxName)});
      process.chdir(${JSON.stringify(workspaceOnePath)});

      const backend = new LocalSessionBackend({
        deps: {
          scanWorkspaces: async () => [
            {
              id: 'ws-1',
              name: 'ws-1',
              path: ${JSON.stringify(workspaceOnePath)},
              projectName: 'demo',
              branch: 'main',
              sessionCount: 0,
              isStale: false,
            },
            {
              id: 'ws-2',
              name: 'ws-2',
              path: ${JSON.stringify(workspaceTwoPath)},
              projectName: 'demo',
              branch: 'main',
              sessionCount: 0,
              isStale: false,
            },
          ],
        },
      });

      try {
        await backend.connect();
        const sessions = await backend.createAgentSession('demo:ws-2', 'integration pi session');
        await backend.openAgentSession('demo:ws-2', sessions[0].id);
        const agentDir = getPiAgentDir();
        const encodedWorkspaceTwo = encodeSessionDirName(${JSON.stringify(workspaceTwoPath)});
        const encodedWorkspaceOne = encodeSessionDirName(${JSON.stringify(workspaceOnePath)});
        const discoveredForTarget = listPiSessions(${JSON.stringify(workspaceTwoPath)});
        const discoveredForCurrent = listPiSessions(${JSON.stringify(workspaceOnePath)});

        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
          created: sessions,
          agentDir,
          encodedWorkspaceOne,
          encodedWorkspaceTwo,
          expectedTargetDir: join(agentDir, 'sessions', encodedWorkspaceTwo),
          currentDir: join(agentDir, 'sessions', encodedWorkspaceOne),
          targetCount: discoveredForTarget.length,
          currentCount: discoveredForCurrent.length,
          targetSessionIds: discoveredForTarget.map((session) => session.id),
          currentSessionIds: discoveredForCurrent.map((session) => session.id),
          targetTitles: discoveredForTarget.map((session) => session.title ?? null),
          cwd: process.cwd(),
        }));
      } catch (error) {
        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }));
        process.exitCode = 1;
      } finally {
        try {
          await backend.disconnect();
        } catch {}
        try {
          await killServer();
        } catch {}
      }
    `;

    writeFileSync(scriptFile, script);
    const execution = spawnSync('bun', [scriptFile], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: piAgentDir },
    });

    const resultRaw = existsSync(resultFile) ? readFileSync(resultFile, 'utf8') : '';
    const result = resultRaw ? JSON.parse(resultRaw) as Record<string, unknown> : null;

    if (execution.status !== 0) {
      throw new Error([
        `integration subprocess failed with status ${execution.status}`,
        `stdout:\n${execution.stdout || ''}`,
        `stderr:\n${execution.stderr || ''}`,
        `result:\n${resultRaw || '<missing>'}`,
      ].join('\n\n'));
    }
    expect(result).toBeTruthy();
    expect(result?.error).toBeUndefined();
    expect(result?.created).toBeArray();
    expect(result?.targetCount).toBeGreaterThan(0);
    expect(result?.currentCount).toBe(0);
    expect(result?.targetSessionIds).toEqual((result?.created as Array<{ id: string }>).map((session) => session.id));
    expect(result?.targetTitles).toEqual(['integration pi session']);
  });
});
