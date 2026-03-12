import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeTestEnv(testDir: string): Record<string, string> {
  return {
    ...process.env,
    HOME: testDir,
    GITSPACE_CONTROL_DIR: join(testDir, '.relay', 'control'),
    GSSH_ENABLE_TEST_SECRETS_BACKEND: '1',
    GSSH_TEST_RUNTIME: '1',
    GSSH_TEST_SECRETS_FILE: join(testDir, 'test-secrets.json'),
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

describe('cloud connect recovery with password-stdin', () => {
  test('fails before reading device password when root recovery needs an interactive terminal', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'gssh-cloud-connect-recovery-password-stdin-'));
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
            "import { generateAndSaveKeypair, writeRelayConfig } from './src/core/identity.js';",
            "import { ensureControlStore, upsertCloudWorkspace, bindControlRelayIdentity } from './src/relay/control/store.js';",
            "import { setSecret } from './src/utils/secrets.js';",
            'ensureControlStore();',
            "upsertCloudWorkspace({ id: 'ws-test', provider: 'sprites', providerWorkspaceId: 'sprite-test', machineId: 'machine-ready', machinePublicKey: 'machine-pub-test', repo: 'owner/repo', branch: 'main', status: 'ready' });",
            `writeRelayConfig({ relayUrl: ${JSON.stringify(`ws://127.0.0.1:${relayServer.port}/ws`)}, cloudRelayUrl: ${JSON.stringify(`ws://127.0.0.1:${relayServer.port}/ws`)}, machineId: 'machine-ready', savedAt: Date.now() });`,
            `bindControlRelayIdentity({ relayIdentityId: 'relay-integration', relaySigningPublicKey: ${JSON.stringify(relayPublicKey)}, relayFingerprint: 'integration-relay-fingerprint' });`,
            "await setSecret('GITSPACE_TOKEN', 'test-token');",
            "await generateAndSaveKeypair('device-password', 'integration-device', true);",
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
            "import { cloudConnect } from './src/commands/cloud.js';",
            `await cloudConnect('ws-test', { yes: true, passwordStdin: true }, { resolveRelayUrl: () => ${JSON.stringify(relayUrl)}, allowUnsafeRelayUrl: true });`,
          ].join(' '),
        ],
        cwd: process.cwd(),
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const result = await waitForProcess(connectProcess);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.exitCode).not.toBe(0);
      expect(output).toContain('requires an interactive terminal');
      expect(output).not.toContain('Timeout reading password from stdin');
      expect(output).not.toContain('Enter password to unlock identity:');
    } finally {
      relayServer.stop(true);
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});
