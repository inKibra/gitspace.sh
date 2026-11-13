import { afterEach, expect, it, vi } from 'vitest';
import type { InferenceProfile } from '@gitspace/protocol/inference';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import type { AttemptRunner } from '@gitspace/runtime-core/inference';
import { createCloudRuntimeInference } from '../src/runtime-inference.js';

const stamp = '2026-01-01T00:00:00.000Z';
afterEach(() => { vi.restoreAllMocks(); });
/** A PNG's signature and header. */
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]).toString('base64');
const drawn = { type: 'image' as const, mimeType: 'image/png', data: png };

it("generates images with the profile's Images service: a FLUX model on Workers AI, or an image model of the profile", async () => {
  const bodies = new Map<string, unknown>();
  const state = { storage: {
    get: async (key: string) => bodies.get(key),
    put: async (key: string, value: unknown) => { bodies.set(key, structuredClone(value)); },
    delete: async (key: string) => bodies.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...bodies].filter(([key]) => key.startsWith(prefix))),
  } } as unknown as DurableObjectState;
  let profile: InferenceProfile = { version: 1, id: 'profile', name: 'Profile', revision: 1, settings: {}, createdAt: stamp, updatedAt: stamp };
  const accounts = [{ id: 'key', provider: 'openrouter', type: 'api_key', revision: 1, expiresAt: null, identity: 'key' }];
  const vault = {
    resolveCloudInference: async () => ({ profile, assignmentRevision: 1 }),
    cloudInferenceCatalog: async () => ({ profile, assignmentRevision: 1, catalogJson: null, accounts }),
    cloudCredentialAccounts: async () => accounts,
    cloudResolveCredential: async () => ({ id: 'key', provider: 'openrouter', revision: 1, credential: { type: 'api_key', key: 'sk-or-key' } }),
    cloudCredentialFailure: async () => ({ label: 'key', until: 0 }),
    cloudProfileCatalog: async () => '{}',
  };
  // What Workers AI was sent: the model, and the multipart form's fields.
  const sent: { model: string; prompt: unknown; image: unknown }[] = [];
  const run = vi.fn(async (model: string, inputs: { multipart: { body: ReadableStream; contentType: string } }) => {
    const form = await new Response(inputs.multipart.body, { headers: { 'content-type': inputs.multipart.contentType } }).formData();
    const image = form.get('input_image_0');
    sent.push({ model, prompt: form.get('prompt'), image: image instanceof Blob ? Buffer.from(await image.arrayBuffer()).toString('base64') : image });
    return { image: png };
  });
  // OpenRouter's image models answer over its chat completions endpoint.
  const requested: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requested.push({ url: request.url, body: await request.json() });
    return Response.json({ id: 'generation', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] } }] });
  });
  const attempts: AttemptRunner = async function* () { throw new Error('Images are not chat attempts'); };
  const environment = { ACCOUNT_ID: 'account', CREDENTIALS: { getByName: () => vault }, AI: { run } } as unknown as Env;
  const runtime = await createCloudRuntimeInference(state, environment, RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), [], attempts);
  const chat = (await runtime.session.catalog()).models[0]!;
  const admitted = async (revision: number, images: string) => {
    profile = { ...profile, revision, settings: { 'modelRoles.default': `openrouter/${chat.id}`, images } };
    await runtime.admitInference({ conversationId: 'conversation', requestId: `request-${revision}` });
    await runtime.bindInferenceConversation('conversation', new AbortController().signal, [], [`request-${revision}`], { fastMode: false });
  };

  await admitted(2, 'cloudflare/flux-2-klein-9b');
  expect(await runtime.generateImage({ conversationId: 'conversation', args: { prompt: 'a folded map', images: [drawn] } })).toEqual([drawn]);
  expect(sent).toEqual([{ model: '@cf/black-forest-labs/flux-2-klein-9b', prompt: 'a folded map', image: png }]);
  expect(requested).toEqual([]);

  // FLUX.1 [schnell] takes no input images.
  await admitted(3, 'cloudflare/flux-1-schnell');
  await expect(runtime.generateImage({ conversationId: 'conversation', args: { prompt: 'a folded map', images: [drawn] } }))
    .rejects.toThrow('Image generation uses cloudflare/flux-1-schnell: FLUX.1 [schnell] takes no input images; FLUX.2 models do. Change it in Inference → Services.');

  await admitted(4, 'openrouter/black-forest-labs/flux.2-klein-4b');
  expect(await runtime.generateImage({ conversationId: 'conversation', args: { prompt: 'a folded map' } })).toEqual([drawn]);
  expect(requested).toEqual([{ url: 'https://openrouter.ai/api/v1/chat/completions', body: expect.objectContaining({ model: 'black-forest-labs/flux.2-klein-4b' }) }]);
  expect(run).toHaveBeenCalledTimes(1);
});
