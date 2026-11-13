import { z } from 'zod';
import { DEFAULT_DICTATION_SELECTOR, DEVICE_SOCKET_PROTOCOL, parseServiceSelector, socketProtocolProof } from '@gitspace/protocol';
import {
  DICTATION_FRAME_MAX_BYTES, DICTATION_MAX_BYTES, DICTATION_MAX_MS, DICTATION_SAMPLE_RATE, RuntimeDictationClientMessageSchema, RuntimeDictationQuerySchema,
  RuntimeIdentitySchema, type RuntimeDictationServerMessage,
} from '@gitspace/protocol-runtime';
import { accountAccessResponse, activeAccount } from './account-access.js';
import type { CredentialVaultDO } from './application.js';
import { DEVICE_AUTHORITY_UNAVAILABLE, withDeviceAuthority } from './device-authority.js';
import { requireWorkspaceAccess } from './runtime-access.js';

/**
 * The composer's dictation socket (`DICTATION_PATH`, protocol in `@gitspace/protocol-runtime` dictation.ts): one of the
 * account's signed-in browsers, allowed to prompt, records into one socket per recording. The project's inference
 * profile picks the provider (`dictation`, `DEFAULT_DICTATION_SELECTOR` when unset):
 * - `cloudflare/flux`: Workers AI's `@cf/deepgram/flux`, over a WebSocket the binding opens; the audio is relayed as it
 *   arrives and Flux's turns come back as interim and final text.
 * - `cloudflare/whisper`: Workers AI's `@cf/openai/whisper-large-v3-turbo`, given the whole recording as WAV after it stops.
 * - `openai/<model>`: OpenAI's `POST /v1/audio/transcriptions` with an API key of the profile, read from the vault here;
 *   no key reaches the browser.
 * Both bill per audio minute; a recording stops at `DICTATION_MAX_MS` (`DICTATION_MAX_BYTES` of audio).
 */

/** The Workers AI models dictation uses. */
export type DictationModels = {
  /** A Flux stream for 16 kHz linear16 audio, not yet accepted. */
  flux(): Promise<WebSocket>;
  /** The text of a WAV recording. */
  whisper(wav: Uint8Array<ArrayBuffer>): Promise<string>;
};

/** A recording's provider: audio in as it arrives, `stop` when the recording ends (it sends the text it finished),
 * `close` when the browser left. `failed` settles with why the provider broke off mid-recording. */
type Transcriber = { mode: 'live' | 'batch'; audio(frame: ArrayBuffer): void; stop(): Promise<void>; close(): void; failed: Promise<string> };

/** How long Flux may take to finish what it heard after `CloseStream`. */
const FLUX_DRAIN_MS = 10_000;
/** Time past `DICTATION_MAX_MS` a recording's audio may take to arrive before the server stops it. */
const LATE_AUDIO_MS = 30_000;
/** Base64 is written in slices of this many bytes, a multiple of 3 so the slices join. */
const BASE64_SLICE = 3 * 8192;
const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OpenAiTranscription = z.object({ text: z.string() });
const OpenAiError = z.object({ error: z.object({ message: z.string() }) });
const FluxMessage = z.object({ type: z.string(), event: z.string().optional(), transcript: z.string().optional(), description: z.string().optional(), code: z.string().optional() });

function described(error: unknown) { return error instanceof Error ? error.message : String(error); }
function fail(status: number, code: string, message: string) { return Response.json({ status: 'error', error: { code, message } }, { status, headers: { 'cache-control': 'private, no-store' } }); }
function send(socket: WebSocket, message: RuntimeDictationServerMessage): void { if (socket.readyState === 1) socket.send(JSON.stringify(message)); }

/** Workers AI's dictation models on the worker's `AI` binding. */
export function workersAiDictation(ai: Ai): DictationModels {
  return {
    async flux() {
      const response = await ai.run('@cf/deepgram/flux', { encoding: 'linear16', sample_rate: String(DICTATION_SAMPLE_RATE) }, { websocket: true });
      if (!response.webSocket) throw new Error('Workers AI did not open a Flux stream');
      return response.webSocket;
    },
    async whisper(wav) {
      let audio = '';
      for (let offset = 0; offset < wav.length; offset += BASE64_SLICE) audio += btoa(String.fromCharCode(...wav.subarray(offset, offset + BASE64_SLICE)));
      return (await ai.run('@cf/openai/whisper-large-v3-turbo', { audio })).text;
    },
  };
}

/** 16 kHz mono PCM16 frames as one WAV file. */
export function dictationWav(frames: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = frames.reduce((total, frame) => total + frame.byteLength, 0);
  const wav = new Uint8Array(44 + length);
  const view = new DataView(wav.buffer);
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index += 1) wav[offset + index] = value.charCodeAt(index); };
  text(0, 'RIFF'); view.setUint32(4, 36 + length, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, DICTATION_SAMPLE_RATE, true); view.setUint32(28, DICTATION_SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, length, true);
  let offset = 44;
  for (const frame of frames) { wav.set(frame, offset); offset += frame.byteLength; }
  return wav;
}

/** Flux relayed: audio goes to the stream as it arrives; each turn's text comes back as interim text while it is spoken
 * and final text when Flux ends the turn. `CloseStream` ends no turn, so on stop the last interim text is final. */
function fluxTranscriber(socket: WebSocket, upstream: WebSocket): Transcriber {
  upstream.accept();
  const failed = Promise.withResolvers<string>(), drained = Promise.withResolvers<void>();
  let open = '', stopping = false;
  upstream.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    const parsed = FluxMessage.safeParse(JSON.parse(event.data));
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === 'Error') { failed.resolve(`Flux: ${message.description ?? message.code ?? 'stream error'}`); upstream.close(); return; }
    if (message.type !== 'TurnInfo' || message.transcript === undefined) return;
    if (message.event === 'EndOfTurn') {
      open = '';
      if (message.transcript.trim()) send(socket, { type: 'final', text: message.transcript.trim() });
      send(socket, { type: 'interim', text: '' });
      return;
    }
    open = message.transcript;
    send(socket, { type: 'interim', text: open });
  });
  const ended = () => { drained.resolve(); if (!stopping) failed.resolve('Flux ended the stream'); };
  upstream.addEventListener('close', ended);
  upstream.addEventListener('error', ended);
  return {
    mode: 'live',
    audio(frame) { if (upstream.readyState === 1) upstream.send(frame); },
    async stop() {
      stopping = true;
      if (upstream.readyState === 1) upstream.send(JSON.stringify({ type: 'CloseStream' }));
      const timer = setTimeout(() => drained.resolve(), FLUX_DRAIN_MS);
      await drained.promise;
      clearTimeout(timer);
      if (upstream.readyState === 1) upstream.close();
      if (open.trim()) send(socket, { type: 'final', text: open.trim() });
      open = '';
    },
    close() { stopping = true; if (upstream.readyState === 1) upstream.close(); },
    failed: failed.promise,
  };
}

/** A provider that transcribes the whole recording once it stops. */
function batchTranscriber(socket: WebSocket, transcribe: (wav: Uint8Array<ArrayBuffer>) => Promise<string>): Transcriber {
  let frames: Uint8Array[] = [];
  return {
    mode: 'batch',
    audio(frame) { frames.push(new Uint8Array(frame)); },
    async stop() {
      if (!frames.length) return;
      send(socket, { type: 'transcribing' });
      const text = (await transcribe(dictationWav(frames))).trim();
      frames = [];
      if (text) send(socket, { type: 'final', text });
    },
    close() { frames = []; },
    failed: Promise.withResolvers<string>().promise,
  };
}

/** A recording's text from OpenAI with the profile's API keys, in order, the next after one is refused or limited. */
export async function openAiTranscription(vault: DurableObjectStub<CredentialVaultDO>, profileId: string, model: string, wav: Uint8Array<ArrayBuffer>): Promise<string> {
  const accounts = (await vault.cloudCredentialAccounts(profileId, 'openai')).filter(account => account.type === 'api_key');
  if (!accounts.length) throw new Error('OpenAI transcription needs an OpenAI API key in this inference profile');
  const now = Date.now();
  let refusal = '';
  for (const account of [...accounts].sort((left, right) => Number((left.cooldownUntil ?? 0) > now) - Number((right.cooldownUntil ?? 0) > now))) {
    const resolved = await vault.cloudResolveCredential({ profileId, credentialId: account.id });
    if (resolved.credential.type !== 'api_key') continue;
    const body = new FormData();
    body.set('file', new Blob([wav], { type: 'audio/wav' }), 'dictation.wav');
    body.set('model', model);
    body.set('response_format', 'json');
    const response = await fetch(OPENAI_TRANSCRIPTIONS_URL, { method: 'POST', headers: { authorization: `Bearer ${resolved.credential.key}` }, body });
    if (response.ok) return OpenAiTranscription.parse(await response.json()).text;
    const text = await response.text();
    let detail = text.slice(0, 500);
    try { detail = OpenAiError.parse(JSON.parse(text)).error.message; } catch { /* the body is not OpenAI's error object; its text says why */ }
    refusal = `OpenAI transcription failed (${response.status}): ${detail}`;
    if (response.status !== 401 && response.status !== 403 && response.status !== 429) break;
  }
  throw new Error(refusal || 'OpenAI transcription needs an OpenAI API key in this inference profile');
}

/** The provider the project's profile names for dictation. */
async function transcriber(socket: WebSocket, env: Env, models: DictationModels, projectId: string): Promise<Transcriber> {
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  const { profile } = await vault.resolveCloudInference(projectId);
  const value = profile.settings.dictation ?? DEFAULT_DICTATION_SELECTOR;
  const selector = typeof value === 'string' ? parseServiceSelector(value) : null;
  if (selector?.provider === 'cloudflare' && selector.id === 'flux') return fluxTranscriber(socket, await models.flux());
  if (selector?.provider === 'cloudflare' && selector.id === 'whisper') return batchTranscriber(socket, wav => models.whisper(wav));
  if (selector?.provider === 'openai') return batchTranscriber(socket, wav => openAiTranscription(vault, profile.id, selector.id, wav));
  throw new Error(`This inference profile's dictation provider (${JSON.stringify(value)}) is not supported`);
}

/** One recording on an accepted socket: audio is held until the provider is ready, counted against the limit, and
 * passed on; `stop`, the limit or the deadline finishes it. Errors reach the browser as `error`, then the socket closes. */
async function dictate(socket: WebSocket, start: () => Promise<Transcriber>): Promise<void> {
  const held: ArrayBuffer[] = [];
  let current: Transcriber | null = null, received = 0, stopping = false, closed = false;
  const end = (message: RuntimeDictationServerMessage) => { send(socket, message); if (socket.readyState === 1) socket.close(1000, message.type); closed = true; current?.close(); };
  const started = Promise.withResolvers<Transcriber | null>();
  const stop = async (limit: boolean) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(deadline);
    if (limit) send(socket, { type: 'limit' });
    const transcriber = await started.promise;
    if (!transcriber || closed) return;
    try { await transcriber.stop(); end({ type: 'done' }); } catch (error) { end({ type: 'error', message: described(error) }); }
  };
  const deadline = setTimeout(() => void stop(true), DICTATION_MAX_MS + LATE_AUDIO_MS);
  socket.addEventListener('message', event => {
    if (stopping || closed) return;
    if (typeof event.data === 'string') {
      let message: unknown = null;
      try { message = JSON.parse(event.data); } catch { /* not JSON: refused below */ }
      if (RuntimeDictationClientMessageSchema.safeParse(message).success) void stop(false);
      else end({ type: 'error', message: 'Dictation takes audio frames and stop' });
      return;
    }
    const frame = event.data;
    if (frame.byteLength > DICTATION_FRAME_MAX_BYTES || frame.byteLength % 2 !== 0) { end({ type: 'error', message: 'Audio frames are 16-bit PCM of at most 64 KiB' }); return; }
    const room = DICTATION_MAX_BYTES - received;
    const kept = frame.byteLength <= room ? frame : frame.slice(0, room);
    received += kept.byteLength;
    if (current) current.audio(kept); else held.push(kept);
    if (received >= DICTATION_MAX_BYTES) void stop(true);
  });
  socket.addEventListener('close', () => { closed = true; clearTimeout(deadline); current?.close(); });
  try {
    const transcriber = await start();
    if (closed) { transcriber.close(); started.resolve(null); return; }
    for (const frame of held.splice(0)) transcriber.audio(frame);
    current = transcriber;
    send(socket, { type: 'ready', mode: transcriber.mode });
    void transcriber.failed.then(message => { if (!closed) end({ type: 'error', message }); });
    started.resolve(transcriber);
  } catch (error) {
    started.resolve(null);
    clearTimeout(deadline);
    end({ type: 'error', message: described(error) });
  }
}

/**
 * `GET DICTATION_PATH?projectId&workspaceId`, upgraded, from the account's own origin: the device's signature rides in
 * `Sec-WebSocket-Protocol` as on the Watch dialog's socket. The device must be a browser that may prompt and reach the
 * workspace. A provider that cannot start answers `error` on the socket, so the composer can say why.
 */
export async function serveDictation(request: Request, env: Env, models: DictationModels): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'Dictate with GET');
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fail(426, 'UPGRADE_REQUIRED', 'Expected a WebSocket');
  if (request.headers.get('origin') !== new URL(env.ACCOUNT_URL).origin) return fail(403, 'ORIGIN_REJECTED', 'Account origin required');
  const query = RuntimeDictationQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) return fail(400, 'DICTATION_INVALID', 'Dictation names its project and workspace');
  const offered = socketProtocolProof(request.headers.get('sec-websocket-protocol'), DEVICE_SOCKET_PROTOCOL);
  if (!offered) return fail(400, 'DICTATION_INVALID', 'Dictation authorization is missing');
  const auth = await withDeviceAuthority(env, (view, now) => view.authorizeRequest({ header: offered.proof, method: 'GET', target: `${url.pathname}${url.search}`, body: new Uint8Array(), capabilities: ['session.prompt'], browserOnly: true, accountScope: false }, now));
  if (auth.status === 'error') return fail(auth.error.code === DEVICE_AUTHORITY_UNAVAILABLE ? 503 : auth.error.code === 'RPC_FORBIDDEN' ? 403 : 401, auth.error.code, auth.error.message);
  const { device } = auth.value, { projectId, workspaceId } = query.data;
  if ((device.scope.kind === 'project' && device.scope.projectId !== projectId) || (device.scope.kind === 'workspace' && device.scope.workspaceId !== workspaceId)) return fail(403, 'RPC_FORBIDDEN', 'Workspace is outside the device scope');
  const denied = accountAccessResponse(await activeAccount(env, env.ACCOUNT_ID));
  if (denied) return denied;
  try { await requireWorkspaceAccess(env, env.ACCOUNT_ID, RuntimeIdentitySchema.parse({ projectId, workspaceId }), false); } catch (error) { return fail(404, 'WORKSPACE_UNAVAILABLE', described(error)); }
  const pair = new WebSocketPair();
  const client = pair[0], server = pair[1];
  server.binaryType = 'arraybuffer';
  server.accept();
  void dictate(server, () => transcriber(server, env, models, projectId));
  return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': offered.protocol } });
}
