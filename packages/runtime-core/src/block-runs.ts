// The runs `blocks` commandRun and testReport are built from: a finished bash job (jobs.ts reads its record) or an
// exited proc process, read on its machine through proc describe and logs.
import type { JsonValue } from '@earendil-works/chord/json';
import { commandRunBlock, testReportBlock } from '@gitspace/protocol/block-builders';
import { RuntimeJsonSchema, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { DaemonResponseSchema } from '@gitspace/supervisor/protocol';
import { z } from 'zod';

/** A finished command: `cut` says the output held is only part of what it wrote; `id` names the job or process. */
export interface FinishedRun { id: string; command: string; cwd: string | null; exitCode: number; durationMs: number; output: string; cut: boolean }

const CommandOutputSchema = z.object({ exitCode: z.number().int(), output: z.string() });
/** The line a machine adds where it dropped the end of a command's output (runtime-machine commands.ts). */
const OUTPUT_CUT = /^\[Output cut: /mu;

/** A command result's exit code and output: "Exit code: N\n<output>" from a machine's bash, or the JSON
 * { exitCode, output } its command operation answers; null for neither. */
export function commandResult(text: string): { exitCode: number; output: string; cut: boolean } | null {
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* The plain form. */ }
  const parsed = CommandOutputSchema.safeParse(json);
  const plain = /^Exit code: (-?\d+)\n/u.exec(text);
  const result = parsed.success ? parsed.data : plain ? { exitCode: Number(plain[1]), output: text.slice(plain[0].length) } : null;
  return result && { ...result, cut: OUTPUT_CUT.test(result.output) };
}

/** Process logs a TestReport or CommandRun reads: the most the supervisor returns in one request. */
const PROCESS_LOG_LINES = 10_000;

/** A shell word as written: quoted when it holds anything but plain characters. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll('\'', '\'\\\'\'')}'`;
}

/** An exited proc process, read with `proc` (a call routed to the process's machine) by describe and logs. */
export async function finishedProcess(name: string, proc: (args: { op: 'describe' | 'logs'; name: string; lines?: number }) => Promise<RuntimeToolResult>): Promise<FinishedRun> {
  const read = async (args: { op: 'describe' | 'logs'; name: string; lines?: number }) => {
    const result = await proc(args);
    const text = result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('');
    if (result.status !== 'completed') throw new Error(`proc ${args.op} ${name} failed: ${result.status === 'failed' ? result.error.message : text || 'interrupted'}`);
    return DaemonResponseSchema.parse(JSON.parse(text));
  };
  const described = await read({ op: 'describe', name });
  if (described.op !== 'describe') throw new Error(`proc describe ${name} answered ${described.op}`);
  const { daemon, spec } = described;
  if ((daemon.state !== 'exited' && daemon.state !== 'failed') || daemon.exitCode === null || daemon.finishedAt === undefined) {
    throw new Error(`Process ${name} has not exited (it is ${daemon.state}); wait for it with proc { op: "wait", name: "${name}", for: "exit" }`);
  }
  const logs = await read({ op: 'logs', name, lines: PROCESS_LOG_LINES });
  if (logs.op !== 'logs') throw new Error(`proc logs ${name} answered ${logs.op}`);
  return {
    id: name, command: [spec.application, ...spec.args].map(shellWord).join(' '), cwd: spec.cwd, exitCode: daemon.exitCode,
    durationMs: Date.parse(daemon.finishedAt) - Date.parse(daemon.createdAt), output: logs.text,
    cut: (daemon.keptOutput?.droppedBytes ?? 0) > 0 || logs.text.split('\n').length >= PROCESS_LOG_LINES,
  };
}

/** The block `op` builds from a finished run, as the JSON the `blocks` tool answers. */
export function runBlock(op: 'commandRun' | 'testReport', run: FinishedRun): JsonValue {
  return RuntimeJsonSchema.parse(op === 'commandRun'
    ? commandRunBlock({ command: run.command, exitCode: run.exitCode, durationMs: run.durationMs, output: run.output, cut: run.cut, jobId: run.id, cwd: run.cwd })
    : testReportBlock(run.output, run.cut));
}
