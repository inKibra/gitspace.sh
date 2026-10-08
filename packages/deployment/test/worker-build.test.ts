import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Miniflare } from 'miniflare';
import { buildWorkerBundle } from '../src/builders.js';

test('builds Worker nodejs_compat imports as native runtime dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-native-build-'));
  try {
    const source = join(root, 'packages/account-worker/src');
    await mkdir(source, { recursive: true });
    await Bun.write(join(source, 'index.ts'), 'import { timingSafeEqual } from "node:crypto"; export default { fetch() { return new Response(String(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1])))); } };');
    await buildWorkerBundle(root, 'a'.repeat(40), join(root, 'out'));
    // Execute only this trusted fixture in a separate runtime, never supplied release code.
    const child = Bun.spawn([process.execPath, '--eval', 'const { default: worker } = await import(process.argv[1]); console.log(await worker.fetch().text());', pathToFileURL(join(root, 'out/worker.mjs')).href], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr, stdout: stdout.trim() }).toEqual({ code: 0, stderr: '', stdout: 'true' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bundled CommonJS node:path and memfs run filesystem operations in workerd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worker-commonjs-build-'));
  let worker: Miniflare | undefined;
  try {
    const source = join(root, 'packages/account-worker/src');
    await mkdir(source, { recursive: true });
    const memfs = Bun.resolveSync('memfs', new URL('../../runtime-workspace-do/src/artifacts-snapshot.ts', import.meta.url).pathname);
    await Bun.write(join(source, 'snapshot.cjs'), `
const path = require('node:path');
const { Volume, createFsFromVolume } = require(${JSON.stringify(memfs)});
const fs = createFsFromVolume(new Volume());
fs.mkdirSync('/snapshot/src', { recursive: true });
fs.writeFileSync(path.join('/snapshot', 'src', 'file.txt'), 'checkpoint contents');
fs.symlinkSync('/snapshot/src/file.txt', '/snapshot/link.txt');
module.exports = () => {
  const resolved = fs.realpathSync('/snapshot/link.txt');
  return { resolved, contents: fs.readFileSync(resolved, 'utf8'), basename: path.basename(resolved) };
};
`);
    await Bun.write(join(source, 'index.ts'), `
import snapshot from './snapshot.cjs';
import { timingSafeEqual } from 'node:crypto';
export default { fetch() {
  return Response.json({ ...snapshot(), equal: timingSafeEqual(new Uint8Array([1]), new Uint8Array([1])) });
} };
`);
    await buildWorkerBundle(root, 'a'.repeat(40), join(root, 'out'));
    worker = new Miniflare({
      modules: true,
      scriptPath: join(root, 'out/worker.mjs'),
      modulesRoot: join(root, 'out'),
      compatibilityDate: '2025-07-18',
      compatibilityFlags: ['nodejs_compat'],
      outboundService: () => { throw new Error('Live calls forbidden'); },
    });
    const response = await worker.dispatchFetch('http://proof/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resolved: '/snapshot/src/file.txt',
      contents: 'checkpoint contents',
      basename: 'file.txt',
      equal: true,
    });
  } finally {
    await worker?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
