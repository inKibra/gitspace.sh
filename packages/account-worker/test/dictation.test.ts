import { env } from 'cloudflare:workers';
import { afterEach, expect, test, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, DEVICE_SOCKET_PROTOCOL, signDeviceInvite, signRpcRequest } from '@gitspace/protocol';
import { DICTATION_PATH, RuntimeDictationServerMessageSchema, type RuntimeDictationServerMessage } from '@gitspace/protocol-runtime';
import { serveDictation, type DictationModels } from '../src/dictation.js';
import { tenantRootPrivateKey } from './setup.js';

const origin = 'https://test.gitspace.sh';
afterEach(() => { vi.restoreAllMocks(); });

/** A project with one workspace whose inference profile dictates with `dictation`, and an OpenAI API key in it. */
async function workspace(dictation: string) {
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const projectId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(await authority.bootstrap({ id: projectId, name: 'Dictation', repositoryReference: null, baseBranch: 'main', createdBy: 'user' }));
  await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'worktree', branch: 'main', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const profile = (await vault.createInferenceProfile({ name: `Dictation ${projectId}`, sourceProfileId: null })).profiles.find(entry => entry.name === `Dictation ${projectId}`);
  if (!profile) throw new Error('Expected the created profile');
  expect(await vault.updateInferenceProfile({ profileId: profile.id, expectedRevision: profile.revision, name: profile.name, settings: { ...profile.settings, dictation } })).toMatchObject({ status: 'ok' });
  await vault.assignInferenceProfile({ projectId, profileId: profile.id, expectedRevision: 0 });
  await vault.putBrowserApiKey(profile.id, 'openai', 'sk-dictation-key');
  return { projectId, workspaceId };
}

/** A signed-in browser of the account that may prompt, and its dictation socket for a workspace. */
async function dictate(query: { projectId: string; workspaceId: string }, models: DictationModels) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const invite = signDeviceInvite({ version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read', 'rpc.write', 'session.prompt'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: `${origin}/v1/devices/enroll` }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(key)), label: 'Laptop', boundAt: Date.now(), signingPrivateKey: key });
  expect(await env.CREDENTIALS.getByName(env.ACCOUNT_ID).enrollDevice({ invite, binding })).toMatchObject({ status: 'ok' });
  const path = `${DICTATION_PATH}?${new URLSearchParams(query)}`;
  const proof = signRpcRequest({ deviceId: binding.deviceId, signingPrivateKey: key, method: 'GET', path, body: new Uint8Array() });
  const response = await serveDictation(new Request(`${origin}${path}`, { headers: { upgrade: 'websocket', origin, 'sec-websocket-protocol': `${DEVICE_SOCKET_PROTOCOL}${proof}` } }), env, models);
  const socket = response.webSocket;
  if (!socket) throw new Error(`No dictation socket (${response.status})`);
  const received: RuntimeDictationServerMessage[] = [];
  const done = Promise.withResolvers<RuntimeDictationServerMessage[]>();
  const ready = Promise.withResolvers<void>();
  socket.addEventListener('message', event => {
    const message = RuntimeDictationServerMessageSchema.parse(JSON.parse(String(event.data)));
    received.push(message);
    if (message.type === 'ready') ready.resolve();
    if (message.type === 'done' || message.type === 'error') done.resolve(received);
  });
  socket.accept();
  return { socket, received, ready: ready.promise, done: done.promise };
}

/** Half a second of 16 kHz PCM16 as two frames. */
function audio(): Uint8Array<ArrayBuffer>[] {
  return [Uint8Array.from({ length: 8000 }, (_, index) => index % 251), Uint8Array.from({ length: 8000 }, (_, index) => (index * 7) % 253)];
}

test('relays a live recording to Flux and returns its turns as interim and final text, the last on stop', async () => {
  const query = await workspace('cloudflare/flux');
  const flux = new WebSocketPair();
  const provider = flux[1];
  const heard: Uint8Array[] = [], closing = Promise.withResolvers<void>();
  provider.binaryType = 'arraybuffer';
  provider.accept();
  provider.addEventListener('message', event => {
    if (typeof event.data !== 'string') { heard.push(new Uint8Array(event.data)); if (heard.length === 2) closing.resolve(); return; }
    // CloseStream: Flux decodes what it has, sends an Update and closes without an EndOfTurn.
    expect(JSON.parse(event.data)).toEqual({ type: 'CloseStream' });
    provider.send(JSON.stringify({ type: 'TurnInfo', event: 'Update', turn_index: 1, transcript: 'And this.' }));
    provider.close(1000);
  });
  const browser = await dictate(query, { flux: async () => flux[0], whisper: async () => { throw new Error('Whisper is not this profile\'s dictation'); } });
  await browser.ready;
  const frames = audio();
  for (const frame of frames) browser.socket.send(frame);
  await closing.promise;
  expect(heard).toEqual(frames);
  provider.send(JSON.stringify({ type: 'TurnInfo', event: 'Update', turn_index: 0, transcript: 'Hello wor' }));
  provider.send(JSON.stringify({ type: 'TurnInfo', event: 'EndOfTurn', turn_index: 0, transcript: 'Hello world.' }));
  browser.socket.send(JSON.stringify({ type: 'stop' }));
  expect(await browser.done).toEqual([
    { type: 'ready', mode: 'live' },
    { type: 'interim', text: 'Hello wor' },
    { type: 'final', text: 'Hello world.' },
    { type: 'interim', text: '' },
    { type: 'interim', text: 'And this.' },
    { type: 'final', text: 'And this.' },
    { type: 'done' },
  ]);
});

test('uploads a finished recording as WAV to OpenAI with the profile\'s API key and returns the transcription', async () => {
  const query = await workspace('openai/gpt-transcribe');
  const requests: { url: string; authorization: string | null; model: unknown; file: unknown }[] = [];
  const network = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.startsWith('https://api.openai.com/')) return network(request);
    const form = await request.formData();
    requests.push({ url: request.url, authorization: request.headers.get('authorization'), model: form.get('model'), file: form.get('file') });
    return Response.json({ text: ' Fix the login page. ' });
  });
  const browser = await dictate(query, { flux: async () => { throw new Error('Flux is not this profile\'s dictation'); }, whisper: async () => { throw new Error('Whisper is not this profile\'s dictation'); } });
  await browser.ready;
  for (const frame of audio()) browser.socket.send(frame);
  browser.socket.send(JSON.stringify({ type: 'stop' }));
  expect(await browser.done).toEqual([{ type: 'ready', mode: 'batch' }, { type: 'transcribing' }, { type: 'final', text: 'Fix the login page.' }, { type: 'done' }]);
  expect(requests).toHaveLength(1);
  const [sent] = requests;
  expect(sent).toMatchObject({ url: 'https://api.openai.com/v1/audio/transcriptions', authorization: 'Bearer sk-dictation-key', model: 'gpt-transcribe' });
  if (!(sent?.file instanceof File)) throw new Error('Expected the recording as a file');
  const wav = new Uint8Array(await sent.file.arrayBuffer());
  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
  expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16_000);
  expect(wav.subarray(44)).toEqual(Uint8Array.from([...audio()[0]!, ...audio()[1]!]));
});
