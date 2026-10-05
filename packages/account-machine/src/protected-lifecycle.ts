import { connect } from 'node:net';
import type { ProtectedTerminalEvent } from '@gitspace/protocol';

export const PROTECTED_LIFECYCLE_SOCKET = 'GITSPACE_PROTECTED_LIFECYCLE_SOCKET';
const MAX_FRAME_BYTES = 256 * 1024;

/** A fresh connection has no cursor and receives only bytes produced after attach. */
export async function* protectedLifecycleLive(path: string, signal: AbortSignal): AsyncGenerator<ProtectedTerminalEvent> {
  if (signal.aborted) return;
  const socket = connect(path);
  socket.setEncoding('utf8');
  const abort = () => socket.destroy();
  signal.addEventListener('abort', abort, { once: true });
  socket.on('connect', () => socket.write('{"op":"live"}\n'));
  let pending = '';
  let completed = false;
  try {
    for await (const bytes of socket) {
      pending += bytes;
      // Bound each frame, not a batch of coalesced socket writes.
      let end: number;
      while ((end = pending.indexOf('\n')) !== -1) {
        if (end > MAX_FRAME_BYTES) throw new Error('Protected terminal stream exceeded its bound');
        const frame = JSON.parse(pending.slice(0, end)) as ProtectedTerminalEvent;
        pending = pending.slice(end + 1);
        if (completed || !['state', 'output', 'complete'].includes(frame.type)) throw new Error('Invalid protected terminal event');
        if (frame.type === 'complete') completed = true;
        yield frame;
      }
      if (pending.length > MAX_FRAME_BYTES) throw new Error('Protected terminal stream exceeded its bound');
    }
    if (!signal.aborted && (!completed || pending.length)) throw new Error('Protected terminal disconnected before completion');
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    socket.destroy();
  }
}

export async function sendProtectedLifecycleInput(path: string, data: string): Promise<void> {
  if (Buffer.byteLength(data) > 16_384) throw new Error('Protected terminal input exceeds its bound');
  const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = connect(path);
    let response = '';
    const finish = (error?: Error) => { socket.destroy(); error ? reject(error) : resolve(); };
    socket.setTimeout(5_000, () => finish(new Error('Protected terminal did not acknowledge input')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ op: 'input', data })}\n`));
    socket.on('data', (bytes) => {
      response += bytes.toString('utf8');
      if (response.length > 1024) return finish(new Error('Invalid protected terminal response'));
      if (!response.includes('\n')) return;
      try {
        const frame = JSON.parse(response.trim()) as { ok?: boolean };
        finish(frame.ok ? undefined : new Error('Protected terminal is not accepting input'));
      } catch { finish(new Error('Invalid protected terminal response')); }
    });
    socket.on('end', () => finish(new Error('Protected terminal closed before acknowledging input')));
  await promise;
}

/** Only wrapper-generated metadata can reach stdout or runner.log. Child bytes stay on the private socket. */
export function protectedLifecycleWrapper(config: {
  socketPath: string;
  spoolPath: string;
  cwd: string;
  deadline: number;
  envNames: string[];
  steps: readonly { id: string; kind: 'check' | 'script'; command: string; content?: string }[];
}): string {
  return `
import { createServer } from 'node:net';
import { openSync, writeSync, closeSync, chmodSync, rmSync } from 'node:fs';
const config = ${JSON.stringify(config)};
// Translate the absolute approval deadline once on runner entry; elapsed waits
// thereafter must not move with wall-clock corrections.
const monotonicDeadline = performance.now() + Math.max(0, config.deadline - Date.now());
const log = openSync(config.spoolPath, 'a');
const emit = text => { writeSync(log, text); writeSync(1, text); };
const peers = new Set();
let child = null, terminal = null, accepting = false, stopped = false;
let drainTerminal = null, activeStep = null;
const steps = config.steps.map(step => ({ id: step.id, status: 'pending', exitCode: null }));
const send = (peer, event) => {
  const frame = JSON.stringify(event) + '\\n';
  // Disconnect rather than retain output for a lagging observer.
  if (peer.writableLength + Buffer.byteLength(frame) > 65536 || !peer.write(frame)) {
    peers.delete(peer); peer.destroy();
  }
};
const broadcast = event => { for (const peer of peers) send(peer, event); };
const state = () => ({ type: 'state', steps });
const output = data => { if (data) broadcast({ type: 'output', data }); };
const echoFlags = process.platform === 'darwin' ? (1 | 2 | 4 | 8 | 16 | 32 | 64) : (8 | 16 | 32 | 64 | 512 | 1024 | 2048);
let cleanupConfirmed = true;
const { promise: attached, resolve: release } = Promise.withResolvers();
const childEnv = Object.fromEntries(config.envNames.map(name => [name, process.env[name] ?? '']));
for (const name of ['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'GITSPACE_PROTECTED_LIFECYCLE_SOCKET']) delete childEnv[name];
const killGroup = () => {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  try { child.kill('SIGKILL'); } catch {}
};
const confirmGroupExit = async () => {
  if (!child) return;
  for (let attempt = 0; attempt < 40; attempt++) {
    const ps = Bun.spawn(['/bin/ps', '-axo', 'pgid=,stat='], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdout: 'pipe', stderr: 'ignore' });
    const rows = await new Response(ps.stdout).text();
    if (await ps.exited !== 0) throw new Error('Cannot verify process group');
    const alive = rows.split('\\n').some(row => {
      const fields = row.trim().split(/\\s+/);
      return Number(fields[0]) === child.pid && !fields[1]?.startsWith('Z');
    });
    if (!alive) return;
    await Bun.sleep(25);
  }
  throw new Error('Process group exit unconfirmed');
};
const stop = () => { stopped = true; accepting = false; release(); killGroup(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', stop);
const server = createServer(socket => {
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  let pending = '', live = false;
  socket.setTimeout(5000, () => { if (!live) socket.destroy(); });
  socket.on('close', () => peers.delete(socket));
  socket.on('data', bytes => {
    if (live) { socket.destroy(); return; }
    pending += bytes;
    if (pending.length > 32768) { socket.destroy(); return; }
    const end = pending.indexOf('\\n');
    if (end < 0) return;
    let frame;
    try { frame = JSON.parse(pending.slice(0, end)); } catch { socket.destroy(); return; }
    pending = '';
    if (frame.op === 'live' && !stopped) {
      live = true;
      socket.setTimeout(0);
      peers.add(socket);
      send(socket, state());
      release();
    } else if (frame.op === 'input' && accepting && terminal && typeof frame.data === 'string' && Buffer.byteLength(frame.data) <= 16384) {
      try {
        // Reassert no-echo for every write, including when a program changed termios.
        terminal.localFlags &= ~echoFlags;
        terminal.write(frame.data);
        socket.end('{"ok":true}\\n');
      } catch { socket.end('{"ok":false}\\n'); }
    } else socket.end('{"ok":false}\\n');
  });
});
let deadlineTimer;
const deadline = () => {
  const remaining = monotonicDeadline - performance.now();
  if (remaining <= 0) stop();
  else deadlineTimer = setTimeout(deadline, Math.min(remaining, 2147483647));
};
let exitCode = 125;
try {
  // An explicit Hub restart must never rerun approved side effects.
  closeSync(openSync(config.socketPath + '.once', 'wx', 0o600));
  const listening = Promise.withResolvers();
  server.once('error', listening.reject);
  server.listen(config.socketPath, listening.resolve);
  await listening.promise;
  chmodSync(config.socketPath, 0o600);
  emit('Protected lifecycle terminal ready.\\n');
  deadline();
  await attached;
  exitCode = stopped ? 124 : 0;
  for (const [index, step] of config.steps.entries()) {
    if (stopped) break;
    const id = Buffer.from(step.id).toString('base64url');
    emit('__GITSPACE_START__' + id + '\\n');
    activeStep = steps[index];
    activeStep.status = 'running';
    broadcast(state());
    const decoder = new TextDecoder();
    const ptyClosed = Promise.withResolvers();
    const terminalOptions = { cols: 120, rows: 32, exit() { ptyClosed.resolve(); }, data(_terminal, bytes) {
      output(decoder.decode(bytes, { stream: true }));
    }};
    drainTerminal = async () => {
      // Inline PTYs release their slave after child exit. EOF, not a timer,
      // proves every final byte has reached the decoder.
      await ptyClosed.promise;
      output(decoder.decode());
    };
    const argv = step.kind === 'script'
      ? ['/bin/bash', '--noprofile', '--norc', '-c', step.content, step.command]
      : ['/bin/sh', '-c', step.command];
    child = Bun.spawn(argv, { cwd: config.cwd, env: childEnv, terminal: terminalOptions });
    terminal = child.terminal;
    // No input is accepted until echo has been disabled; reassert on every write.
    terminal.localFlags &= ~echoFlags;
    accepting = true;
    const code = await child.exited;
    accepting = false;
    // PTY children have their own session/process group. Kill background members
    // before marking the step complete; no unrestricted shell survives the script.
    killGroup();
    await confirmGroupExit();
    await drainTerminal();
    drainTerminal = null;
    terminal.close(); terminal = null; child = null;
    exitCode = stopped ? 124 : code;
    emit('__GITSPACE_END__' + id + ':' + exitCode + '\\n');
    activeStep.status = exitCode === 0 ? 'succeeded' : 'failed';
    activeStep.exitCode = exitCode;
    activeStep = null;
    broadcast(state());
    if (exitCode !== 0) break;
  }
} catch {
  exitCode = 125;
  try { stop(); } catch {}
  emit('Protected lifecycle runner failed; explicit recovery may be required.\\n');
} finally {
  accepting = false; stopped = true;
  clearTimeout(deadlineTimer);
  try {
    killGroup();
    if (child) await child.exited;
    await confirmGroupExit();
    if (drainTerminal && child) await drainTerminal();
  } catch { exitCode = 125; cleanupConfirmed = false; }
  terminal?.close();
  if (activeStep) {
    activeStep.status = 'failed';
    activeStep.exitCode = exitCode;
    broadcast(state());
  }
  if (cleanupConfirmed) emit('__GITSPACE_PROTECTED_CLEAN__\\n');
  broadcast({ type: 'complete', exitCode });
  await Promise.all([...peers].map(async peer => {
    const drained = Promise.withResolvers();
    peer.once('close', drained.resolve);
    peer.end(drained.resolve);
    await drained.promise;
    peer.destroy();
  }));
  server.close();
  rmSync(config.socketPath, { force: true });
  closeSync(log);
}
process.exit(exitCode);
`;
}
