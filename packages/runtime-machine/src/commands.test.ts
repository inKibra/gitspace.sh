import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeAttachmentSchema, RuntimeFullOutputDetailsSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { daemonClientForProject } from '@gitspace/supervisor';
import { keepWholeOutput, TOOL_OUTPUT_LIMITS } from '../../runtime-core/src/tool-results.js';
import { COMMAND_OUTPUT_MAX_BYTES, runSupervisorCommand } from './commands.js';
import { executeMachineTool } from './tools.js';

const base = await mkdtemp(join(tmpdir(), 'runtime-machine-commands-'));
process.env.GITSPACE_SUPERVISOR_HOME = join(base, 'supervisor');
const rootPath = join(base, 'checkout');
await Bun.write(join(rootPath, 'README'), 'checkout\n');
const client = await daemonClientForProject(rootPath);

afterAll(async () => {
  await client.request({ op: 'shutdown' });
  await rm(base, { recursive: true, force: true });
});

/** Runs `command` with the machine's bash tool under the checkout's supervisor, and returns what the workspace keeps of
 * its result: the whole text in the result store, and the preview the model sees. */
async function bash(command: string, attemptId: string) {
  const attachment = RuntimeAttachmentSchema.parse({ attachmentId: 'attachment', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 1, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: ['bash'], updatedAt: new Date().toISOString() });
  const dispatch = RuntimeToolDispatchSchema.parse({ conversationKind: 'main', version: 1, conversationId: 'conversation', taskId: 'task', attachmentId: 'attachment', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 1, requestId: attemptId, attemptId, tool: 'bash', args: { command }, deadlineAt: new Date(Date.now() + 60_000).toISOString(), replay: 'unsafe' });
  const content = await executeMachineTool(dispatch, { attachment, rootPath, executionSecret: 'unused', prerequisitesComplete: true }, new AbortController().signal, { runCommand: runSupervisorCommand });
  const stored = new Map<string, string>();
  const kept = await keepWholeOutput({ output: content.flatMap(item => item.type === 'text' ? [{ type: 'text' as const, text: item.text }] : []) }, {
    async put(input) { stored.set(input.callId, input.text); return `result://workspace/${input.conversationId}/${input.callId}`; },
    async text(key) { return stored.get(key.callId) ?? ''; },
  }, { conversationId: 'conversation', callId: attemptId }, TOOL_OUTPUT_LIMITS);
  const preview = kept.output?.flatMap(item => item.type === 'text' ? [item.text] : []).join('') ?? '';
  return { stored: stored.get(attemptId) ?? '', preview, fullOutput: RuntimeFullOutputDetailsSchema.parse(kept.details).fullOutput };
}

test('a machine bash command printing 30,000 lines is stored whole while the model sees a bounded preview', async () => {
  const { stored, preview, fullOutput } = await bash('seq 1 30000', 'thirty-thousand');
  const lines = stored.split('\n');
  expect(lines.slice(0, 2)).toEqual(['Exit code: 0', '1']);
  expect(lines).toContain('5');
  expect(lines).toContain('23456');
  expect(lines.at(-2)).toBe('30000');
  expect(lines).toHaveLength(30_002);
  expect(fullOutput.keptBytes).toBe(fullOutput.bytes);
  expect(new TextEncoder().encode(preview).length).toBeLessThanOrEqual(TOOL_OUTPUT_LIMITS.maxBytes);
  expect(preview).not.toContain('23456');
  // The output file is the supervisor's only for the command's life.
  expect(await readdir(join(client.runtimeDir, 'outputs'))).toEqual([]);
}, 30_000);

test('output past the limit is cut with a note, and the workspace stores both whole', async () => {
  const line = '0123456789abcdefghijklmnopqrstuvwxyz0123456789abc\n';
  const { stored, fullOutput } = await bash(`yes ${line.trimEnd()} | head -c ${26 * 1024 * 1024}`, 'over-limit');
  const note = '\n[Output cut: the command wrote 26.0 MB; its first 25.0 MB is kept and the rest was dropped]\n';
  expect(stored.slice(0, 13)).toBe('Exit code: 0\n');
  expect(stored.length).toBe(13 + COMMAND_OUTPUT_MAX_BYTES + note.length);
  expect(stored.slice(13, 13 + COMMAND_OUTPUT_MAX_BYTES) === line.repeat(Math.ceil(COMMAND_OUTPUT_MAX_BYTES / line.length)).slice(0, COMMAND_OUTPUT_MAX_BYTES)).toBe(true);
  expect(stored.slice(13 + COMMAND_OUTPUT_MAX_BYTES)).toBe(note);
  expect(fullOutput.keptBytes).toBe(fullOutput.bytes);
}, 60_000);

test('a command stopped at its own time limit returns its whole output and the timeout note', async () => {
  const result = await runSupervisorCommand({ application: '/bin/bash', args: ['-c', 'seq 1 20000; sleep 30'], cwd: rootPath, attemptId: 'timed-out', sequence: 0, deadlineAt: new Date(Date.now() + 60_000).toISOString(), signal: new AbortController().signal, timeoutMs: 1000 });
  const lines = result.output.split('\n');
  expect(result.exitCode).toBe(124);
  expect(lines.slice(0, 2)).toEqual(['1', '2']);
  expect(lines.slice(-3)).toEqual(['20000', '[timed out after 1000 ms; process tree stopped]', '']);
  expect(lines).toHaveLength(20_002);
}, 30_000);
