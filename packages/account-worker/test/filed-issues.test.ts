import { env, SELF } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant, type ControlOperation } from '@gitspace/protocol';
import { FiledIssueSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { z } from 'zod';
import { tenantRootPrivateKey as rootPrivateKey } from './setup.js';

const commit = 'a'.repeat(40);

test('the ops client lists stored filed issues newest first and resolves one', async () => {
  const machineKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)) });
  await vault.registerDevice(signCredentialAuthorityGrant({
    version: 1, userId: env.ACCOUNT_ID, machineId: 'machine-a', signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineKey)),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(5))), capabilities: ['space.control'], generation: 1,
  }, rootPrivateKey));
  const control = async (operation: ControlOperation, payload: Record<string, unknown>) => {
    const response = await SELF.fetch('https://auth.test/v1/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createSignedControlRequest({ userId: env.ACCOUNT_ID, machineId: 'machine-a', operation, payload, signingPrivateKey: machineKey })) });
    expect(response.status).toBe(200);
    return z.object({ value: z.unknown() }).parse(await response.json()).value;
  };
  const projectId = `filed-${crypto.randomUUID()}`;
  const state = env.ACCOUNT_STATE.getByName('account');
  const [older, newer] = [`chatter:${projectId}:older failure`, `chatter:${projectId}:newer failure`];
  for (const [id, filedAt] of [[older, '2026-10-20T10:00:00.000Z'], [newer, '2026-10-21T10:00:00.000Z']] as const) {
    await state.fileIssue({ id, projectId, workspaceId: `${projectId}-a`, title: id, excerpt: 'what failed', tool: null, model: 'unattributed', historyRef: `history://${projectId}-a`, createdAt: '2026-10-19T10:00:00.000Z', filedAt, filedBy: 'browser-1' });
  }
  const list = async (payload: Record<string, unknown>) => z.array(FiledIssueSchema).parse(await control('account.issues.list', payload)).map(row => row.id).filter(id => id.startsWith(`chatter:${projectId}:`));
  expect(await list({})).toEqual([newer, older]);
  expect(await list({ before: '2026-10-21T10:00:00.000Z' })).toEqual([older]);
  expect(FiledIssueSchema.parse(await control('account.issues.resolve', { id: older, commit, note: 'fixed in develop' }))).toMatchObject({ state: 'resolved', resolution: { commit, note: 'fixed in develop' } });
  expect(await list({ state: 'open' })).toEqual([newer]);
  expect(await list({ state: 'resolved' })).toEqual([older]);
});
