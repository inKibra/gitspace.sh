import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
