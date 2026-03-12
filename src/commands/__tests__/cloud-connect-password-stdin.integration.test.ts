import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_PASSWORD = 'correct horse battery staple';

function makeTestEnv(testDir: string): Record<string, string> {
  return {
    ...process.env,
    HOME: testDir,
    GITSPACE_CONTROL_DIR: join(testDir, '.relay', 'control'),
    GSSH_ENABLE_TEST_SECRETS_BACKEND: '1',
    GSSH_TEST_RUNTIME: '1',
    GSSH_TEST_SECRETS_FILE: join(testDir, 'test-secrets.json'),
    TEST_PASSWORD,
  } as Record<string, string>;
}

async function waitForProcess(
  subprocess: any,
  timeoutMs = 10000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const timeout = setTimeout(() => {
    subprocess.kill();
  }, timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

describe('cloud connect password-stdin integration', () => {
  test('cloud connect fails fast when no relay is configured', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'gssh-cloud-connect-missing-relay-'));
    const env = makeTestEnv(testDir);

    try {
      const subprocess = Bun.spawn({
        cmd: [
          'bun',
          '-e',
          [
            "import { ensureControlStore, upsertCloudWorkspace } from './src/relay/control/store.js';",
            "import { cloudConnect } from './src/commands/cloud.js';",
            'ensureControlStore();',
            "upsertCloudWorkspace({ id: 'ws-test', provider: 'sprites', providerWorkspaceId: 'sprite-test', machineId: 'machine-ready', machinePublicKey: 'machine-pub-test', repo: 'owner/repo', branch: 'main', status: 'ready' });",
            "await cloudConnect('ws-test');",
          ].join(' '),
        ],
        cwd: process.cwd(),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const result = await waitForProcess(subprocess);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.exitCode).not.toBe(0);
      expect(output).toContain('No cloud-reachable relay URL is saved');
      expect(output).not.toContain('Connect to this machine?');
    } finally {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });

  test('cloud connect runs non-interactively with --password-stdin', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'gssh-cloud-connect-password-stdin-'));
    const env = makeTestEnv(testDir);

    const relayPublicKey = Buffer.from('integration-relay-public-key').toString('base64');
    const relayServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === '/health') {
          return new Response(
            JSON.stringify({
              relayPublicKey,
              relayLabel: 'integration-relay',
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }

        if (url.pathname === '/ws') {
          if (server.upgrade(request)) {
            return undefined;
          }
          return new Response('upgrade failed', { status: 500 });
        }

        return new Response('not found', { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.close(1011, 'integration test close');
        },
        message() {},
      },
    });

    try {
      const seedState = Bun.spawn({
        cmd: [
          'bun',
          '-e',
          [
            "import { generateAndSaveKeypair } from './src/core/identity.js';",
            "import { initFromMnemonic } from './src/core/user-identity.js';",
            "import { ensureControlStore, upsertCloudWorkspace } from './src/relay/control/store.js';",
            "import { generateMnemonic } from './src/lib/tmux-lite/crypto/user-identity.js';",
            'ensureControlStore();',
            "upsertCloudWorkspace({ id: 'ws-test', provider: 'sprites', providerWorkspaceId: 'sprite-test', machineId: 'machine-ready', machinePublicKey: 'machine-pub-test', repo: 'owner/repo', branch: 'main', status: 'ready' });",
            "await generateAndSaveKeypair(process.env.TEST_PASSWORD ?? '', 'integration-device', true);",
            'await initFromMnemonic(generateMnemonic(), true);',
          ].join(' '),
        ],
        cwd: process.cwd(),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const seedResult = await waitForProcess(seedState);
      expect(seedResult.exitCode).toBe(0);

      const relayUrl = `ws://127.0.0.1:${relayServer.port}/ws`;
      const connectProcess = Bun.spawn({
        cmd: [
          'bun',
          '-e',
          [
            "import { writeRelayConfig } from './src/core/identity.js';",
            "import { cloudConnect } from './src/commands/cloud.js';",
            "import { bindControlRelayIdentity } from './src/relay/control/store.js';",
            `writeRelayConfig({ relayUrl: ${JSON.stringify(relayUrl)}, cloudRelayUrl: ${JSON.stringify(relayUrl)}, machineId: 'machine-ready', savedAt: Date.now() });`,
            `bindControlRelayIdentity({ relayIdentityId: 'relay-integration', relaySigningPublicKey: ${JSON.stringify(relayPublicKey)}, relayFingerprint: 'integration-relay-fingerprint' });`,
            `await cloudConnect('ws-test', { yes: true, passwordStdin: true }, { resolveRelayUrl: () => ${JSON.stringify(relayUrl)}, allowUnsafeRelayUrl: true });`,
          ].join(' '),
        ],
        cwd: process.cwd(),
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      connectProcess.stdin.write(`${TEST_PASSWORD}\n`);
      connectProcess.stdin.end();

      const result = await waitForProcess(connectProcess);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.exitCode).not.toBe(0);
      expect(output).toContain('Connecting to cloud workspace ws-test via machine machine-ready');
      expect(output).toContain('Connecting to relay...');
      expect(output).toContain('Connection failed:');
      expect(output).not.toContain('Connect to this machine?');
      expect(output).not.toContain('Trust this relay?');
      expect(output).not.toContain('Enter password to unlock identity:');
    } finally {
      relayServer.stop(true);
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});
