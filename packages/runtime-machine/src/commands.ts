import { createHash } from 'node:crypto';
import { daemonClientForProject } from '@gitspace/supervisor';

/** `project` names the supervisor that owns the process (the checkout root); it defaults to `cwd`. */
export type ExecutorCommand = { application: string; args: string[]; cwd: string; project?: string; attemptId: string; sequence: number; deadlineAt: string; signal: AbortSignal; env?: Record<string, string> };
export type ExecutorCommandResult = { exitCode: number; output: string };
export type RunExecutorCommand = (command: ExecutorCommand) => Promise<ExecutorCommandResult>;

/** Machine variables a supervised command may inherit; everything else is explicit. */
export function inheritedCommandEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/** Runs one command under the supervisor; cancellation or the deadline stops its process tree. The process is named by
 * attempt and sequence, so background job control (`bash` `{ op, attemptId }`) can find it. */
export const runSupervisorCommand: RunExecutorCommand = async command => {
  const client = await daemonClientForProject(command.project ?? command.cwd);
  const name = `exec-${createHash('sha256').update(`${command.attemptId}:${command.sequence}`).digest('hex').slice(0, 40)}`;
  const remaining = () => Math.max(1, Math.min(2_147_483_647, Date.parse(command.deadlineAt) - Date.now()));
  if (command.signal.aborted || Date.parse(command.deadlineAt) <= Date.now()) throw new Error('Command canceled or deadline expired before launch');
  await client.request({ op: 'start', owner: command.attemptId, spec: { name, application: command.application, args: command.args, cwd: command.cwd, inheritEnv: false, env: { ...inheritedCommandEnvironment(), ...command.env }, pty: false, restart: 'no', persist: true, detached: false } });
  let abortStop: Promise<unknown> | undefined;
  const abort = () => { abortStop = client.request({ op: 'stop', name, timeoutMs: 5000 }); void abortStop.catch(() => {}); };
  command.signal.addEventListener('abort', abort, { once: true });
  if (command.signal.aborted) abort();
  try {
    const waited = await client.request({ op: 'wait', name, for: 'exit', timeoutMs: remaining() });
    if (waited.op !== 'wait') throw new Error('Supervisor returned an invalid wait response');
    if (waited.timedOut || command.signal.aborted) {
      await (abortStop ?? client.request({ op: 'stop', name, timeoutMs: 5000 }));
      throw new Error(waited.timedOut ? 'Command deadline exceeded; process tree stopped' : 'Command canceled; process tree stopped');
    }
    if (waited.daemon.exitCode === null) throw new Error(waited.daemon.failure ?? 'Process exited without an exit code');
    const logs = await client.request({ op: 'logs', name, lines: 10000, head: false });
    if (logs.op !== 'logs') throw new Error('Supervisor returned an invalid logs response');
    return { exitCode: waited.daemon.exitCode, output: logs.text };
  } finally { command.signal.removeEventListener('abort', abort); }
};
