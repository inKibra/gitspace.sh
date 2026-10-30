import { expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { parseInstallMetadata } from '@gitspace/protocol/install-script';
import { NATIVE_UPSTREAMS, PORTABLE_ENTRYPOINTS, portableFileKey, type MachineNativeFile, type MachineNativeName } from '@gitspace/protocol/machine-release';
import worker from '../src/index.js';

const encoder = new TextEncoder();
const get = (path: string) => worker.fetch(new Request(`${env.ACCOUNT_URL}${path}`), env);
const hex = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

/** The account's default release as the account holds it: its portable files and manifest in DATA, its natives in the
 * account's copy, and its record staged. Every tool of every platform is one byte, `<os>-<tool>`. */
async function launched(sha: string) {
  const key = `releases/${sha}/portable.manifest.json`;
  const files = [];
  for (const path of PORTABLE_ENTRYPOINTS) {
    const bytes = encoder.encode(`${path} of ${sha}`);
    await env.DATA.put(`users/${env.ACCOUNT_ID}/${portableFileKey(key, path)}`, bytes, { customMetadata: { sha256: `sha256:${await hex(bytes)}` } });
    files.push({ path, sha256: await hex(bytes), size: bytes.byteLength });
  }
  const assets = new Map<string, Uint8Array>();
  const native = async (name: MachineNativeName, abi: MachineNativeFile['abi']): Promise<MachineNativeFile> => {
    const asset = encoder.encode(`${abi.os}-${name}`);
    const sha256 = await hex(asset);
    assets.set(sha256, asset);
    await env.DATA.put(`users/${env.ACCOUNT_ID}/natives/sha256/${sha256}`, asset);
    return { version: name === 'bun' ? '1.4.0' : '1.0.0', url: `${NATIVE_UPSTREAMS[name]}v1/${abi.os}-${name}.zip`, sha256, size: asset.byteLength, member: `${name}-${abi.os}/${name}`, executable: { sha256: 'b'.repeat(64), size: 9 }, abi };
  };
  const darwin = { bun: await native('bun', { os: 'darwin', macos: '13.0' }), rg: await native('rg', { os: 'darwin', macos: '13.0' }), 'git-lfs': await native('git-lfs', { os: 'darwin', macos: '13.0' }) };
  const linux = { bun: await native('bun', { os: 'linux', glibc: '2.17' }), rg: await native('rg', { os: 'linux', glibc: null }), 'git-lfs': await native('git-lfs', { os: 'linux', glibc: null }) };
  const manifest = encoder.encode(JSON.stringify({ schemaVersion: 1, bunVersion: '1.4.0', files, natives: { 'darwin-arm64': darwin, 'darwin-x64': darwin, 'linux-arm64': linux, 'linux-x64': linux } }));
  await env.DATA.put(`users/${env.ACCOUNT_ID}/${key}`, manifest);
  await env.TENANT_RELEASES.getByName(env.ACCOUNT_ID).stage({
    sha, label: `build ${sha}`, source: { kind: 'canonical', repository: 'inKibra/gitspace.sh', branch: 'develop', commit: 'a'.repeat(40) }, inferenceVersion: 1,
    artifacts: { worker: null, machine: null, frontend: null, portable: { key, hash: `sha256:${await hex(manifest)}`, size: manifest.byteLength } }, worker: null,
  }, 'machine-a');
  await env.TENANT_RELEASES.getByName(env.ACCOUNT_ID).adoptDefault(sha);
  const client = files.find(file => file.path === 'cli/gitspace.js')!;
  return { manifestSha256: await hex(manifest), darwin, linux, client, assets };
}

it('serves an installer that installs this account\'s release and pairs with --pair', async () => {
  const response = await get('/install');
  expect(response.status).toBe(200);
  const script = await response.text();
  expect(script).toContain('base="${GITSPACE_DISTRIBUTION_URL:-https://test.gitspace.sh/distribution/v1}"');
  expect(script).toContain('"${install_dir}/gitspace" machine setup --pair "$pair"');
});

it('names nothing to install before the account has a machine release', async () => {
  expect((await get('/distribution/v1/install/linux-x64.txt')).status).toBe(503);
});

it('names its release, the platform\'s pinned Bun and the client, and serves only those before pairing', async () => {
  const release = await launched('install-a');
  const linux = parseInstallMetadata(await (await get('/distribution/v1/install/linux-x64.txt')).text());
  expect(linux).toEqual({
    release: 'install-a', portableSha256: release.manifestSha256,
    bun: { sha256: release.linux.bun.sha256, size: release.linux.bun.size, executableSha256: 'b'.repeat(64), executableSize: 9, member: 'bun-linux/bun' },
    cli: { sha256: release.client.sha256, size: release.client.size },
  });
  expect(parseInstallMetadata(await (await get('/distribution/v1/install/darwin-arm64.txt')).text()).bun.sha256).toBe(release.darwin.bun.sha256);
  expect((await get('/distribution/v1/install/windows-x64.txt')).status).toBe(404);
  const bun = await get(`/distribution/v1/natives/${release.darwin.bun.sha256}`);
  expect(new TextDecoder().decode(await bun.arrayBuffer())).toBe('darwin-bun');
  // A native the release does not name, and any portable file but the client, are not served before pairing.
  const other = encoder.encode('other');
  await env.DATA.put(`users/${env.ACCOUNT_ID}/natives/sha256/${await hex(other)}`, other);
  expect((await get(`/distribution/v1/natives/${await hex(other)}`)).status).toBe(404);
  const client = await get('/distribution/v1/releases/install-a/cli/gitspace.js');
  expect(new TextDecoder().decode(await client.arrayBuffer())).toBe('cli/gitspace.js of install-a');
  expect((await get('/distribution/v1/releases/install-a/machine/machine.js')).status).toBe(404);
  expect((await get('/distribution/v1/releases/install-other/cli/gitspace.js')).status).toBe(404);
});
