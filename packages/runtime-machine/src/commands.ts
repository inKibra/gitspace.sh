import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { daemonClientForProject } from '@gitspace/supervisor';
import type { DaemonBrokerClient, DaemonResponse, DaemonSnapshot } from '@gitspace/supervisor';
import { TOOL_RESULT_MAX_BYTES } from '@gitspace/protocol-runtime';

/** `project` names the supervisor that owns the process (the checkout root); it defaults to `cwd`. */
/** `timeoutMs` is the command's own limit: reaching it stops the process tree and returns the output with exit code 124,
 * where the dispatch deadline or cancellation fails the command. */
export type ExecutorCommand = { application: string; args: string[]; cwd: string; project?: string; attemptId: string; sequence: number; deadlineAt: string; signal: AbortSignal; env?: Record<string, string>; timeoutMs?: number };
export type ExecutorCommandResult = { exitCode: number; output: string };
export type RunExecutorCommand = (command: ExecutorCommand) => Promise<ExecutorCommandResult>;

/** The most of a command's output kept: what a workspace keeps of one tool result, less room for the lines a tool adds
 * (its exit code, a timeout or cut note), so the whole text reaches the workspace's result store. */
export const COMMAND_OUTPUT_MAX_BYTES = TOOL_RESULT_MAX_BYTES - 4096;

/** Machine variables a supervised command may inherit; everything else is explicit. */
export function inheritedCommandEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/** The command's output from its `keepOutput` file, ending with a line naming what was cut when it passed the limit. */
async function keptOutput(client: DaemonBrokerClient, name: string, path: string, daemon: DaemonSnapshot): Promise<string> {
  const kept = daemon.keptOutput;
  if (!kept) {
    // A broker started by an earlier release, kept because it still runs processes, ignores `keepOutput` and holds the
    // last 10,000 lines.
    const logs = await client.request({ op: 'logs', name, lines: 10000, head: false });
    if (logs.op !== 'logs') throw new Error('Supervisor returned an invalid logs response');
    return logs.text;
  }
  const text = await readFile(path, 'utf8');
  if (kept.droppedBytes === 0) return text;
  return `${text}${text.endsWith('\n') || !text ? '' : '\n'}[Output cut: the command wrote ${((kept.bytes + kept.droppedBytes) / 1024 / 1024).toFixed(1)} MB; its first ${(kept.bytes / 1024 / 1024).toFixed(1)} MB is kept and the rest was dropped${daemon.failure ? ` (${daemon.failure})` : ''}]\n`;
}

/** Runs one command under the supervisor; cancellation or the deadline stops its process tree. The process is named by
 * attempt and sequence, so background job control (`bash` `{ op, attemptId }`) can find it. Its whole output, to
 * `COMMAND_OUTPUT_MAX_BYTES`, goes to a file in the supervisor's directory, read once it ends and then removed. */
export const runSupervisorCommand: RunExecutorCommand = async command => {
  const client = await daemonClientForProject(command.project ?? command.cwd);
  const name = `exec-${createHash('sha256').update(`${command.attemptId}:${command.sequence}`).digest('hex').slice(0, 40)}`;
  const deadline = Date.parse(command.deadlineAt);
  const limit = command.timeoutMs === undefined ? deadline : Math.min(deadline, Date.now() + command.timeoutMs);
  const remaining = () => Math.max(1, Math.min(2_147_483_647, limit - Date.now()));
  if (command.signal.aborted || Date.parse(command.deadlineAt) <= Date.now()) throw new Error('Command canceled or deadline expired before launch');
  const outputs = join(client.runtimeDir, 'outputs');
  const path = join(outputs, `${name}.log`);
  await mkdir(outputs, { recursive: true, mode: 0o700 });
  try {
    await client.request({ op: 'start', owner: command.attemptId, spec: { name, application: command.application, args: command.args, cwd: command.cwd, inheritEnv: false, env: { ...inheritedCommandEnvironment(), ...command.env }, pty: false, restart: 'no', persist: true, detached: false, keepOutput: { path, maxBytes: COMMAND_OUTPUT_MAX_BYTES } } });
    let abortStop: Promise<DaemonResponse> | undefined;
    const abort = () => { abortStop = client.request({ op: 'stop', name, timeoutMs: 5000 }); void abortStop.catch(() => {}); };
    command.signal.addEventListener('abort', abort, { once: true });
    if (command.signal.aborted) abort();
    try {
      const waited = await client.request({ op: 'wait', name, for: 'exit', timeoutMs: remaining() });
      if (waited.op !== 'wait') throw new Error('Supervisor returned an invalid wait response');
      if (waited.timedOut || command.signal.aborted) {
        const stopped = await (abortStop ?? client.request({ op: 'stop', name, timeoutMs: 5000 }));
        if (waited.timedOut && !command.signal.aborted && limit < deadline) {
          if (stopped.op !== 'stop') throw new Error('Supervisor returned an invalid stop response');
          const output = await keptOutput(client, name, path, stopped.daemon);
          return { exitCode: 124, output: `${output}${output.endsWith('\n') || !output ? '' : '\n'}[timed out after ${command.timeoutMs} ms; process tree stopped]\n` };
        }
        throw new Error(waited.timedOut ? 'Command deadline exceeded; process tree stopped' : 'Command canceled; process tree stopped');
      }
      if (waited.daemon.exitCode === null) throw new Error(waited.daemon.failure ?? 'Process exited without an exit code');
      return { exitCode: waited.daemon.exitCode, output: await keptOutput(client, name, path, waited.daemon) };
    } finally { command.signal.removeEventListener('abort', abort); }
  } finally { await rm(path, { force: true }); }
};
