import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { deriveIdentityId } from '../../lib/tmux-lite/crypto/identity';
import { getTmuxLitePathsForSandbox, removeTmuxLiteSandbox } from '../../lib/tmux-lite/protocol.js';

interface DevIdentityOutput {
  userRootStored: {
    version: 2;
    mnemonic: string;
    createdAt: number;
  };
  keypairStorage: Record<string, unknown>;
  browserIdentity: {
    identity: Record<string, unknown>;
    deviceCert: string;
  };
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForProcessResult(
  subprocess: Bun.Subprocess,
  timeoutMs = 10_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const timeout = setTimeout(() => {
    try {
      subprocess.kill('SIGKILL');
    } catch {
      // already exited
    }
  }, timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout as ReadableStream<Uint8Array>).text(),
      new Response(subprocess.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

async function generateSandboxIdentity(cwd: string): Promise<DevIdentityOutput> {
  const subprocess = Bun.spawn({
    cmd: ['bun', 'scripts/dev-identity.ts'],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const result = await waitForProcessResult(subprocess);
  if (result.exitCode !== 0) {
    throw new Error(`dev-identity generator failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as DevIdentityOutput;
}

function seedSandboxFiles(testHome: string, identityOutput: DevIdentityOutput): {
  identityDir: string;
  controlDir: string;
  serveDir: string;
  secretsPath: string;
} {
  const identityDir = join(testHome, '.identity');
  const controlDir = join(testHome, '.relay', 'control');
  const serveDir = join(testHome, '.serve');
  const secretsPath = join(testHome, 'test-secrets.json');

  mkdirSync(identityDir, { recursive: true });
  mkdirSync(controlDir, { recursive: true });
  mkdirSync(serveDir, { recursive: true });

  writeFileSync(join(identityDir, 'keypair.json'), JSON.stringify(identityOutput.keypairStorage, null, 2), { mode: 0o600 });

  const unifiedBlob = {
    global: { USER_ROOT_IDENTITY: JSON.stringify(identityOutput.userRootStored) },
    projects: {},
    metadata: { schemaVersion: 2, legacyMigrationComplete: true, legacyEntriesRetained: false },
  };
  writeFileSync(
    secretsPath,
    JSON.stringify({ entries: { 'com.gitspace:secrets': JSON.stringify(unifiedBlob) } }),
    { mode: 0o600 },
  );

  return { identityDir, controlDir, serveDir, secretsPath };
}

function startCapture(stream: ReadableStream<Uint8Array> | null, onText: (chunk: string) => void): Promise<void> {
  if (!stream) {
    return Promise.resolve();
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  return (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) onText(tail);
        return;
      }
      onText(decoder.decode(value, { stream: true }));
    }
  })();
}

async function waitForMatch(getText: () => string, pattern: RegExp, timeoutMs: number): Promise<RegExpExecArray> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = pattern.exec(getText());
    if (match) {
      return match;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for output matching ${pattern}`);
}

async function stopProcess(subprocess: Bun.Subprocess, timeoutMs = 15_000): Promise<number> {
  try {
    subprocess.kill('SIGTERM');
  } catch {
    return await subprocess.exited;
  }

  const result = await Promise.race([
    subprocess.exited,
    Bun.sleep(timeoutMs).then(() => null),
  ]);
  if (result !== null) {
    return result;
  }

  subprocess.kill('SIGKILL');
  return await subprocess.exited;
}

describe('gssh web integration', () => {
  test('starts local stack, registers one-time browser enrollment, and cleans up owned services', async () => {
    const repoRoot = process.cwd();
    const testDir = mkdtempSync(join(tmpdir(), 'gssh-web-integration-'));
    const testHome = join(testDir, 'gitspace-home');
    mkdirSync(testHome, { recursive: true });

    const sandboxName = `web-test-${Date.now()}`;
    const relayStatePath = join(testHome, 'gitspace', '.relay', 'runtime', 'relay-state.json');
    let subprocess: Bun.Subprocess | null = null;

    try {
      const identityOutput = await generateSandboxIdentity(repoRoot);
      const { identityDir, controlDir, secretsPath } = seedSandboxFiles(testHome, identityOutput);
      const port = await findFreePort();

      const env = {
        ...process.env,
        HOME: testHome,
        GITSPACE_IDENTITY_DIR: identityDir,
        GITSPACE_CONTROL_DIR: controlDir,
        GSSH_ENABLE_TEST_SECRETS_BACKEND: '1',
        GSSH_TEST_RUNTIME: '1',
        GSSH_TEST_SECRETS_FILE: secretsPath,
        TMUX_LITE_SANDBOX: sandboxName,
        BROWSER: 'definitely-not-a-browser',
      } as Record<string, string>;

      subprocess = Bun.spawn({
        cmd: ['bun', 'src/index.ts', 'web', '--port', String(port), '--yes', '--password-stdin'],
        cwd: repoRoot,
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stdin = subprocess.stdin as import('bun').FileSink;
      stdin.write('dev\n');
      stdin.end();
      let stdout = '';
      let stderr = '';
      const captureStdout = startCapture(subprocess.stdout as ReadableStream<Uint8Array> | null, (chunk) => {
        stdout += chunk;
      });
      const captureStderr = startCapture(subprocess.stderr as ReadableStream<Uint8Array> | null, (chunk) => {
        stderr += chunk;
      });

      const urlMatch = await waitForMatch(
        () => `${stdout}\n${stderr}`,
        /Local web UI:\s+(http:\/\/127\.0\.0\.1:(\d+)\/\?enroll=([^\s]+))/,
        120_000,
      );
      const webUrl = urlMatch[1]!;
      const reportedPort = Number(urlMatch[2]!);
      const token = urlMatch[3]!;

      expect(reportedPort).toBe(port);
      expect(webUrl).toContain(`127.0.0.1:${port}`);

      const first = await fetch(`http://127.0.0.1:${port}/__enroll?token=${token}`);
      expect(first.status).toBe(200);
      const payload = await first.json() as {
        identity: { id: string; signingPublicKey: string; keyExchangePublicKey: string };
        deviceCert: string;
      };
      expect(typeof payload.identity.id).toBe('string');
      expect(payload.identity.id.length).toBeGreaterThan(0);
      // Verify identity ID is derived from signing public key
      const expectedId = deriveIdentityId(new Uint8Array(Buffer.from(payload.identity.signingPublicKey, 'base64')));
      expect(payload.identity.id).toBe(expectedId);
      const cert = JSON.parse(payload.deviceCert) as {
        deviceSigningPublicKey: string;
        deviceKeyExchangePublicKey: string;
      };
      expect(cert.deviceSigningPublicKey).toBe(payload.identity.signingPublicKey);
      expect(cert.deviceKeyExchangePublicKey).toBe(payload.identity.keyExchangePublicKey);
      const second = await fetch(`http://127.0.0.1:${port}/__enroll?token=${token}`);
      expect(second.status).toBe(404);

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);

      const exitCode = await stopProcess(subprocess);
      await Promise.all([captureStdout, captureStderr]);
      expect(exitCode).toBe(0);

      // serve.pid is gone: serve is a mode of the machine daemon, not a process
      // with its own pid file, so there is nothing to assert cleanup of.
      expect(existsSync(relayStatePath)).toBe(false);

      const combinedOutput = `${stdout}\n${stderr}`;
      expect(combinedOutput).toContain(`Local web UI: http://127.0.0.1:${port}/?enroll=`);
    } finally {
      if (subprocess) {
        await stopProcess(subprocess).catch(() => {});
      }
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
      // Kill any daemon the sandbox left behind, then drop all four sandbox
      // paths through the shared helper. Hand-rolling the path strings here
      // covered only .pid/.sock and leaked a /tmp/tmux-lite-<sandbox>/ tree
      // every run — and sandboxName is unique per run, so it never overwrote.
      const tmuxPaths = getTmuxLitePathsForSandbox(sandboxName);
      if (existsSync(tmuxPaths.pidFile)) {
        try {
          const pid = Number.parseInt(readFileSync(tmuxPaths.pidFile, 'utf-8').trim(), 10);
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 'SIGKILL'); } catch {}
          }
        } catch {
          // best effort cleanup only
        }
      }
      removeTmuxLiteSandbox(sandboxName);
    }
  }, 180_000);
});
