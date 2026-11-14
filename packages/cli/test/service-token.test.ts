import { afterAll, afterEach, beforeAll, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { ed25519 } from '@noble/curves/ed25519.js';
import { credentialProtocolBase64, signCredentialAuthorityGrant, signedControlRequestSchema, verifySignedControlRequest, type SignedControlRequest } from '@gitspace/protocol';

const CLI = join(import.meta.dir, '..', 'src', 'index.ts');
const roots: string[] = [];
const received: Array<{ request: SignedControlRequest; verified: boolean }> = [];
let server: Server<undefined>;
const machineKey = new Uint8Array(32).fill(3);
const machinePublicKey = ed25519.getPublicKey(machineKey);
const machineGrant = signCredentialAuthorityGrant({ version: 1, userId: 'u-test', machineId: 'm-test', signingPublicKey: credentialProtocolBase64.encode(machinePublicKey), exchangePublicKey: credentialProtocolBase64.encode(machinePublicKey), capabilities: ['space.control'], generation: 1 }, new Uint8Array(32).fill(9));
const GRANT = {
  service: 'api', port: 'http', url: 'https://api--workspace-a--test-srv.gssh.dev', subject: 'ios-dev', header: 'GitSpace-Ingress', token: 'header.payload.signature',
  expiresAt: '2026-11-13T20:30:00.000Z', refreshToken: 'refresh-1', refreshExpiresAt: '2026-11-20T20:00:00.000Z', refreshUrl: 'https://api--workspace-a--test-srv.gssh.dev/__gitspace/token',
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/control') return new Response('ok');
      const signed = signedControlRequestSchema.parse(await request.json());
      const verified = verifySignedControlRequest(signed, machinePublicKey);
      received.push({ request: signed, verified });
      if (!verified) return Response.json({ status: 'error', error: { code: 'Unauthorized', message: 'bad signature' } }, { status: 401 });
      return Response.json({ status: 'ok', value: GRANT });
    },
  });
});
afterAll(() => server.stop(true));
afterEach(async () => {
  received.splice(0);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function configRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-cli-token-'));
  roots.push(root);
  const origin = `http://127.0.0.1:${server.port}`;
  await writeFile(join(root, 'config.json'), JSON.stringify({
    version: 4, apiUrl: origin, accountUrl: origin, handle: 'tester', userId: 'u-test', relayUrl: origin, rootPublicKey: 'root',
    machine: { id: 'm-test', label: 'Test machine', signingPrivateKey: Buffer.from(machineKey).toString('base64'), exchangePrivateKey: Buffer.alloc(32, 4).toString('base64'), grant: machineGrant },
  }));
  return root;
}

async function run(root: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, GITSPACE_CONFIG_HOME: root, GITSPACE_PROJECT_ID: 'project-a', GITSPACE_WORKSPACE_ID: 'workspace-a' },
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

it('mints a service token for the workspace in its environment with a signed control request and prints the grant', async () => {
  const result = await run(await configRoot(), ['service', 'token', 'api', '--sub', 'ios-dev', '--ttl', '30m', '--refresh']);
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  expect(received).toHaveLength(1);
  expect(received[0]?.verified).toBe(true);
  expect(received[0]?.request).toMatchObject({ userId: 'u-test', machineId: 'm-test', operation: 'project.services.token' });
  expect(received[0]?.request.payload).toEqual({ projectId: 'project-a', workspaceId: 'workspace-a', request: { service: 'api', subject: 'ios-dev', ttlSeconds: 1800, refresh: true } });
  expect(JSON.parse(result.stdout)).toEqual(GRANT);
});

it('refuses a lifetime over 8 hours before sending any request', async () => {
  const result = await run(await configRoot(), ['service', 'token', 'api', '--sub', 'ios-dev', '--ttl', '9h']);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('--ttl must be a duration from 60s to 8h');
  expect(received).toHaveLength(0);
});
