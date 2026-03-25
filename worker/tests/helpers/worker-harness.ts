import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Miniflare } from 'miniflare';
import { ed25519 } from '@noble/curves/ed25519.js';
import { startMockUpstream, type MockUpstream } from './mock-upstream';

const WORKER_DIR = dirname(dirname(import.meta.dir));
const SRC_ENTRY = join(WORKER_DIR, 'src', 'index.ts');
const SCHEMA_PATH = join(WORKER_DIR, 'schema.sql');

let bundlePathPromise: Promise<string> | null = null;

async function applySchema(db: any): Promise<void> {
  const sql = readFileSync(SCHEMA_PATH, 'utf8');
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

async function buildWorkerBundle(): Promise<string> {
  if (!bundlePathPromise) {
    bundlePathPromise = (async () => {
      const outdir = join(WORKER_DIR, '.mf-build');
      rmSync(outdir, { recursive: true, force: true });
      mkdirSync(outdir, { recursive: true });
      const result = await Bun.build({
        entrypoints: [SRC_ENTRY],
        outdir,
        target: 'browser',
        format: 'esm',
        naming: 'index.js',
        minify: false,
        sourcemap: 'none',
      });

      if (!result.success) {
        throw new Error(`Worker build failed: ${result.logs.map((log) => log.message).join('; ')}`);
      }

      return join(outdir, 'index.js');
    })();
  }

  return bundlePathPromise;
}

export interface WorkerHarness {
  mf: Miniflare;
  upstream: MockUpstream;
  dispose: () => Promise<void>;
  request: (path: string, init?: RequestInit) => Promise<any>;
  createDeviceSession: (options?: {
    githubToken?: string;
    githubUser?: { id: number; login: string; name: string; email: string; avatar_url: string };
  }) => Promise<{ token: string; fingerprint: string; headers: Record<string, string> }>;
}

export async function createWorkerHarness(): Promise<WorkerHarness> {
  const upstream = startMockUpstream();
  const bundlePath = await buildWorkerBundle();
  const persistDir = mkdtempSync(join(tmpdir(), 'gitspace-worker-mf-'));

  const mf = new Miniflare({
    scriptPath: bundlePath,
    modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2024-12-01',
    cf: false,
    d1Databases: { DB: crypto.randomUUID() },
    bindings: {
      PORTAL_URL: 'https://gitspace.sh',
      MAX_ACCOUNTS: '99',
      GITHUB_CLIENT_ID: 'github-client-id',
      GITHUB_CLIENT_SECRET: 'github-client-secret',
      CF_API_TOKEN: 'cf-api-token',
      CF_ACCOUNT_ID: 'cf-account-id',
      CF_ZONE_ID: 'cf-zone-id',
      ENCRYPTION_KEY: 'worker-test-encryption-key',
      GITHUB_OAUTH_BASE: upstream.githubOauthBase,
      GITHUB_API_BASE: upstream.githubApiBase,
      CF_API_BASE: upstream.cloudflareApiBase,
    },
    cachePersist: false,
    kvPersist: false,
    durableObjectsPersist: false,
    d1Persist: persistDir,
  });

  const db = await mf.getD1Database('DB');
  await applySchema(db);

  return {
    mf,
    upstream,
    request: (path, init) => mf.dispatchFetch(`http://worker${path}`, init as any),
    createDeviceSession: async (options = {}) => {
      const githubToken = options.githubToken ?? 'github-access-token';
      if (options.githubUser) {
        upstream.registerGitHubUser(githubToken, options.githubUser);
      }

      const privateKey = ed25519.utils.randomSecretKey();
      const publicKey = ed25519.getPublicKey(privateKey);
      const timestamp = Date.now();
      const signature = ed25519.sign(
        new TextEncoder().encode(`gitspace-device-auth:${timestamp}`),
        privateKey,
      );

      const response = await mf.dispatchFetch('http://worker/auth/github/device', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          github_token: githubToken,
          machine_pubkey: Buffer.from(publicKey).toString('base64'),
          device_name: 'Worker Test Device',
          auth_timestamp: timestamp,
          auth_signature: Buffer.from(signature).toString('base64'),
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to create device session: ${await response.text()}`);
      }

      const payload = await response.json() as { token: string };
      const fingerprint = Buffer.from(publicKey).toString('base64');
      return {
        token: payload.token,
        fingerprint,
        headers: {
          Authorization: `Bearer ${payload.token}`,
          'X-Device-Fingerprint': fingerprint,
        },
      };
    },
    dispose: async () => {
      upstream.close();
      await mf.dispose();
      rmSync(persistDir, { recursive: true, force: true });
    },
  };
}
