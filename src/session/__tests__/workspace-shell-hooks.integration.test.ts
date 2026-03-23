import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { send } from '../../lib/tmux-lite/cli.js';
import { decodeControl, encodeControl, encodePTY, FrameType, parseFrames } from '../../lib/tmux-lite/protocol.js';
import { buildWorkspaceSessionHooks } from '../workspace-shell-hooks.js';

type EnvSnapshot = {
  TMUX_LITE_SOCKET?: string;
  TMUX_LITE_SESSION_DIR?: string;
  TMUX_LITE_PID_FILE?: string;
  SHELL?: string;
  PATH?: string;
};

function setOptionalEnvVar(key: keyof EnvSnapshot, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function captureEnv(): EnvSnapshot {
  return {
    TMUX_LITE_SOCKET: process.env.TMUX_LITE_SOCKET,
    TMUX_LITE_SESSION_DIR: process.env.TMUX_LITE_SESSION_DIR,
    TMUX_LITE_PID_FILE: process.env.TMUX_LITE_PID_FILE,
    SHELL: process.env.SHELL,
    PATH: process.env.PATH,
  };
}

function restoreEnv(env: EnvSnapshot): void {
  setOptionalEnvVar('TMUX_LITE_SOCKET', env.TMUX_LITE_SOCKET);
  setOptionalEnvVar('TMUX_LITE_SESSION_DIR', env.TMUX_LITE_SESSION_DIR);
  setOptionalEnvVar('TMUX_LITE_PID_FILE', env.TMUX_LITE_PID_FILE);
  setOptionalEnvVar('SHELL', env.SHELL);
  setOptionalEnvVar('PATH', env.PATH);
}

async function runCommandInSession(socketPath: string, command: string): Promise<string> {
  return new Promise(async (resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let output = '';
    let commandSent = false;
    let settled = false;
    let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;

    const finish = (value: { output?: string; error?: Error }) => {
      if (settled) return;
      settled = true;
      timeout.unref?.();
      if (value.error) {
        socket?.end();
        reject(value.error);
        return;
      }
      resolve(value.output ?? output);
    };

    const timeout = setTimeout(() => {
      finish({ error: new Error('Timed out waiting for workspace session output') });
    }, 10000);

    try {
      socket = await Bun.connect({
        unix: socketPath,
        socket: {
          data(_socket, data) {
            let incoming = Buffer.from(data);
            if (buffer.length > 0) {
              incoming = Buffer.concat([buffer, incoming]);
            }

            let parsed;
            try {
              parsed = parseFrames(incoming);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              finish({ error: new Error(`Failed to parse framed PTY data: ${message}`) });
              return;
            }

            buffer = Buffer.from(parsed.remaining);

            for (const frame of parsed.frames) {
              if (frame.type === FrameType.PTY) {
                output += frame.payload.toString('utf8');
                continue;
              }

              if (frame.type !== FrameType.CONTROL) {
                continue;
              }

              const event = decodeControl(frame.payload) as { type?: string; code?: number };
              if (event.type === 'attached' && !commandSent) {
                commandSent = true;
                socket?.write(encodePTY(Buffer.from(command, 'utf8')));
              }

              if (event.type === 'exited') {
                finish({ output });
                return;
              }
            }
          },
          error(_socket, err) {
            finish({ error: err });
          },
          close() {
            if (!settled) {
              finish({ error: new Error('Session socket closed before exit event') });
            }
          },
        },
      });

      socket.write(encodeControl({ type: 'attach-init', cols: 120, rows: 40, clientType: 'cli' }));
      socket.write(encodeControl({ type: 'resize', cols: 120, rows: 40 }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish({ error: new Error(`Failed to connect to session socket: ${message}`) });
    }
  });
}

async function waitForServerReady(routerSocket: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(routerSocket)) {
      try {
        const response = await send({ type: 'list' });
        if (response.type === 'sessions') {
          return;
        }
      } catch {
        // Socket might exist before server accepts commands.
      }
    }
    await Bun.sleep(100);
  }

  throw new Error('Timed out waiting for tmux-lite server startup');
}

async function readProcessStream(
  stream: number | ReadableStream<Uint8Array<ArrayBuffer>> | undefined
): Promise<string> {
  if (!stream || typeof stream === 'number') {
    return '';
  }
  return new Response(stream).text();
}

describe('workspace shell hooks integration', () => {
  let envSnapshot: EnvSnapshot;
  let tempRoot: string;
  let serverProcess: Bun.Subprocess | null = null;
  let fakeGsshPath: string;

  beforeEach(() => {
    envSnapshot = captureEnv();
    tempRoot = mkdtempSync('/tmp/tl-hooks-');

    const sessionDir = join(tempRoot, 'sessions');
    const binDir = join(tempRoot, 'bin');
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    fakeGsshPath = join(binDir, 'fake-gssh');
    writeFileSync(
      fakeGsshPath,
      '#!/bin/sh\nprintf "__GSSH_ENV_PROJECT__%s\\n" "$GSSH_SPACE_PROJECT"\nprintf "__GSSH_ENV_WORKSPACE__%s\\n" "$GSSH_SPACE_WORKSPACE"\nfor arg in "$@"; do\n  printf "__GSSH_ARGV__%s\\n" "$arg"\ndone\n'
    );
    chmodSync(fakeGsshPath, 0o755);

    process.env.TMUX_LITE_SOCKET = join(tempRoot, 'router.sock');
    process.env.TMUX_LITE_SESSION_DIR = sessionDir;
    process.env.TMUX_LITE_PID_FILE = join(tempRoot, 'tmux-lite.pid');
    process.env.SHELL = '/bin/bash';
    const basePath = envSnapshot.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
    process.env.PATH = `${binDir}:${basePath}`;

    const serverScript = join(import.meta.dir, '../../lib/tmux-lite/server.ts');
    serverProcess = Bun.spawn({
      cmd: [process.execPath, 'run', serverScript],
      env: process.env as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  });

  afterEach(async () => {
    if (serverProcess) {
      try {
        await send({ type: 'kill-server' });
      } catch {
        try {
          serverProcess.kill();
        } catch {
          // no-op
        }
      }

      try {
        await serverProcess.exited;
      } catch {
        // no-op
      }
      serverProcess = null;
    }

    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // no-op
    }

    restoreEnv(envSnapshot);
  });

  it('invokes injected space() function with workspace-scoped args', async () => {
    const projectName = "proj with 'quote'";
    const workspaceName = 'feature one';

    try {
      await waitForServerReady(process.env.TMUX_LITE_SOCKET || '');
    } catch (error) {
      const stdout = await readProcessStream(serverProcess?.stdout);
      const stderr = await readProcessStream(serverProcess?.stderr);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\nserver stdout:\n${stdout}\nserver stderr:\n${stderr}`);
    }

    const response = await send({
      type: 'new',
      name: 'workspace-hooks-e2e',
      cwd: process.cwd(),
      hooks: buildWorkspaceSessionHooks(projectName, workspaceName, [fakeGsshPath]),
    });
    if (response.type !== 'session') {
      throw new Error(`Expected session response, got ${response.type}`);
    }
    const session = response.session;

    const output = await runCommandInSession(
      session.socketPath,
      'space review notes --format json; printf "__SPACE_EXIT__%s\\n" "$?"; exit\n'
    );

    const normalized = output.replace(/\r/g, '');
    const argv = normalized
      .split('\n')
      .filter((line) => line.startsWith('__GSSH_ARGV__'))
      .map((line) => line.replace('__GSSH_ARGV__', ''));

    expect(argv).toEqual([
      'space',
      'review',
      'notes',
      '--format',
      'json',
    ]);
    expect(normalized).toContain(`__GSSH_ENV_PROJECT__${projectName}`);
    expect(normalized).toContain(`__GSSH_ENV_WORKSPACE__${workspaceName}`);
    expect(normalized).toContain('__SPACE_EXIT__0');
  });
});
