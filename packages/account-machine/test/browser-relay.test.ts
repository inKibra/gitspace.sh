import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BrowserRelaySupervisor } from '../src/browser-relay.js';
import { relayCommandAllowed } from '../src/browser-relay-extension.js';
import type { RuntimeBrowserAuthorization, RuntimeBrowserSignedGrant } from '@gitspace/protocol-runtime';
import { ExecutorEffectUncertain } from '@gitspace/runtime-machine';

const roots: string[] = [];
const relays: BrowserRelaySupervisor[] = [];
afterEach(async () => { await Promise.all(relays.splice(0).map(relay => relay.stop())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-browser-relay-')); roots.push(root);
  const relay = new BrowserRelaySupervisor({ environmentRoot: join(root, 'environment'), privateRoot: join(root, 'private'), machineId: 'm', enabled, port: 20_000 + Math.floor(Math.random() * 10_000) }); relays.push(relay); return relay;
}
interface PairingIdentity { keys: CryptoKeyPair; publicKey: string }
async function identity(): Promise<PairingIdentity> {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  return { keys, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64') };
}
async function pair(relay: BrowserRelaySupervisor, who: PairingIdentity, code?: string, hello = true, handle?: (client: WebSocket, message: Record<string, any>) => void, staleNonce?: string) {
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const client = new WebSocket(relay.endpoint.replace('http:', 'ws:') + '/extension', { headers: { Origin: 'chrome-extension://' + 'a'.repeat(32) } });
  client.onclose = () => { closed.resolve(); ready.reject(new Error('Pairing rejected')); };
  client.onerror = error => ready.reject(error);
  client.onmessage = async event => {
    const message = JSON.parse(String(event.data));
    if (message.pairing === 'challenge') {
      const clientNonce = 'b'.repeat(64);
      const proof = Buffer.from(await crypto.subtle.sign('Ed25519', who.keys.privateKey, new TextEncoder().encode(`gitspace-browser-relay-v2:client:${staleNonce ?? message.serverNonce}:${clientNonce}`))).toString('base64');
      client.send(JSON.stringify({ pairing: 'client', clientNonce, publicKey: who.publicKey, proof, code }));
    } else if (message.pairing === 'server') {
      if (hello) client.send(JSON.stringify({ hello: true, Browser: 'Chrome/test' })); else ready.resolve();
    } else if (message.ready) ready.resolve();
    else handle?.(client, message);
  };
  await ready.promise;
  return { client, closed: closed.promise };
}
// The transport fixture acknowledges authorization; cryptographic grant verification is exercised by the real-extension integration.
function authorization(grant: RuntimeBrowserSignedGrant): RuntimeBrowserAuthorization {
  const body = grant.body;
  return { body: { scope: { projectId: body.projectId, workspaceId: body.workspaceId, conversationId: 'conversation', machineId: body.machineId, attachmentId: body.attachmentId, generation: body.generation, taskId: 'task', requestId: 'request', attemptId: crypto.randomUUID() }, issuedAt: new Date().toISOString(), expiresAt: body.expiresAt, dispatch: { version: 1, tool: 'browser', deadlineAt: body.expiresAt, replay: 'unsafe' }, command: { type: 'execute', args: { action: 'open', source: 'relay', targetId: 'target-a' }, grant } }, signature: 'AA==', authority: grant.authority };
}
describe('BrowserRelaySupervisor security boundary', () => {
  it('forgets the durable pin, disconnects the old identity and pairs a reinstalled extension', async () => {
    const relay = await fixture(); const initial = await relay.setup(); const old = await identity();
    const connection = await pair(relay, old, initial.pairingCode!);
    const fingerprint = (await relay.status()).pairedKeyFingerprint;
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const fresh = await relay.unpair(); await connection.closed;
    expect(fresh).toMatchObject({ state: 'waiting', connected: false, pairedKeyFingerprint: null });
    expect(fresh.pairingCode).not.toBe(initial.pairingCode);
    await expect(readFile(join(relay.extensionPath, '..', 'pairing-public-key'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(pair(relay, old)).rejects.toThrow('Pairing rejected');
    await expect(pair(relay, old, initial.pairingCode!)).rejects.toThrow('Pairing rejected');
    const replacement = await identity();
    const paired = await pair(relay, replacement, fresh.pairingCode!);
    expect((await relay.status()).pairedKeyFingerprint).not.toBe(fingerprint);
    expect(await readFile(join(relay.extensionPath, '..', 'pairing-public-key'), 'utf8')).toBe(replacement.publicKey);
    paired.client.close(); await paired.closed; await relay.stop(); await relay.start();
    await expect(pair(relay, old)).rejects.toThrow('Pairing rejected');
    const restored = await pair(relay, replacement); restored.client.close(); await restored.closed;
  });
  it('forgets a pairing awaiting hello without allowing the old handshake to resume', async () => {
    const relay = await fixture(); const initial = await relay.setup();
    const pending = await pair(relay, await identity(), initial.pairingCode!, false);
    const fresh = await relay.unpair(); await pending.closed;
    expect(fresh.pairedKeyFingerprint).toBeNull();
    const next = await pair(relay, await identity(), fresh.pairingCode!); next.client.close(); await next.closed;
  });
  it('preserves the paired public key across restart and extension setup updates', async () => {
    const relay = await fixture(); const status = await relay.setup(); const who = await identity();
    const first = await pair(relay, who, status.pairingCode!);
    first.client.close(); await first.closed; await relay.stop();
    const restarted = await relay.start(); expect(restarted.pairingCode).toBeNull();
    const second = await pair(relay, who); second.client.close(); await second.closed;
    await relay.setup();
    const third = await pair(relay, who); third.client.close(); await third.closed;
    const path = join(relay.extensionPath, '..', 'pairing-public-key');
    expect(await readFile(path, 'utf8')).toBe(who.publicKey);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it('rejects a different key and proofs from a different handshake after pairing', async () => {
    const relay = await fixture(); const status = await relay.setup(); const who = await identity();
    const first = await pair(relay, who, status.pairingCode!); first.client.close(); await first.closed;
    await expect(pair(relay, await identity())).rejects.toThrow('Pairing rejected');
    await expect(pair(relay, who, undefined, true, undefined, 'f'.repeat(64))).rejects.toThrow('Pairing rejected');
    const recovered = await pair(relay, who); recovered.client.close(); await recovered.closed;
  });
  it('disconnects an authenticated client that never sends hello', async () => {
    const relay = await fixture(); const status = await relay.setup();
    const silent = await pair(relay, await identity(), status.pairingCode!, false);
    await expect(pair(relay, await identity())).rejects.toBeDefined();
    await silent.closed; expect((await relay.status()).connected).toBe(false);
  }, 10_000);
  it('rejects changed installed content before a new connection', async () => {
    const relay = await fixture(); await relay.setup();
    await writeFile(join(relay.extensionPath, 'background.js'), 'tampered');
    await expect(pair(relay, await identity())).rejects.toBeDefined();
    await relay.stop(); await expect(relay.start()).rejects.toThrow('installation changed');
  });
  it('reports dispatched commands as uncertain when the authenticated transport disappears', async () => {
    const relay = await fixture(); const status = await relay.setup(); const received = Promise.withResolvers<void>();
    const connection = await pair(relay, await identity(), status.pairingCode!, true, (client, message) => {
      if (message.operation === 'authorize') client.send(JSON.stringify({ id: message.id, result: { ok: true } }));
      else if (message.operation === 'open') client.send(JSON.stringify({ id: message.id, result: { targetId: 'target-a', sessionId: 'session-a' } }));
      else if (message.operation === 'prepare') client.send(JSON.stringify({ id: message.id, result: { title: 'Approved', url: 'https://example.com/' } }));
      else if (message.operation === 'command') { received.resolve(); client.close(); }
    });
    const body = { projectId: 'p', workspaceId: 'w', machineId: 'm', attachmentId: 'a', generation: 1, groupId: crypto.randomUUID(), groupName: 'Workspace', origins: ['example.com'], source: 'relay' as const, expiresAt: new Date(Date.now() + 60000).toISOString() };
    const grant: RuntimeBrowserSignedGrant = { body, signature:'AA==', authority: {body:{accountId:'account',projectId:'p',workspaceId:'w',publicKey:'AA==',issuedAt:new Date().toISOString(),expiresAt:body.expiresAt},signature:'AA=='} };
    const signal = new AbortController().signal;
    const args = { action:'open' as const, source:'relay' as const, targetId:'target-a' };
    await expect(relay.open(grant, args, signal)).rejects.toThrow('not authorized');
    await relay.authorize(authorization(grant), signal);
    await expect(relay.open({ ...grant, body:{...body,origins:['*']} }, args, signal)).rejects.toThrow('not authorized');
    const channel = await relay.open(grant, args, signal);
    const assertion = expect(channel.send('Input.insertText', { text: 'approved effect' })).rejects.toBeInstanceOf(ExecutorEffectUncertain);
    await received.promise; await assertion; await connection.closed;
  });
  it('denies local HTTP/CDP clients even without an Origin header', async () => {
    const relay = await fixture(); await relay.setup();
    for (const path of ['/json/version', '/json/list', '/devtools/browser', '/extension']) expect((await fetch(relay.endpoint + path)).status).toBe(403);
    const failed = Promise.withResolvers<number>();
    const client = new WebSocket(relay.endpoint.replace('http:', 'ws:') + '/devtools/browser');
    client.onerror = () => failed.resolve(1); client.onopen = () => failed.resolve(0);
    expect(await failed.promise).toBe(1); client.close();
  });
  it('rotates unused pairing codes without persisting a credential', async () => {
    const relay = await fixture(); const status = await relay.setup();
    expect(status.pairingCode).toBeTruthy();
    await expect(readFile(join(relay.extensionPath, '..', 'pairing-public-key'))).rejects.toThrow();
    await relay.stop(); await relay.start();
    expect((await relay.status()).pairingCode).not.toBe(status.pairingCode);
  });
  it('cannot be enabled on an unapproved machine', async () => {
    const relay = await fixture(false); await expect(relay.setup()).rejects.toThrow('physical'); await expect(relay.start()).rejects.toThrow('physical');
    expect((await relay.status()).connected).toBe(false);
  });
  it('rejects unpaired preparation before approval can be requested', async () => {
    const relay = await fixture(); const groupId = crypto.randomUUID();
    await expect(relay.prepare({ action: 'open', source: 'relay', url: 'https://example.com/new' }, groupId, new AbortController().signal)).rejects.toThrow();
  });
  it('rejects discovery, session escape, arbitrary internal scripts, and cross-origin navigation', () => {
    const grant = { origins: ['example.com','*.approved.test'] };
    for (const method of ['Target.getTargets', 'Target.setAutoAttach', 'Target.createTarget', 'Runtime.callFunctionOn', 'Page.addScriptToEvaluateOnNewDocument']) expect(relayCommandAllowed(grant, 'target-a', 'session-a', method, { expression: '1', functionDeclaration: 'function(){}' }, 'session-a')).toBe(false);
    expect(relayCommandAllowed(grant, 'target-a', 'session-a', 'Page.enable', {}, 'session-b')).toBe(false);
    expect(relayCommandAllowed(grant, 'target-a', 'session-a', 'Target.attachToTarget', { targetId: 'target-b' })).toBe(false);
    expect(relayCommandAllowed(grant, 'target-a', 'session-a', 'Page.navigate', { url: 'https://other.example/' })).toBe(false);
    expect(relayCommandAllowed(grant, 'target-a', 'session-a', 'Page.navigate', { url: 'https://example.com/next' })).toBe(true);
    expect(relayCommandAllowed(grant, 'target-a', 'session-a', 'Runtime.evaluate', { expression: 'document.title' }, 'session-a')).toBe(true);
    expect(relayCommandAllowed(grant, 'target-a', 'session-a', 'Page.navigate', { url: 'https://sub.approved.test/' })).toBe(true);
    expect(relayCommandAllowed(grant, 'target-a', 'session-a', 'Page.navigate', { url: 'https://approved.test/' })).toBe(false);
    expect(relayCommandAllowed(grant, 'target-a', 'session-a', 'Page.navigate', { url: 'https://example.com.attacker.test/' })).toBe(false);
  });
});
