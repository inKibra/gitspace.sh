#!/usr/bin/env bun
/**
 * Full-stack web development server.
 *
 * Starts relay + machine serve + Vite dev server with a stable relay port
 * preference plus sandboxed state directories. Each worktree gets isolated state
 * so multiple dev environments can run side by side.
 *
 * Usage:
 *   bun scripts/dev.ts
 *   bun run dev:web
 */

import { spawn, type Subprocess } from 'bun';
import { join, basename } from 'path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { createServer, type AddressInfo } from 'net';
import { tmpdir } from 'os';

const ROOT = join(import.meta.dir, '..');
const ENTRY = join(ROOT, 'src/index.ts');
const WEB_DIR = join(ROOT, 'web');

// ─── Colors ──────────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const COLORS = {
  relay: '\x1b[36m',   // cyan
  serve: '\x1b[33m',   // yellow
  web:   '\x1b[35m',   // magenta
  dev:   '\x1b[32m',   // green
};

function prefix(label: keyof typeof COLORS): string {
  return `${COLORS[label]}${BOLD}[${label}]${RESET} `;
}

function log(label: keyof typeof COLORS, msg: string): void {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  process.stdout.write(`${DIM}${ts}${RESET} ${prefix(label)}${msg}\n`);
}

// ─── Port allocation ─────────────────────────────────────────────────────────

const DEFAULT_DEV_RELAY_PORT = 4480;
const DEFAULT_DEV_WEB_PORT = 5173;
function findFreePort(preferredPort?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onError = (error: Error & { code?: string }) => {
      server.close();
      if (preferredPort && error.code === 'EADDRINUSE') {
        resolve(findFreePort(preferredPort + 1));
        return;
      }
      reject(error);
    };

    server.once('error', onError);
    server.listen(preferredPort ?? 0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const socket = await Bun.connect({
        hostname: '127.0.0.1',
        port,
        socket: {
          data() {},
          open(socket) { socket.end(); },
          error() {},
          close() {},
        },
      });
      socket.end();
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

// ─── Sandbox ─────────────────────────────────────────────────────────────────

function deriveSandboxName(): string {
  // Use the worktree directory name as a stable, human-readable sandbox key
  const worktreeName = basename(ROOT);
  // Sanitize to alphanumeric + dash/underscore (TMUX_LITE_SANDBOX requirement)
  return worktreeName.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+/, 'dev-');
}

// ─── Process management ──────────────────────────────────────────────────────

const children: Subprocess[] = [];
let shuttingDown = false;

function pipeOutput(proc: Subprocess, label: keyof typeof COLORS): void {
  const pfx = prefix(label);
  if (proc.stdout) {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) {
          if (line.trim()) process.stdout.write(`${pfx}${line}\n`);
        }
      }
      if (buffer.trim()) process.stdout.write(`${pfx}${buffer}\n`);
    })();
  }
  if (proc.stderr) {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) {
          if (line.trim()) process.stderr.write(`${pfx}${line}\n`);
        }
      }
      if (buffer.trim()) process.stderr.write(`${pfx}${buffer}\n`);
    })();
  }
}

function spawnChild(
  label: keyof typeof COLORS,
  cmd: string[],
  env: Record<string, string> = {},
  cwd?: string,
  options?: { stdin?: 'inherit' | 'ignore' | 'pipe' },
): Subprocess {
  const proc = spawn(cmd, {
    cwd: cwd ?? ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: options?.stdin ?? 'ignore',
  });
  children.push(proc);
  pipeOutput(proc, label);

  // Monitor for unexpected exit
  proc.exited.then((code) => {
    if (!shuttingDown && code !== 0) {
      log(label, `Process exited with code ${code}`);
      shutdown(1);
    }
  });

  return proc;
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('dev', 'Shutting down...');

  // Kill in reverse order: vite -> serve -> relay
  for (const child of [...children].reverse()) {
    try {
      child.kill('SIGTERM');
      // Give each process 3s to exit gracefully
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
      await child.exited;
      clearTimeout(timeout);
    } catch {
      // Already dead
    }
  }

  // Kill the tmux-lite server — it's a grandchild process spawned by serve
  // that survives after serve exits because it's not in the same process group.
  try {
    const sandboxName = deriveSandboxName();
    const pidFile = `/tmp/tmux-lite-${sandboxName}.pid`;
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid && !isNaN(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
          log('dev', `Sent SIGTERM to tmux-lite server (pid ${pid})`);
          // Give it a moment to shut down cleanly
          await Bun.sleep(500);
          try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
        } catch {
          // Already dead
        }
      }
      try { unlinkSync(pidFile); } catch {}
    }
    // Clean up sandbox socket file
    const socketFile = `/tmp/tmux-lite-${sandboxName}.sock`;
    try { unlinkSync(socketFile); } catch {}
  } catch {
    // Best-effort cleanup
  }

  process.exit(exitCode);
}

// ─── Main ────────────────────────────────────────────────────────────────────

// ─── Main ────────────────────────────────────────────────────────────────────

const DEV_PASSWORD = 'dev';

async function main(): Promise<void> {
  const sandboxName = deriveSandboxName();
  const [relayPort, vitePort] = await Promise.all([
    findFreePort(DEFAULT_DEV_RELAY_PORT),
    findFreePort(DEFAULT_DEV_WEB_PORT),
  ]);

  // Wipe and recreate sandbox directory tree (each run gets a fresh state)
  const sandboxDir = join(tmpdir(), `gssh-dev-${sandboxName}`);
  rmSync(sandboxDir, { recursive: true, force: true });
  const identityDir = join(sandboxDir, 'identity');
  const controlDir = join(sandboxDir, 'relay-control');
  const serveDaemonDir = join(sandboxDir, 'serve');
  for (const dir of [identityDir, controlDir, serveDaemonDir]) {
    mkdirSync(dir, { recursive: true });
  }

  log('dev', `Sandbox: ${sandboxName}`);
  log('dev', `Relay port: ${relayPort}`);
  log('dev', `Vite port: ${vitePort}`);
  log('dev', '');

  // Generate a self-contained sandbox identity (root + browser device).
  // No user password needed — everything is freshly generated.
  log('dev', 'Generating sandbox identity...');
  const identityScript = join(import.meta.dir, 'dev-identity.ts');
  const genProc = spawn(['bun', identityScript], {
    cwd: ROOT,
    env: process.env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const genExit = await genProc.exited;
  if (genExit !== 0) {
    const stderr = await new Response(genProc.stderr).text();
    log('dev', `Failed to generate identity: ${stderr.trim()}`);
    await shutdown(1);
    return;
  }
  const genOutput = JSON.parse(await new Response(genProc.stdout).text());

  // Write root keypair.json so serve can load the device identity
  const keypairPath = join(identityDir, 'keypair.json');
  writeFileSync(keypairPath, JSON.stringify(genOutput.keypairStorage, null, 2), { mode: 0o600 });

  // Seed test secrets file with user root identity (bypasses system keychain)
  const secretsPath = join(sandboxDir, 'secrets.json');
  const unifiedBlob = {
    global: { USER_ROOT_IDENTITY: JSON.stringify(genOutput.userRootStored) },
    projects: {},
    metadata: { schemaVersion: 2, legacyMigrationComplete: true, legacyEntriesRetained: false },
  };
  writeFileSync(secretsPath, JSON.stringify({
    entries: { 'com.gitspace:secrets': JSON.stringify(unifiedBlob) },
  }), { mode: 0o600 });

  // Write browser identity for the Vite dev endpoint
  const devIdentityPath = join(sandboxDir, 'dev-browser-identity.json');
  writeFileSync(devIdentityPath, JSON.stringify(genOutput.browserIdentity));
  log('dev', 'Sandbox identity generated');
  log('dev', '');

  // Shared env for relay + serve: sandbox identity + test secrets file.
  // Workspace scanning stays on the real ~/gitspace tree so dev reflects the
  // same project/workspace metadata as the TUI.
  const sandboxEnv = {
    GITSPACE_IDENTITY_DIR: identityDir,
    GSSH_TEST_RUNTIME: '1',
    GSSH_ENABLE_TEST_SECRETS_BACKEND: '1',
    GSSH_TEST_SECRETS_FILE: secretsPath,
  };

  // Phase 1: Start relay
  log('dev', 'Starting relay...');
  spawnChild('relay', ['bun', ENTRY, 'relay', 'start', '--port', String(relayPort)], {
    ...sandboxEnv,
    GITSPACE_CONTROL_DIR: controlDir,
  });

  try {
    await waitForPort(relayPort);
  } catch {
    log('dev', `Relay failed to start on port ${relayPort}`);
    await shutdown(1);
    return;
  }
  log('dev', 'Relay ready');

  // Phase 2: Start serve with the dev password piped via stdin
  const relayUrl = `ws://127.0.0.1:${relayPort}/ws`;
  log('dev', 'Starting serve...');
  const serveProc = spawnChild('serve',
    ['bun', ENTRY, 'machine', 'serve', 'start', '--foreground', '--relay', relayUrl, '--password-stdin'],
    { ...sandboxEnv, GITSPACE_CONTROL_DIR: controlDir, TMUX_LITE_SANDBOX: sandboxName, GITSPACE_SERVE_DAEMON_DIR: serveDaemonDir },
    undefined,
    { stdin: 'pipe' },
  );
  serveProc.stdin.write(DEV_PASSWORD + '\n');
  serveProc.stdin.end();

  // Give serve a moment to initialize
  await Bun.sleep(2000);
  log('dev', 'Serve started');

  // Phase 3: Start Vite dev server with enrollment token
  const enrollToken = crypto.randomUUID();
  log('dev', 'Starting Vite...');
  spawnChild('web', ['bunx', 'vite', '--port', String(vitePort), '--host'], {
    RELAY_PORT: String(relayPort),
    DEV_IDENTITY_PATH: devIdentityPath,
    DEV_ENROLL_TOKEN: enrollToken,
  }, WEB_DIR);

  try {
    await waitForPort(vitePort);
  } catch {
    log('dev', `Vite failed to start on port ${vitePort}`);
    await shutdown(1);
    return;
  }

  log('dev', '');
  log('dev', `${BOLD}Ready!${RESET}`);
  log('dev', '');
  log('dev', `  ${BOLD}Open:${RESET}  http://localhost:${vitePort}?enroll=${enrollToken}`);
  log('dev', '');
  log('dev', `  Relay:   ws://127.0.0.1:${relayPort}/ws`);
  log('dev', `  Sandbox: ${sandboxDir}`);
  log('dev', '');
  log('dev', `${DIM}The enrollment link auto-authenticates the browser.${RESET}`);
  log('dev', `${DIM}Press Ctrl+C to stop all services${RESET}`);

}

// Signal handling
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((err) => {
  console.error('Dev script failed:', err);
  shutdown(1);
});