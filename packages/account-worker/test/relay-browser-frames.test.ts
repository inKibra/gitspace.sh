import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { browserBase64, signRuntimeAccountBrowserGrant, signRuntimeBrowserAuthorityCertificate } from '@gitspace/protocol-runtime';
import { RelayBrowser } from '../src/relay-browser.js';

async function keys() { const key = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); return { key, publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey))) }; }

test('a script command too large for your Chrome’s connection is refused before it reaches the extension, which takes the next one', async () => {
  const root = await keys(), workspace = await keys(), expiresAt = new Date(Date.now() + 600_000).toISOString();
  const authority = await signRuntimeBrowserAuthorityCertificate({ accountId: env.ACCOUNT_ID, projectId: 'project', workspaceId: 'workspace', publicKey: workspace.publicKey, issuedAt: new Date().toISOString(), expiresAt }, root.key.privateKey);
  const placement = { kind: 'account-relay' as const, accountId: env.ACCOUNT_ID, pairingId: crypto.randomUUID(), generation: 1 };
  const grant = await signRuntimeAccountBrowserGrant({ projectId: 'project', workspaceId: 'workspace', placement, groupId: crypto.randomUUID(), groupName: 'Workspace', source: 'relay', stepsOnly: [], origins: ['example.com'], expiresAt }, workspace.key.privateKey, authority);
  const sent: { method?: unknown; operation: unknown; frame: number }[] = [];
  const browser = new RelayBrowser({
    product: 'Chrome/131.0.0.0', grant, attemptId: 'attempt',
    // As the relay sends each operation to the extension: one frame with its request id.
    request: async message => { sent.push({ method: message.method, operation: message.operation, frame: JSON.stringify({ id: 123_456, ...message }).length }); return message.operation === 'open' ? { targetId: 'tab', sessionId: 'lease' } : {}; },
    listen: () => () => {},
  });
  const { sessionId } = z.object({ sessionId: z.string() }).parse(await browser.send('Target.attachToTarget', { targetId: 'tab' }));
  // A file from memory as Playwright sets it: its bytes as base64 in one call.
  const call = (characters: number) => browser.send('Runtime.callFunctionOn', { functionDeclaration: 'function (files) {}', objectId: 'input', arguments: [{ value: 'A'.repeat(characters) }] }, sessionId);
  await expect(call(4_000_000)).rejects.toThrow("Runtime.callFunctionOn is 4.0 MB, more than your Chrome's connection to GitSpace carries at once (4 MB)");
  await call(3_999_000 - 400);
  await browser.send('Runtime.evaluate', { expression: '1' }, sessionId);
  expect(sent.map(({ method, operation }) => method ?? operation)).toEqual(['open', 'Runtime.callFunctionOn', 'Runtime.evaluate']);
  expect(Math.max(...sent.map(({ frame }) => frame))).toBeLessThanOrEqual(4_000_000);
});
