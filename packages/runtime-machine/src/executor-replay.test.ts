import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { RuntimeToolResultSchema } from '@gitspace/protocol-runtime';
import { MachineExecutor } from './executor.js';
import { ExecutorJournal } from './journal.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'executor-replay-'));
  directories.push(root);
  const journal = new ExecutorJournal(join(root, 'journal.sqlite'));
  const secret = Buffer.from('s'.repeat(32)).toString('base64url');
  // Two workspaces' checkouts on one machine.
  for (const name of ['a', 'b']) journal.installAttachment({
    attachment: {
      projectId: 'project-a', workspaceId: `workspace-${name}`, attachmentId: `attachment-${name}`, machineId: 'machine-a', generation: 1,
      checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: ['bash'], updatedAt: new Date().toISOString(), online: true, failure: null,
    },
    rootPath: root, executionSecret: secret, prerequisitesComplete: true,
  });
  let runs = 0;
  const release = Promise.withResolvers<void>();
  const executor = new MachineExecutor({ machineId: 'machine-a', journal, runCommand: async () => { runs += 1; await release.promise; return { exitCode: 0, output: `run ${runs}` }; } });
  const dispatch = (attemptId: string, command: string, workspace = 'a') => JSON.stringify({
    version: 1, projectId: 'project-a', workspaceId: `workspace-${workspace}`, machineId: 'machine-a', attachmentId: `attachment-${workspace}`, generation: 1,
    conversationId: 'conversation-a', conversationKind: 'main', taskId: 'task-a', requestId: 'request-a', attemptId,
    tool: 'bash', args: { command }, replay: 'unsafe', deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const send = (body: string) => executor.fetch(new Request('http://machine/runtime/execute', {
    method: 'POST', body, headers: { 'x-gitspace-execution-signature': createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url') },
  }));
  return { send, dispatch, release, runs: () => runs, journal };
}

test('a command sent again after its reply was lost runs once and answers with its result', async () => {
  const { send, dispatch, release, runs, journal } = await fixture();
  const body = dispatch('attempt-a', 'echo hi');
  const first = send(body);
  const resent = send(body);
  release.resolve();
  const [original, again] = await Promise.all([first, resent]);
  const expected = { requestId: 'request-a', attemptId: 'attempt-a', status: 'completed', content: [{ type: 'text', text: 'Exit code: 0\nrun 1' }] };
  expect(RuntimeToolResultSchema.parse(await original.json())).toEqual(expected);
  expect(RuntimeToolResultSchema.parse(await again.json())).toEqual(expected);
  // Sent once more after it finished: the stored result, not a second run.
  expect(RuntimeToolResultSchema.parse(await (await send(body)).json())).toEqual(expected);
  expect(runs()).toBe(1);
  // A different command reusing the attempt id is refused rather than answered with another command's result.
  expect((await send(dispatch('attempt-a', 'rm -rf .'))).status).toBe(409);
  journal.close();
});

test("two workspaces' commands with the same attempt id both run and each replays its own result", async () => {
  const { send, dispatch, release, runs, journal } = await fixture();
  release.resolve();
  // Attempt ids are `tool:<pi task id>`, and each workspace counts its tasks from 1.
  const a = dispatch('tool:3620', 'echo from a', 'a'), b = dispatch('tool:3620', 'echo from b', 'b');
  const first = RuntimeToolResultSchema.parse(await (await send(a)).json());
  const second = await send(b);
  expect(second.status).toBe(200);
  expect(RuntimeToolResultSchema.parse(await second.json()).content).toEqual([{ type: 'text', text: 'Exit code: 0\nrun 2' }]);
  expect(RuntimeToolResultSchema.parse(await (await send(a)).json())).toEqual(first);
  expect(runs()).toBe(2);
  journal.close();
});
