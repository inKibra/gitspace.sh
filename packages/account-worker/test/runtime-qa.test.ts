import { env } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { appendRuntimeQa, createRuntimeQaServices } from '../src/runtime-services.js';

async function project() {
  const projectId = `qa-${crypto.randomUUID()}`;
  await env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`).bootstrap({ id: projectId, name: 'QA', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  return { a: RuntimeIdentitySchema.parse({ projectId, workspaceId: 'workspace-a' }), b: RuntimeIdentitySchema.parse({ projectId, workspaceId: 'workspace-b' }) };
}

test('a workspace inbox lists only its own reports', async () => {
  const { a, b } = await project();
  await appendRuntimeQa(env, a, crypto.randomUUID(), { message: 'Failure in A' });
  await appendRuntimeQa(env, b, crypto.randomUUID(), { message: 'Failure in B' });
  expect((await createRuntimeQaServices(env, a).list()).map(item => item.title)).toEqual(['Failure in A']);
});

test('copies of an open report are merged into the first, durably, and a repeated failure files nothing new', async () => {
  const { a } = await project();
  const first = await appendRuntimeQa(env, a, crypto.randomUUID(), { message: 'Process observation unavailable' });
  for (let copy = 0; copy < 2; copy++) await appendRuntimeQa(env, a, crypto.randomUUID(), { message: 'Process observation unavailable' });
  const listed = await createRuntimeQaServices(env, a).list();
  expect(listed.map(item => [item.state, item.duplicateOf])).toEqual([['open', null], ['merged', first.id], ['merged', first.id]]);
  // A later runtime reads the merge back instead of merging again.
  const reopened = createRuntimeQaServices(env, a);
  expect((await reopened.list()).filter(item => item.state === 'open').map(item => item.id)).toEqual([first.id]);
  await Promise.all([reopened.report('Process observation unavailable'), reopened.report('Process observation unavailable')]);
  await reopened.report('Network connection lost.');
  await reopened.report('Network connection lost.');
  expect((await createRuntimeQaServices(env, a).list()).filter(item => item.state === 'open').map(item => item.title)).toEqual(['Process observation unavailable', 'Network connection lost.']);
});
