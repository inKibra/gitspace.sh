import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashArtifactPath } from '@gitspace/deployment';
import { ReplacementEnvironment, environmentLaunchResponseSchema, environmentStatusSchema } from '../src/index.js';

const roots: string[] = [];
const environments: ReplacementEnvironment[] = [];
afterEach(async () => {
  for (const environment of environments.splice(0)) await environment.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('replacement environment host routes', () => {
  it('swaps a frontend release through /__environment/launch and reports it in /__environment/status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-environment-'));
    roots.push(root);
    const environment = new ReplacementEnvironment({
      id: 'test-environment',
      root,
      repositoryRoot: root,
      rpcPort: 0,
      webPort: 0,
      machineId: 'machine-a',
      artifactKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      ompAgentDir: join(root, 'omp'),
      controlToken: 'control-token',
    });
    environments.push(environment);
    const candidate = join(root, 'candidates', 'frontend-rel-1');
    await mkdir(join(candidate, 'assets'), { recursive: true });
    await writeFile(join(candidate, 'index.html'), '<html>release 1</html>');
    await writeFile(join(candidate, 'assets', 'app.js'), 'console.log(1)');
    const hash = await hashArtifactPath(candidate);

    const unauthorized = await fetch(`${environment.hostUrl}/__environment/status`);
    expect(unauthorized.status).toBe(401);
    const before = environmentStatusSchema.parse(await (await fetch(`${environment.hostUrl}/__environment/status`, { headers: { authorization: 'Bearer control-token' } })).json());
    expect(before).toEqual({ machineHash: null, frontendHash: null, releaseSha: null, lastLaunch: null });

    const launched = await fetch(`${environment.hostUrl}/__environment/launch`, {
      method: 'POST',
      headers: { authorization: 'Bearer control-token', 'content-type': 'application/json' },
      body: JSON.stringify({ entrypoint: 'frontend', path: candidate, hash, sha: 'rel-1' }),
    });
    expect(launched.status).toBe(200);
    expect(environmentLaunchResponseSchema.parse(await launched.json())).toEqual({ status: 'applied', hash, error: null });
    const after = environmentStatusSchema.parse(await (await fetch(`${environment.hostUrl}/__environment/status`, { headers: { authorization: 'Bearer control-token' } })).json());
    expect(after).toEqual({ machineHash: null, frontendHash: hash, releaseSha: null, lastLaunch: { sha: 'rel-1', entrypoint: 'frontend', status: 'applied', error: null } });
    expect(await (await fetch(`${environment.hostUrl}/index.html`)).text()).toBe('<html>release 1</html>');

    // A tampered artifact fails verification at stage; the engine reports the failure instead of throwing.
    await writeFile(join(candidate, 'index.html'), '<html>tampered</html>');
    const tampered = await fetch(`${environment.hostUrl}/__environment/launch`, {
      method: 'POST',
      headers: { authorization: 'Bearer control-token', 'content-type': 'application/json' },
      body: JSON.stringify({ entrypoint: 'frontend', path: candidate, hash: `sha256:${'f'.repeat(64)}`, sha: 'rel-2' }),
    });
    expect(tampered.status).toBe(409);
    const failure = environmentLaunchResponseSchema.parse(await tampered.json());
    expect(failure.status).toBe('failed');
    expect(failure.error).toContain('hash mismatch');
    const final = environmentStatusSchema.parse(await (await fetch(`${environment.hostUrl}/__environment/status`, { headers: { authorization: 'Bearer control-token' } })).json());
    expect(final.frontendHash).toBe(hash);
    expect(final.lastLaunch).toMatchObject({ sha: 'rel-2', entrypoint: 'frontend', status: 'failed' });
    expect(await (await fetch(`${environment.hostUrl}/index.html`)).text()).toBe('<html>release 1</html>');
  });
});
