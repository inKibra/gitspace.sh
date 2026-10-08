import { z } from 'zod';
import { machineNativePlatformSchema } from '@gitspace/protocol/deployment';
import { defaultMachineRelease, defaultMachineObject, defaultNativeSelectionSchema, loadPinnedDefaultRelease, verifyDefaultObject } from '@gitspace/protocol/default-release';
import { defaultReleaseReader } from './default-release.js';

type NativeSelection = z.infer<typeof defaultNativeSelectionSchema>;
async function historicalPlatform(bucket: R2Bucket, generation: string): Promise<NativeSelection['platform']> {
  const reader = defaultReleaseReader(bucket);
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: 'distribution/v1/releases/', cursor, limit: 1000 });
    for (const object of page.objects) {
      const match = /^distribution\/v1\/releases\/[^/]+\/([^/]+)\/manifest.json$/u.exec(object.key);
      if (!match) continue;
      const platform = machineNativePlatformSchema.safeParse(match[1]);
      if (!platform.success) continue;
      const body = await reader.get(object.key);
      if (!body) continue;
      const parsed = z.object({ platform: machineNativePlatformSchema, provenance: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().nonnegative() }) }).safeParse(JSON.parse(new TextDecoder().decode(body.bytes)));
      if (!parsed.success || parsed.data.platform !== platform.data) continue;
      const provenance = await verifyDefaultObject(reader, { ...parsed.data.provenance, key: object.key.replace(/manifest.json$/u, 'provenance.json') });
      const proof = z.object({ platform: machineNativePlatformSchema, machine: z.object({ treeHash: z.string() }) }).safeParse(JSON.parse(new TextDecoder().decode(provenance)));
      if (proof.success && proof.data.platform === platform.data && proof.data.machine.treeHash === generation) return platform.data;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return undefined;
}
/** Caller authenticates the tenant's platform token before entering this helper. */
export async function defaultMachineResponse(request: Request, env: Env, tenant: string): Promise<Response> {
  try {
    const active = (await env.DEPLOYMENTS.getByName(tenant).getState()).active;
    const pin = active?.metadata.resources.find(resource => resource.name === 'DEFAULT_ACCOUNT_RELEASE');
    if (pin?.source !== 'literal' || !pin.value) throw new Error('Tenant has no pinned default release');
    const reader = defaultReleaseReader(env.RELEASES);
    const release = await loadPinnedDefaultRelease(reader, pin.value);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/blob')) {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const key = url.searchParams.get('key') ?? '';
      const bytes = await defaultMachineObject(reader, release, key);
      let sha256: string | undefined;
      for (const native of release.machines) {
        const object = native.artifact.key === key ? native.artifact : native.chunks.find(chunk => chunk.key === key || key === `objects/sha256/${chunk.sha256}`);
        if (object) { sha256 = object.sha256; break; }
      }
      if (!sha256) throw new Error('Verified native object descriptor disappeared');
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength), 'x-gitspace-sha256': `sha256:${sha256}` } });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const selection = defaultNativeSelectionSchema.parse(await request.json());
    if (!selection.platform && selection.generation && !await reader.get(`distribution/v1/generations/${selection.generation.slice(7)}.json`)) selection.platform = await historicalPlatform(env.RELEASES, selection.generation);
    return Response.json(await defaultMachineRelease(reader, release, selection));
  } catch (error) { return Response.json({ error: { code: 'DEFAULT_MACHINE_UNAVAILABLE', message: error instanceof Error ? error.message : 'Default machine unavailable' } }, { status: 409 }); }
}
