import { z } from 'zod';
import { NAMED_KEYS } from '@gitspace/browser-extension';
import { BROWSER_RUNS_DAYS, BROWSER_RUNS_KEPT, RuntimeBrowserRunSchema, type RuntimeBrowserArguments, type RuntimeBrowserRun, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { BROWSER_RUN_PREFACE } from './runtime-browser-account.js';

/** Prefix of a workspace's recent browser runs, `runtime.browser.run:<at>:<attemptId>` (the Browser tab's Recent runs). */
export const BROWSER_RUN_ROWS = 'runtime.browser.run:';
/** A run as the workspace keeps it: a Chrome by its pairing (null when the call was refused before one was chosen),
 * named when the Browser tab lists it. */
export const BrowserRunRowSchema = RuntimeBrowserRunSchema.extend({ where: z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('chrome'), pairingId: z.string().uuid().nullable() }),
  z.strictObject({ kind: z.literal('cloud') }),
  z.strictObject({ kind: z.literal('machine'), machineId: z.string().min(1).max(256) }),
]) });
export type BrowserRunRow = z.infer<typeof BrowserRunRowSchema>;
type RunStorage = { list(options: { prefix: string; reverse?: boolean; limit?: number }): Promise<Map<string, unknown>>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<boolean> };
/** How a browser call ended: its result, or the error it threw (`refused`: before it reached a browser). */
export type BrowserRunEnd = { result: RuntimeToolResult } | { error: string; refused: boolean };

/** An element's name in a summary is at most this long. */
const NAME_LENGTH = 40;
const DAY_MS = 86_400_000;
/** What a script's reply says that the recent runs repeat: whether it ended well, how many log lines and downloads. */
const ScriptReply = z.object({ ok: z.boolean(), logs: z.array(z.string()).default([]), downloads: z.array(z.unknown()).default([]) });

/** A URL as the recent runs say it: its host and path, never its query or fragment. */
function place(url: string): string {
  try { const { host, pathname } = new URL(url); return pathname === '/' ? host : `${host}${pathname}`; } catch { return 'a page'; }
}

/** The element names of an observed page by ref, from its view (`- role "name" … [ref=<document>:<node>]`, see
 * `browser-view.ts`): a field shows its label there, never what is typed into it. */
export function viewNames(view: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of view.split('\n')) {
    const match = /^\s*- (\S+)(?: ("(?:[^"\\]|\\.)*"))?.*\[ref=([^\]\s]+)\]\s*$/u.exec(line);
    if (!match?.[3]) continue;
    let name = match[1] ?? '';
    try { if (match[2]) name = String(JSON.parse(match[2])); } catch { /* An unreadable name leaves the role. */ }
    // A label's colon is not part of what it names ("Customer name:").
    names.set(match[3], name.replace(/\s+/gu, ' ').trim().replace(/\s*:$/u, ''));
  }
  return names;
}

/** What one browser call did, as its row in the recent runs says it: an action, an element by the name the agent read
 * (`names`, by ref), a key only by its name, a URL as its host and path; never a typed value, an expression, a
 * script, a query or a script's error, which may hold any of them. A refusal or a failure says why, in the words the
 * agent was told, its URLs shortened the same way. */
export function browserRunSummary(args: RuntimeBrowserArguments, end: BrowserRunEnd, names: ReadonlyMap<string, string>): Pick<RuntimeBrowserRun, 'summary' | 'outcome' | 'details'> {
  const name = args.action === 'act' ? names.get(args.ref) : undefined;
  const element = name ? `“${name.length > NAME_LENGTH ? `${name.slice(0, NAME_LENGTH - 1)}…` : name}”` : args.action === 'act' ? args.ref : '';
  let call: string;
  switch (args.action) {
    case 'open': call = args.url ? `open ${place(args.url)}` : 'open a tab'; break;
    case 'navigate': call = `goto ${place(args.url)}`; break;
    case 'act': call = `act ${args.operation} ${args.operation === 'press' ? `${args.value && Object.hasOwn(NAMED_KEYS, args.value) ? args.value : 'a key'} on ` : ''}${element}`; break;
    case 'run': call = args.source === 'relay' && args.sites?.length ? `run on ${args.sites.join(', ')}` : 'run'; break;
    case 'close': call = 'close tab'; break;
    default: call = args.action;
  }
  if ('error' in end || end.result.status !== 'completed') {
    const reason = ('error' in end ? end.error : end.result.status === 'failed' ? end.result.error.message : 'It was interrupted').replace(/https?:\/\/[^\s"'<>)]+/gu, url => place(url)).slice(0, 300);
    if ('error' in end && end.refused) return { summary: `Refused: ${reason.split(/(?<=[.!?])\s/u)[0]?.replace(/\.$/u, '') ?? reason}`.slice(0, 200), outcome: 'refused', details: [call, reason] };
    return { summary: `${call} → failed`.slice(0, 200), outcome: 'failed', details: [call, reason] };
  }
  const texts = end.result.content.flatMap(part => part.type === 'text' ? [part.text] : []);
  // A script's result starts with the preface, then its reply; an observation's with its metadata. A view follows.
  const start = texts[0] === BROWSER_RUN_PREFACE ? 1 : 0;
  const view = args.action === 'observe' || args.action === 'run' ? texts[start + 1] : undefined;
  const refs = view?.startsWith('-') || view?.startsWith(' ') ? (view.match(/\[ref=/gu) ?? []).length : null;
  const details = [call];
  let outcome: RuntimeBrowserRun['outcome'] = 'ok';
  if (args.action === 'run') {
    let reply: unknown = null;
    try { reply = JSON.parse(texts[start] ?? ''); } catch { /* No reply to read: the run is listed without it. */ }
    const parsed = ScriptReply.safeParse(reply);
    if (parsed.success) {
      if (!parsed.data.ok) { outcome = 'failed'; details.push('The script failed; the agent has its error.'); }
      if (parsed.data.logs.length) details.push(`${parsed.data.logs.length} ${parsed.data.logs.length === 1 ? 'log line' : 'log lines'}`);
      if (parsed.data.downloads.length) details.push(`${parsed.data.downloads.length} ${parsed.data.downloads.length === 1 ? 'download' : 'downloads'} saved to the drive`);
    }
  }
  if (refs !== null) details.push(`Ended on a view with ${refs} ${refs === 1 ? 'ref' : 'refs'}`);
  const summary = outcome === 'failed' ? `${call} → failed` : refs !== null ? `${call} → view, ${refs} ${refs === 1 ? 'ref' : 'refs'}` : call;
  return { summary: summary.slice(0, 200), outcome, details };
}

/** Keeps one run in the workspace's recent runs, in place of any earlier row of the same attempt (a call prepared
 * again); rows older than `BROWSER_RUNS_DAYS` go, and all but the newest `BROWSER_RUNS_KEPT`. */
export async function logBrowserRun(storage: RunStorage, row: BrowserRunRow): Promise<void> {
  const keys = [...(await storage.list({ prefix: BROWSER_RUN_ROWS })).keys()];
  const since = new Date(Date.parse(row.at) - BROWSER_RUNS_DAYS * DAY_MS).toISOString();
  const others = keys.filter(key => !key.endsWith(`:${row.attemptId}`));
  const dropped = [...keys.filter(key => key.endsWith(`:${row.attemptId}`)), ...others.filter((key, index) => key.slice(BROWSER_RUN_ROWS.length) < since || index < others.length - (BROWSER_RUNS_KEPT - 1))];
  for (const key of new Set(dropped)) await storage.delete(key);
  await storage.put(`${BROWSER_RUN_ROWS}${row.at}:${row.attemptId}`, BrowserRunRowSchema.parse(row));
}

/** The workspace's recent runs, newest first, from the last `BROWSER_RUNS_DAYS`. */
export async function recentBrowserRuns(storage: Pick<RunStorage, 'list'>, now = Date.now()): Promise<BrowserRunRow[]> {
  const since = new Date(now - BROWSER_RUNS_DAYS * DAY_MS).toISOString();
  return [...(await storage.list({ prefix: BROWSER_RUN_ROWS, reverse: true, limit: BROWSER_RUNS_KEPT })).values()].map(row => BrowserRunRowSchema.parse(row)).filter(row => row.at >= since);
}
