import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

setDefaultTimeout(150_000);

let root = '';
let workspacePath = '';

function writeWorkspaceProjectConfig(projectPath: string): void {
  writeFileSync(
    join(projectPath, '.config.json'),
    JSON.stringify({ repository: 'demo/demo', workspaceStatus: {} }),
  );
}

function buildSubprocessPrelude(): string {
  return `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import {
      openAgentSession,
      createAgentSession,
      getAgentState,
      getMachineSnapshot,
      killServer,
      promptAgentSession,
    } from '${import.meta.dir.replace('/src/lib/tmux-lite/agents', '/src/lib/tmux-lite/cli.ts')}';
    import { applyTmuxLiteSandboxEnvironment } from '${import.meta.dir.replace('/src/lib/tmux-lite/agents', '/src/lib/tmux-lite/protocol.ts')}';

    const workspaceId = 'demo:ws-1';
    const target = {
      workspaceId,
      workspaceName: 'ws-1',
      workspacePath: ${JSON.stringify(workspacePath)},
      projectName: 'demo',
    };

    process.env.HOME = ${JSON.stringify(root)};
    applyTmuxLiteSandboxEnvironment(${JSON.stringify(`pi-busy-${basename(root)}`)});

    // Hermetic model backend: the sandbox HOME has no provider credentials, so
    // without one the SDK selects no model and prompt() fails before
    // 'agent_start' ever fires — the busy status would never be set. Serve a
    // local OpenAI-compatible streaming endpoint and register it as a custom
    // provider via models.json so a real turn runs (agent_start → busy)
    // without network access or credentials. The response streams slowly
    // (~15s) so the turn stays running while the test polls for busy.
    const mockEncoder = new TextEncoder();
    const mockSse = (payload: unknown) => mockEncoder.encode('data: ' + JSON.stringify(payload) + '\\n\\n');
    const mockModelServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 120,
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith('/chat/completions')) {
          return new Response('not found', { status: 404 });
        }
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model' };
              controller.enqueue(mockSse({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }));
              for (let i = 1; i <= 60; i++) {
                controller.enqueue(mockSse({ ...base, choices: [{ index: 0, delta: { content: i + '. streaming line\\n' }, finish_reason: null }] }));
                await Bun.sleep(250);
              }
              controller.enqueue(mockSse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 60, total_tokens: 70 } }));
              controller.enqueue(mockEncoder.encode('data: [DONE]\\n\\n'));
              controller.close();
            } catch {
              // Client disconnected mid-stream (daemon killed) — expected.
            }
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const mockModelsConfig = JSON.stringify({
      providers: {
        mockai: {
          baseUrl: 'http://127.0.0.1:' + mockModelServer.port + '/v1',
          api: 'openai-completions',
          apiKey: 'mock-key',
          models: [{ id: 'mock-model', name: 'Mock Model', contextWindow: 200000, maxTokens: 32768, supportsTools: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    }, null, 2);
    // OMP reads models.json from the default agent dir (~/.omp/agent) when
    // PI_CODING_AGENT_DIR wasn't set at pi-utils import time, and from the
    // GitSpace-managed dir (<workspace-root>/.pi) once it is. Write both so
    // every daemon/worker process resolves the mock provider.
    for (const dir of [join(${JSON.stringify(root)}, '.omp', 'agent'), join(${JSON.stringify(root)}, 'gitspace', '.pi')]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'models.json'), mockModelsConfig);
    }
    function stopMockModelServer(): void {
      try { mockModelServer.stop(true); } catch {}
    }

    const busyPrompt = 'Write a detailed numbered list from 1 to 120 about terminal state propagation. One sentence per item.';

    async function captureState(sessionId: string) {
      const [agentState, snapshot] = await Promise.all([
        getAgentState(),
        getMachineSnapshot(),
      ]);
      const workspaceAgentState = agentState.find((item) => item.workspaceId === workspaceId) ?? null;
      return {
        controlStatusType: workspaceAgentState?.statuses?.[sessionId]?.type ?? null,
        machineSessionState: snapshot.agentSessionsById[sessionId]?.state ?? null,
        runningAgentCount: snapshot.workspacesById[workspaceId]?.summary.runningAgentCount ?? null,
        waitingAgentCount: snapshot.workspacesById[workspaceId]?.summary.waitingAgentCount ?? null,
      };
    }

    async function waitForBusy(sessionId: string) {
      const started = Date.now();
      let final = null;
      while (Date.now() - started < 30_000) {
        final = await captureState(sessionId);
        if (
          final.controlStatusType === 'busy' &&
          final.machineSessionState === 'running' &&
          (final.runningAgentCount ?? 0) > 0
        ) {
          return final;
        }
        await Bun.sleep(250);
      }
      return final;
    }

    async function writeResult(path: string, payload: unknown): Promise<void> {
      writeFileSync(path, JSON.stringify(payload, null, 2));
    }
  `;
}

function runIntegrationScript(name: string, scriptBody: string) {
  const resultFile = join(root, `${name}-result.json`);
  const scriptFile = join(root, `${name}.ts`);
  const script = `${buildSubprocessPrelude()}\n${scriptBody.replaceAll('__RESULT_FILE__', JSON.stringify(resultFile))}`;

  writeFileSync(scriptFile, script);
  const execution = spawnSync('bun', [scriptFile], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
  });

  const resultRaw = existsSync(resultFile) ? readFileSync(resultFile, 'utf8') : '';
  const result = resultRaw ? JSON.parse(resultRaw) as Record<string, unknown> : null;

  if (execution.status !== 0) {
    throw new Error([
      `busy integration subprocess failed with status ${execution.status}`,
      `stdout:\n${execution.stdout || ''}`,
      `stderr:\n${execution.stderr || ''}`,
      `result:\n${resultRaw || '<missing>'}`,
    ].join('\n\n'));
  }

  return result;
}

describe('Pi busy state integration', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitspace-pi-busy-'));
    const projectPath = join(root, 'gitspace', 'demo');
    workspacePath = join(projectPath, 'workspaces', 'ws-1');
    mkdirSync(workspacePath, { recursive: true });
    writeWorkspaceProjectConfig(projectPath);
    spawnSync('git', ['init', '-q'], { cwd: workspacePath });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('marks a live Pi session busy while a prompt is running', async () => {
    const result = runIntegrationScript('run-pi-busy-test', `
      try {
        const created = await createAgentSession(target, 'busy integration');
        if (!created[0]) throw new Error('missing created session');

        const sessionId = created[0].id;
        const promptPromise = promptAgentSession(target, sessionId, busyPrompt);
        const final = await waitForBusy(sessionId);
        await killServer();
        await Promise.allSettled([promptPromise]);

        await writeResult(__RESULT_FILE__, { created, final });
      } catch (error) {
        await writeResult(__RESULT_FILE__, {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        process.exitCode = 1;
      } finally {
        try { await killServer(); } catch {}
        stopMockModelServer();
      }
    `);

    expect(result?.error).toBeUndefined();
    expect((result?.created as Array<{ id: string }> | undefined)?.length).toBeGreaterThan(0);
    expect((result?.final as { controlStatusType?: string | null } | undefined)?.controlStatusType).toBe('busy');
    expect((result?.final as { machineSessionState?: string | null } | undefined)?.machineSessionState).toBe('running');
    expect(((result?.final as { runningAgentCount?: number | null } | undefined)?.runningAgentCount ?? 0) > 0).toBe(true);
  });

  test('reopens an existing Pi session after tmux-lite restart and marks it busy again', async () => {
    const result = runIntegrationScript('run-pi-busy-resume-after-restart', `
      try {
        const created = await createAgentSession(target, 'restart resume integration');
        if (!created[0]) throw new Error('missing created session');

        const sessionId = created[0].id;
        await promptAgentSession(target, sessionId, 'Reply with the single word ready.');
        await killServer();
        await Bun.sleep(500);

        await openAgentSession(target, sessionId);
        const beforePrompt = await captureState(sessionId);
        const promptPromise = promptAgentSession(target, sessionId, busyPrompt);
        const final = await waitForBusy(sessionId);
        await killServer();
        await Promise.allSettled([promptPromise]);

        await writeResult(__RESULT_FILE__, {
          created,
          beforePrompt,
          final,
        });
      } catch (error) {
        await writeResult(__RESULT_FILE__, {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        process.exitCode = 1;
      } finally {
        try { await killServer(); } catch {}
        stopMockModelServer();
      }
    `);

    expect(result?.error).toBeUndefined();
    expect((result?.beforePrompt as { machineSessionState?: string | null } | undefined)?.machineSessionState).toBe('waiting');
    expect((result?.final as { controlStatusType?: string | null } | undefined)?.controlStatusType).toBe('busy');
    expect((result?.final as { machineSessionState?: string | null } | undefined)?.machineSessionState).toBe('running');
    expect(((result?.final as { runningAgentCount?: number | null } | undefined)?.runningAgentCount ?? 0) > 0).toBe(true);
  });

  test('still marks a brand-new Pi session busy after tmux-lite restart', async () => {
    const result = runIntegrationScript('run-pi-busy-new-after-restart', `
      try {
        await getMachineSnapshot();
        await killServer();
        await Bun.sleep(500);

        const created = await createAgentSession(target, 'restart new integration');
        if (!created[0]) throw new Error('missing created session');

        const sessionId = created[0].id;
        const promptPromise = promptAgentSession(target, sessionId, busyPrompt);
        const final = await waitForBusy(sessionId);
        await killServer();
        await Promise.allSettled([promptPromise]);

        await writeResult(__RESULT_FILE__, {
          created,
          final,
        });
      } catch (error) {
        await writeResult(__RESULT_FILE__, {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        process.exitCode = 1;
      } finally {
        try { await killServer(); } catch {}
        stopMockModelServer();
      }
    `);

    expect(result?.error).toBeUndefined();
    expect((result?.final as { controlStatusType?: string | null } | undefined)?.controlStatusType).toBe('busy');
    expect((result?.final as { machineSessionState?: string | null } | undefined)?.machineSessionState).toBe('running');
    expect(((result?.final as { runningAgentCount?: number | null } | undefined)?.runningAgentCount ?? 0) > 0).toBe(true);
  });
});
