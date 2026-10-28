import { expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { HttpResponse, http } from 'msw';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol';
import { deploymentStatusSchema, releaseRecordSchema, type StageReleaseInput } from '@gitspace/protocol/deployment';
import { NATIVE_UPSTREAMS, PORTABLE_ENTRYPOINTS, portableFileKey, type MachineNativeFile, type MachineNativeName, type PortableManifest } from '@gitspace/protocol/machine-release';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

const machineSigningPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 71);
const hex = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

async function account() {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'active' }, deployment: { active: null } })));
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)) });
  await vault.registerDevice(signCredentialAuthorityGrant({
    version: 1, userId, machineId: 'builder', generation: 1, capabilities: ['space.control'],
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineSigningPrivateKey)),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(Uint8Array.from({ length: 32 }, (_, index) => 90 + index))),
  }, tenantRootPrivateKey));
  const control = async (operation: 'deploy.stage' | 'deploy.status', payload: Record<string, unknown>) => {
    const response = await SELF.fetch(new Request('https://tenant.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createSignedControlRequest({ userId, machineId: 'builder', operation, payload, signingPrivateKey: machineSigningPrivateKey })),
    }));
    const body = await response.json() as { value?: unknown; error?: { message: string } };
    if (response.status !== 200) throw new Error(body.error?.message ?? `${operation} failed`);
    return body.value;
  };
  return { userId, control };
}

/** A machine's upload of a portable release to DATA, as the release objects route stores it, and the stage naming it. */
async function uploaded(userId: string, sha: string) {
  const key = `releases/${sha}/portable.manifest.json`;
  const files = [];
  for (const path of PORTABLE_ENTRYPOINTS) {
    const bytes = new TextEncoder().encode(`${path} of ${sha}`);
    const sha256 = await hex(bytes);
    await env.DATA.put(`users/${userId}/${portableFileKey(key, path)}`, bytes, { customMetadata: { sha256: `sha256:${sha256}` } });
    files.push({ path, sha256, size: bytes.byteLength });
  }
  const native = (name: MachineNativeName, abi: MachineNativeFile['abi']): MachineNativeFile => ({
    version: name === 'bun' ? '1.4.0' : '1.0.0', url: `${NATIVE_UPSTREAMS[name]}v1/${name}.zip`, sha256: 'a'.repeat(64), size: 1, member: name, executable: { sha256: 'b'.repeat(64), size: 1 }, abi,
  });
  const darwin = { bun: native('bun', { os: 'darwin', macos: '13.0' }), rg: native('rg', { os: 'darwin', macos: '13.0' }), 'git-lfs': native('git-lfs', { os: 'darwin', macos: '13.0' }) };
  const linux = { bun: native('bun', { os: 'linux', glibc: '2.17' }), rg: native('rg', { os: 'linux', glibc: null }), 'git-lfs': native('git-lfs', { os: 'linux', glibc: null }) };
  const manifest: PortableManifest = { schemaVersion: 1, bunVersion: '1.4.0', files, natives: { 'darwin-arm64': darwin, 'darwin-x64': darwin, 'linux-arm64': linux, 'linux-x64': linux } };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  await env.DATA.put(`users/${userId}/${key}`, bytes, { customMetadata: { sha256: `sha256:${await hex(bytes)}` } });
  const input: StageReleaseInput = {
    sha, inferenceVersion: 1, label: `build ${sha}`, source: { kind: 'workspace', workspaceId: 'workspace-a', commit: 'a'.repeat(40), uncommittedFiles: 0 },
    artifacts: { worker: null, machine: { key: `releases/${sha}/machine.manifest.json`, hash: `sha256:${'c'.repeat(64)}`, size: 1 }, frontend: null, portable: { key, hash: `sha256:${await hex(bytes)}`, size: bytes.byteLength } },
    worker: null,
  };
  return { manifest, input };
}

function platformMirror() {
  const requests: unknown[] = [];
  network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/machine-release/natives`, async ({ request }) => {
    requests.push(await request.json());
    return HttpResponse.json({ copied: [] });
  }));
  return requests;
}

it('stages a portable release the account holds as built, after the platform mirrors its natives', async () => {
  const { userId, control } = await account();
  const { manifest, input } = await uploaded(userId, 'portable-held');
  const requests = platformMirror();
  const record = releaseRecordSchema.parse(await control('deploy.stage', input));
  expect(record.artifacts.portable).toEqual(input.artifacts.portable);
  expect(requests).toEqual([{ natives: manifest.natives }]);
});

it('refuses a portable release naming a file the account holds with other bytes, staging nothing', async () => {
  const { userId, control } = await account();
  const { input } = await uploaded(userId, 'portable-changed');
  await env.DATA.put(`users/${userId}/${portableFileKey(input.artifacts.portable!.key, 'machine/machine.js')}`, 'changed', { customMetadata: { sha256: `sha256:${'d'.repeat(64)}` } });
  const requests = platformMirror();
  await expect(control('deploy.stage', input)).rejects.toThrow();
  expect(requests).toEqual([]);
  expect(deploymentStatusSchema.parse(await control('deploy.status', {})).releases.some(release => release.sha === 'portable-changed')).toBe(false);
});
