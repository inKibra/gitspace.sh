/**
 * One model request on one account, as plain data. The workspace object chooses the account (`createVaultModels`) and
 * hands the attempt to a runner; in a workspace that is the inference worker, which builds and sends the request with
 * pi-ai and streams pi's events back (`docs/INFERENCE-WORKER-DESIGN.md`). Images in an attempt's context are stored
 * references; only a runner given `images` can send them, writing each image in as the request streams out.
 */
import { createModels, InMemoryModelsStore, type Api, type AssistantMessageEvent, type AuthResult, type Context, type ImageContent, type Message, type Model, type Provider, type TextContent } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { z } from 'zod';
import type { InferenceProfile } from '@gitspace/protocol/inference';
import { admitProfileProviders } from './admission.js';
import { applyProviderCatalog } from './catalog.js';
import { claudeCode, type ClaudeCodeTransport } from './claude-code-request.js';
import { fastServingProvider } from './fast.js';
import { parseImageReference } from '@gitspace/protocol-runtime/image-reference';
import type { ImageRequestTransport } from './image-requests.js';
import { createLegacyCloudProviders } from './providers/index.js';
import { withPublishedCatalog } from './published-catalog.js';
import type { ResolvedCredential } from './selection.js';

/** The Claude Code session a request is shaped as: the device is the profile's, the session the requesting view's. */
export interface ClaudeIdentity { profileId: string; sessionId: string }
export interface InferenceAttempt {
  method: 'stream' | 'streamSimple';
  model: Model<Api>;
  /** Images are stored references (`gs-image:v1:…`), never bytes. */
  context: Context;
  /** The request's stream options, without functions or signals (`attemptOptions`). */
  options: Record<string, unknown>;
  credential: ResolvedCredential;
  settings: InferenceProfile['settings'];
  fastMode: boolean;
  claude: ClaudeIdentity;
}
/** What an attempt streams back: pi's events, and the provider's status and headers once they arrive (a failure's
 * account policy and the provider's reset are read from them). */
export type AttemptResponse = { type: 'response'; status: number; headers: Record<string, string> };
export type AttemptEvent = AssistantMessageEvent | AttemptResponse;
export type AttemptRunner = (attempt: InferenceAttempt, signal?: AbortSignal) => AsyncIterable<AttemptEvent>;

/** A request's options as an attempt carries them: functions and signals cannot cross to the inference worker. */
export function attemptOptions(options: object | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(options ?? {}).filter(([, value]) => value !== undefined && typeof value !== 'function' && !(value instanceof AbortSignal)));
}

/** pi-ai's providers and GitSpace's own, before a profile admits them. */
export function inferenceProviderSource(): readonly Provider[] {
  return [...builtinProviders().map(provider => withPublishedCatalog(provider)), ...createLegacyCloudProviders()];
}
/** The providers a profile admits, with GitSpace's catalog patches. */
export function profileProviders(settings: InferenceProfile['settings'], source: readonly Provider[] = inferenceProviderSource()): readonly Provider[] {
  return admitProfileProviders(settings, source.map(applyProviderCatalog));
}

const cloudflareKeySchema = z.object({ token: z.string().min(1), accountId: z.string().min(1) });
/** The auth a resolved account sends with. */
export function requestAuth(resolved: ResolvedCredential): AuthResult {
  const credential = resolved.credential;
  if (credential.type === 'api_key') {
    // Workers AI needs the account id in its URL; the key is stored as {"token","accountId"}.
    if (resolved.provider !== 'cloudflare-workers-ai') return { auth: { apiKey: credential.key } };
    let parsed: unknown;
    try { parsed = JSON.parse(credential.key); } catch { throw new Error('Cloudflare Workers AI key must be {"token":"…","accountId":"…"}'); }
    const key = cloudflareKeySchema.parse(parsed);
    return { auth: { apiKey: key.token }, env: { CLOUDFLARE_ACCOUNT_ID: key.accountId } };
  }
  switch (resolved.provider) {
    case 'google-gemini-cli': case 'google-antigravity':
      if (!credential.projectId) throw new Error('Google OAuth account has no authorized project');
      return { auth: { apiKey: JSON.stringify({ access: credential.access, projectId: credential.projectId }) } };
    case 'openai-codex':
      if (!credential.accountId) throw new Error('Codex OAuth account has no account identity');
      return { auth: { apiKey: credential.access, headers: { 'ChatGPT-Account-ID': credential.accountId } } };
    default: return { auth: { apiKey: credential.access, ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}), ...(credential.headers ? { headers: credential.headers } : {}) } };
  }
}

export const noAmbientAuth = { env: async () => undefined, fileExists: async () => false };

/**
 * Bedrock's provider decodes each image's base64 to bytes for the AWS SDK, which writes them back as base64 into its
 * JSON body and sends it with the global `fetch`. A reference cannot survive the decoding, so a Bedrock attempt sends a
 * stand-in instead: valid base64 that decodes and encodes back to itself, mapped to its reference while the attempt
 * runs. `restoreStandIns` turns a body's stand-ins back into references for the image transport to write in.
 */
const STAND_IN = /AEdTSU1H[A-Za-z0-9+/]{16}/gu;
const standIns = new Map<string, string>();
function standIn(reference: string): string {
  const bytes = new Uint8Array(18);
  bytes.set([0, 71, 83, 73, 77, 71]);
  crypto.getRandomValues(bytes.subarray(6));
  const token = btoa(String.fromCharCode(...bytes));
  standIns.set(token, reference);
  return token;
}
/** `body` with each stand-in of a running Bedrock attempt replaced by its reference; the same string when it has none. */
export function restoreStandIns(body: string): string {
  return body.includes('AEdTSU1H') ? body.replace(STAND_IN, token => standIns.get(token) ?? token) : body;
}

/** `context` with each stored image's data replaced by `replace(part)`. */
async function replaceImages(context: Context, replace: (part: ImageContent) => Promise<string>): Promise<Context> {
  const replaced = (content: Array<TextContent | ImageContent>) => Promise.all(content.map(async part => part.type === 'image' && parseImageReference(part.data) ? { ...part, data: await replace(part) } : part));
  const messages = await Promise.all(context.messages.map(async (message): Promise<Message> => {
    if (message.role === 'toolResult') return { ...message, content: await replaced(message.content) };
    if (message.role === 'user' && typeof message.content !== 'string') return { ...message, content: await replaced(message.content) };
    return message;
  }));
  return { ...context, messages };
}

/** pi-ai adapters that refuse a custom `fetch` and send through their SDK with the global one (Google's). */
const GLOBAL_FETCH_APIS: Readonly<Record<string, true>> = { 'google-generative-ai': true, 'google-vertex': true };

export interface AttemptRunnerOptions {
  /** The providers an attempt's model may name; the profile's admitted ones by default. */
  providers?(settings: InferenceProfile['settings']): readonly Provider[];
  /** Sends a request carrying the workspace's stored images, writing each in as the request streams out. Without it an
   * attempt with stored images is refused. */
  imageTransport?: ImageRequestTransport;
}

/** Runs attempts in this isolate: pi-ai builds and sends each request, with Claude Code's shape for a subscription. */
export function createAttemptRunner(runner: AttemptRunnerOptions = {}): AttemptRunner {
  const shapes = new Map<string, Promise<ClaudeCodeTransport>>();
  return async function* run(attempt, signal) {
    signal?.throwIfAborted();
    const providers = runner.providers ? runner.providers(attempt.settings) : profileProviders(attempt.settings);
    const provider = providers.find(candidate => candidate.id === attempt.model.provider);
    if (!provider) throw new Error(`Provider ${attempt.model.provider} is not admitted by the inference profile`);
    const key = `${attempt.claude.profileId}\n${attempt.claude.sessionId}`;
    let shaping = shapes.get(key);
    if (!shaping) {
      // One shape per requesting view; a view lives as long as an admission, so a few are held at a time.
      if (shapes.size >= 64) shapes.delete(shapes.keys().next().value!);
      shaping = claudeCode(attempt.claude, runner.imageTransport);
      shapes.set(key, shaping);
    }
    const shape = await shaping;
    const responses: AttemptResponse[] = [];
    let observed = false;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await shape.fetch(input, init);
      observed = true;
      responses.push({ type: 'response', status: response.status, headers: Object.fromEntries(response.headers.entries()) });
      return response;
    };
    let context = attempt.context;
    const tokens: string[] = [];
    if (attempt.model.api === 'bedrock-converse-stream') context = await replaceImages(context, async part => { const token = standIn(part.data); tokens.push(token); return token; });
    try {
      const models = createModels({ authContext: noAmbientAuth, modelsStore: new InMemoryModelsStore() });
      const auth = requestAuth(attempt.credential);
      models.setProvider({ ...(attempt.fastMode ? fastServingProvider(provider) : provider), auth: { apiKey: { name: 'Profile vault', resolve: async ({ signal: resolving }) => { resolving.throwIfAborted(); return { ...auth, source: 'Profile vault' }; } } } });
      const request = {
        ...attempt.options, ...(signal ? { signal } : {}), ...(GLOBAL_FETCH_APIS[attempt.model.api] ? {} : { fetch }), onPayload: shape.onPayload,
        // A provider that sends without our fetch (Bedrock's and Google's SDKs) reports its answer here.
        onResponse: async (response: { status: number; headers: Record<string, string> }) => { if (!observed) responses.push({ type: 'response', status: response.status, headers: response.headers }); },
      };
      const events = attempt.method === 'stream' ? models.stream(attempt.model, context, request) : models.streamSimple(attempt.model, context, request);
      for await (const event of events) {
        yield* responses.splice(0);
        yield event;
      }
      yield* responses.splice(0);
    } finally {
      for (const token of tokens) standIns.delete(token);
    }
  };
}

const encoder = new TextEncoder();
/** An attempt's events as newline-delimited JSON, for an RPC answer. Cancelling the stream aborts the attempt. */
export function attemptEventStream(run: (signal: AbortSignal) => AsyncIterable<AttemptEvent>): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  const events = run(abort.signal)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next();
      if (next.done) return controller.close();
      controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
    },
    async cancel(reason) {
      abort.abort(reason instanceof Error ? reason : new Error('The attempt was cancelled'));
      await events.return?.(undefined);
    },
  });
}

/** The events of `attemptEventStream`'s stream; aborting `signal` cancels it, and with it the attempt. */
export async function* attemptEvents(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<AttemptEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  let finished = false;
  try {
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        yield JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    }
    finished = true;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!finished) await reader.cancel().catch(() => undefined);
  }
}
