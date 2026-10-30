// The built inference worker in workerd (Miniflare), as the tenant loads it: every provider's request with stored images,
// checked byte for byte where it leaves the worker. A fake reader serves the workspace's images; each provider's
// upstream is Miniflare's outbound handler, which records the request and refuses it.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import type { Api, Model } from '@earendil-works/pi-ai';
import { profileProviders, XxHash64, type AttemptEvent, type InferenceAttempt } from '@gitspace/runtime-core/inference';
import { imageReference } from '@gitspace/protocol-runtime/image-reference';
import { buildInferenceWorker } from '../src/build';

const workspaceId = 'ws-test';
/** Deterministic image bytes a reference names. */
function imageBytes(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (index * 7 + size) % 256);
}
const images = [5000, 3].map(size => ({ size, reference: imageReference({ workspaceId, size, width: 4, height: 4, sha256: size.toString(16).padStart(64, '0') }) }));
const base64 = (size: number) => Buffer.from(imageBytes(size)).toString('base64');

type Sent = { url: string; headers: Record<string, string>; body: Uint8Array };
const sent: Sent[] = [];
let mf: Miniflare;

beforeAll(async () => {
  const { source, wasm } = await buildInferenceWorker();
  mf = new Miniflare({
    workers: [
      {
        name: 'host', modules: true, compatibilityDate: '2026-02-01', compatibilityFlags: ['nodejs_compat'],
        serviceBindings: { INFERENCE: { name: 'inference', entrypoint: 'Inference' } },
        script: `export default { async fetch(request, env) { const stream = await env.INFERENCE.run(await request.json()); return new Response(stream); } };`,
      },
      {
        name: 'inference', modules: [{ type: 'ESModule', path: 'inference.js', contents: source }, { type: 'CompiledWasm', path: 'xxhash.wasm', contents: wasm }],
        compatibilityDate: '2026-02-01', compatibilityFlags: ['nodejs_compat'],
        serviceBindings: { READER: { name: 'reader', entrypoint: 'Reader' } },
        outboundService: async request => {
          sent.push({ url: request.url, headers: Object.fromEntries(request.headers), body: new Uint8Array(await request.arrayBuffer()) });
          return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'test upstream' }, message: 'test upstream' }), { status: 400, headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException' } });
        },
      },
      {
        name: 'reader', modules: true, compatibilityDate: '2026-02-01',
        script: `import { WorkerEntrypoint } from 'cloudflare:workers';
          export class Reader extends WorkerEntrypoint {
            async read(reference) {
              const [, , workspace, size] = reference.split(':');
              if (workspace !== ${JSON.stringify(workspaceId)}) throw new Error('Image ' + reference + " is not this workspace's");
              return new Response(Uint8Array.from({ length: Number(size) }, (_, index) => (index * 7 + Number(size)) % 256)).body;
            }
          }
          export default { fetch: () => new Response('reader') };`,
      },
    ],
  });
});
afterAll(async () => { await mf?.dispose(); });

function model(provider: string, id: string): Model<Api> {
  const found = profileProviders({}).find(candidate => candidate.id === provider)?.getModels().find(candidate => candidate.id === id);
  if (!found) throw new Error(`No ${provider}/${id} in the catalog`);
  return found;
}
async function events(target: Model<Api>, credential: InferenceAttempt['credential']['credential'], references = images.map(image => image.reference)): Promise<AttemptEvent[]> {
  sent.length = 0;
  const attempt: InferenceAttempt = {
    method: 'streamSimple', model: target, settings: {}, fastMode: false, options: { maxTokens: 64 },
    credential: { id: 'account', provider: target.provider, revision: 1, credential },
    claude: { profileId: 'profile', sessionId: crypto.randomUUID() },
    context: { systemPrompt: 'Answer briefly.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe these images.' }, ...references.map(data => ({ type: 'image' as const, mimeType: 'image/png', data }))], timestamp: 1 }] },
  };
  const response = await mf.dispatchFetch('http://host/', { method: 'POST', body: JSON.stringify(attempt) });
  return (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AttemptEvent);
}
async function run(target: Model<Api>, credential: InferenceAttempt['credential']['credential']): Promise<{ events: AttemptEvent[]; request: Sent }> {
  const received = await events(target, credential);
  const request = sent.at(-1);
  if (!request) throw new Error(`Nothing was sent: ${JSON.stringify(received).slice(0, 600)}`);
  return { events: received, request };
}
const text = (request: Sent) => new TextDecoder().decode(request.body);
const oauth = { type: 'oauth' as const, access: 'sk-ant-oat01-test', expires: 4_102_444_800_000 };
const key = (value: string) => ({ type: 'api_key' as const, key: value });

it('streams a Claude subscription request with the images written in and the attestation over the expanded body', async () => {
  const { request, events } = await run(model('anthropic', 'claude-opus-5-5'), oauth);
  const body = text(request);
  for (const image of images) expect(body).toContain(`"data":"${base64(image.size)}"`);
  expect(body).not.toContain('gs-image:');
  expect(Number(request.headers['content-length'])).toBe(request.body.length);
  // The attestation is XXH64 of the sent body with the placeholder in place.
  const cch = /cc_entrypoint=cli; cch=([0-9a-f]{5});/u.exec(body)![1]!;
  const hash = new XxHash64(0x4d659218e32a3268n);
  hash.update(new TextEncoder().encode(body.replace(`cch=${cch};`, 'cch=00000;')));
  expect((hash.digest() & 0xfffffn).toString(16).padStart(5, '0')).toBe(cch);
  expect(events.at(-1)).toMatchObject({ type: 'error' });
  expect(events).toContainEqual(expect.objectContaining({ type: 'response', status: 400 }));
});

it('streams OpenAI, Google and Gemini CLI requests with the images written into their own encodings', async () => {
  const openai = text((await run(model('openai', 'gpt-4.1'), key('sk-test'))).request);
  for (const image of images) expect(openai).toContain(`data:image/png;base64,${base64(image.size)}"`);
  const google = text((await run(model('google', 'gemini-2.5-flash'), key('google-test'))).request);
  for (const image of images) expect(google).toContain(`"data":"${base64(image.size)}"`);
  const cli = text((await run(model('google-gemini-cli', 'gemini-2.5-flash'), { type: 'oauth', access: 'ya29.test', expires: 4_102_444_800_000, projectId: 'project' })).request);
  for (const image of images) expect(cli).toContain(`"data":"${base64(image.size)}"`);
  for (const body of [openai, google, cli]) expect(body).not.toContain('gs-image:');
});

it('sends a Bedrock request through the AWS SDK with the images written in and bearer auth', async () => {
  const { request, events } = await run(model('amazon-bedrock', 'us.anthropic.claude-opus-5-5'), key('bedrock-test'));
  expect(request.url).toContain('/converse-stream');
  expect(request.headers.authorization).toBe('Bearer bedrock-test');
  const body = text(request);
  for (const image of images) expect(body).toContain(`"bytes":"${base64(image.size)}"`);
  expect(body).not.toContain('AEdTSU1H');
  expect(Number(request.headers['content-length'])).toBe(request.body.length);
  expect(events.at(-1)).toMatchObject({ type: 'error' });
});

it('refuses a request naming another workspace\'s image with the reason, as the provider would', async () => {
  const foreign = imageReference({ workspaceId: 'ws-other', size: 10, width: 1, height: 1, sha256: 'f'.repeat(64) });
  const received = await events(model('anthropic', 'claude-opus-5-5'), oauth, [foreign]);
  const error = received.find(event => event.type === 'error');
  expect(sent).toEqual([]);
  expect(JSON.stringify(error)).toContain("is not this workspace's");
});
