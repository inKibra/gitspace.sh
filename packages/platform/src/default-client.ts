import { z } from 'zod';
import { machineNativePlatformSchema } from '@gitspace/protocol/deployment';
import { defaultNativeArtifactSchema, machineClientSchema, verifyDefaultObject, type DefaultRelease, type DefaultReleaseReader, type MachineClient } from '@gitspace/protocol/default-release';
import { defaultReleaseReader } from './default-release.js';
import { tenantDefaultRelease } from './default-native.js';

type MachinePlatform = z.infer<typeof machineNativePlatformSchema>;
/** A client and the object key its bytes are published under. */
type LocatedClient = { client: MachineClient; key: string };
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const digestSchema = z.object({ sha256: sha256Schema, size: z.number().int().positive() });
/** The fields of a published `releases/<release>/<platform>/manifest.json` that name its client. */
const clientManifestSchema = z.object({
  release: machineClientSchema.shape.release, platform: machineNativePlatformSchema, client: digestSchema,
  machine: defaultNativeArtifactSchema.optional(),
});
const stableChannelSchema = z.object({ schemaVersion: z.literal(1), release: machineClientSchema.shape.release, platform: machineNativePlatformSchema, manifest: digestSchema }).strict();

/**
 * The client published beside a default's native machine for `platform`, or null when the default has no machine for it
 * or no distribution manifest beside it. The manifest must name that same machine, which the hash-pinned default records.
 */
export async function defaultClient(reader: DefaultReleaseReader, release: Pick<DefaultRelease, 'machines'>, platform: MachinePlatform): Promise<LocatedClient | null> {
  const native = release.machines.find(machine => machine.platform === platform);
  if (!native) return null;
  const location = /^(distribution\/v1\/releases\/([^/]+)\/[^/]+\/)machine\/manifest\.json$/u.exec(native.artifact.key);
  if (!location) return null;
  const [, root, name] = location;
  const published = await reader.get(`${root}manifest.json`);
  if (!published) return null;
  const manifest = clientManifestSchema.parse(JSON.parse(new TextDecoder().decode(published.bytes)));
  if (manifest.release !== name || manifest.platform !== platform || JSON.stringify(manifest.machine) !== JSON.stringify(native)) {
    throw new Error('Default client manifest does not name the default machine');
  }
  return { client: { release: manifest.release, platform, sha256: manifest.client.sha256, size: manifest.client.size }, key: `${root}gitspace` };
}

/** The client the platform's stable channel names for `platform`, read through the manifest digest the channel records. */
export async function stableClient(reader: DefaultReleaseReader, platform: MachinePlatform): Promise<LocatedClient> {
  const stored = await reader.get(`distribution/v1/stable/${platform}.json`);
  if (!stored) throw new Error(`Stable channel missing for ${platform}`);
  const channel = stableChannelSchema.parse(JSON.parse(new TextDecoder().decode(stored.bytes)));
  if (channel.platform !== platform) throw new Error('Stable channel names another platform');
  const root = `distribution/v1/releases/${channel.release}/${platform}/`;
  const manifest = clientManifestSchema.parse(JSON.parse(new TextDecoder().decode(await verifyDefaultObject(reader, { key: `${root}manifest.json`, ...channel.manifest }))));
  if (manifest.release !== channel.release || manifest.platform !== platform) throw new Error('Stable manifest does not match its channel');
  return { client: { release: manifest.release, platform, sha256: manifest.client.sha256, size: manifest.client.size }, key: `${root}gitspace` };
}

/**
 * `GET /machine-release/client/<platform>` answers the tenant's installer client: its default release's client for that
 * platform, else the stable channel's. `GET|HEAD …/client/<platform>/<release>` streams that client while it is the answer.
 * Caller authenticates the tenant's platform token before entering this helper.
 */
export async function machineClientResponse(request: Request, env: Env, tenant: string, path: string): Promise<Response> {
  const match = /^\/machine-release\/client\/([a-z0-9-]+)(?:\/([^/]+))?$/u.exec(path);
  const platform = machineNativePlatformSchema.safeParse(match?.[1]);
  if (!match || !platform.success) return Response.json({ error: { code: 'UNKNOWN_PLATFORM', message: 'No client is published for that platform' } }, { status: 404 });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  try {
    const own = await defaultClient(defaultReleaseReader(env.RELEASES), await tenantDefaultRelease(env, tenant), platform.data);
    const [{ client, key }, bucket] = own ? [own, env.RELEASES] : [await stableClient(defaultReleaseReader(env.DISTRIBUTION), platform.data), env.DISTRIBUTION];
    if (match[2] === undefined) return Response.json(client, { headers: { 'cache-control': 'private, no-store' } });
    if (match[2] !== client.release) return new Response('Not found', { status: 404 });
    const body = request.method === 'HEAD' ? null : await bucket.get(key);
    const object = body ?? await bucket.head(key);
    if (!object) return new Response('Not found', { status: 404 });
    if (object.size !== client.size) {
      await body?.body.cancel();
      throw new Error('Published client size does not match its manifest');
    }
    const headers = { 'content-type': 'application/octet-stream', 'content-length': String(object.size), 'x-gitspace-sha256': `sha256:${client.sha256}` };
    return new Response(body?.body ?? null, { headers });
  } catch (error) {
    return Response.json({ error: { code: 'MACHINE_CLIENT_UNAVAILABLE', message: error instanceof Error ? error.message : 'Machine client unavailable' } }, { status: 409 });
  }
}
