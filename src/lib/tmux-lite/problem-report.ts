/**
 * Problem-report assembly (docs/REPORT-A-PROBLEM.md, Loop 1 terminus).
 *
 * Takes the client-captured bundle + the user's note, adds server-side
 * context, redacts EVERYTHING (redactDeep) before it touches disk, and writes
 * it under <root>/.logs/reports/<ts>/report.json. Returns the path.
 *
 * GitHub-issue filing is a deliberate later step (it publishes externally and
 * needs a repo target + the user's consent) — this local write is the safe,
 * reversible sink and the fallback the design specifies.
 */

import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import type { GhExec } from '../../core/github-issues.js';
import { getWorkspaceRoot } from '../../core/paths.js';
import { redactDeep } from '../../utils/redact.js';
import { getTraceRing } from '../../utils/trace-log.js';
import type { AgentReportPayload } from './agents/session-host.js';
import { PACKAGE_VERSION, getSessionDir } from './protocol.js';

/** Last `maxLines` of the always-on daemon log ('server logs'). */
function daemonLogTail(maxLines = 400): string {
  try {
    const text = readFileSync(join(getSessionDir(), 'tmux-lite-daemon.log'), 'utf8');
    const lines = text.split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '(daemon log unavailable)';
  }
}

/** Who filed the report: an interactive user ('user', the default) or an
 *  agent invoking the SDK's report_tool_issue tool ('agent'). */
export type ProblemReportOrigin = 'user' | 'agent';

/** Session context attached to agent-originated reports. */
export interface AgentReportContext {
  sessionId: string;
  workspaceId?: string;
  sessionTitle?: string;
  /** The agent's active model (provider/id) at report time. */
  model?: string;
  /** The tool the agent reported unexpected behavior for. */
  tool?: string;
}

export interface ProblemReportOptions {
  origin?: ProblemReportOrigin;
  agent?: AgentReportContext;
  /** Compact authoritative agent-status dump gathered by the caller (the daemon
   *  has direct access): per-session raw status.type, pending permission/question
   *  counts, derived board state, plus the coordinator's open dialogs. Makes
   *  status-inconsistency bugs (e.g. "asking a question but shows green")
   *  diagnosable from the report alone by comparing it against the DOM snapshot. */
  serverAgentState?: unknown;
}

export interface ProblemReport {
  v: 1;
  origin: ProblemReportOrigin;
  note: string;
  createdAt: string;
  /** Present iff origin === 'agent'. */
  agent?: AgentReportContext;
  server: {
    version: string;
    pid: number;
    uptimeSec: number;
    platform: string;
    /** Server-side chain of events (always-on trace ring). */
    traceRing: ReturnType<typeof getTraceRing>;
    /** Tail of the daemon log ('server logs'). */
    daemonLogTail: string;
    /** Compact authoritative agent-status dump (see ProblemReportOptions). */
    agentState?: unknown;
  };
  client: unknown;
}

export function buildProblemReport(
  note: string,
  clientBundle: unknown,
  now: number,
  options: ProblemReportOptions = {},
): { report: ProblemReport; redacted: ProblemReport } {
  const report: ProblemReport = {
    v: 1,
    origin: options.origin ?? 'user',
    note,
    createdAt: new Date(now).toISOString(),
    ...(options.agent ? { agent: options.agent } : {}),
    server: {
      version: PACKAGE_VERSION,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      platform: process.platform,
      traceRing: getTraceRing(),
      daemonLogTail: daemonLogTail(),
      ...(options.serverAgentState !== undefined ? { agentState: options.serverAgentState } : {}),
    },
    client: clientBundle,
  };
  // Redact the WHOLE record on egress — client stacks/logs, server context and
  // agent-supplied text all routinely carry tokens/paths. redactDeep fails
  // closed per-string.
  return { report, redacted: redactDeep(report) };
}

export function writeProblemReport(
  note: string,
  clientBundle: unknown,
  now: number,
  options: ProblemReportOptions = {},
): { path: string } {
  const { redacted } = buildProblemReport(note, clientBundle, now, options);
  return { path: writeRedactedReport(redacted, now) };
}

function writeRedactedReport(redacted: ProblemReport, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const dir = join(getWorkspaceRoot(), '.logs', 'reports', stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'report.json');
  writeFileSync(path, JSON.stringify(redacted, null, 2), { mode: 0o600 });
  return path;
}

/** The full logs, as named files, to attach to the issue (uploaded as a gist —
 *  no truncation). Returned separately so the caller can attach them. */
export function issueLogFiles(redacted: ProblemReport): Array<{ name: string; content: string }> {
  const client = redacted.client as {
    ring?: Array<{ kind: string; message: string }>;
    domSnapshot?: string;
  } | undefined;
  const ring = client?.ring ?? [];
  const files: Array<{ name: string; content: string }> = [
    { name: 'report.json', content: JSON.stringify(redacted, null, 2) },
  ];
  const daemonLog = redacted.server.daemonLogTail;
  if (daemonLog && daemonLog !== '(daemon log unavailable)') files.push({ name: 'daemon.log', content: daemonLog });
  const trace = (redacted.server.traceRing ?? [])
    .map((t) => `[${t.ts}] ${t.event}${t.details ? ` ${JSON.stringify(t.details)}` : ''}`).join('\n');
  if (trace) files.push({ name: 'server-trace.log', content: trace });
  if (ring.length) files.push({ name: 'client-console.log', content: ring.map((e) => `[${e.kind}] ${e.message}`).join('\n') });
  if (client?.domSnapshot) files.push({ name: 'dom-snapshot.html', content: client.domSnapshot });
  return files.filter((f) => f.content);
}

/** The issue title (first line of the note, trimmed) + a redacted markdown body.
 *  The body is a concise summary; the FULL logs ride along as a linked gist
 *  attachment (see issueLogFiles) — pass its URL as `logsUrl`. */
export function issueTitleAndBody(redacted: ProblemReport, logsUrl?: string): { title: string; body: string } {
  const firstLine = (redacted.note.split('\n')[0] ?? '').trim();
  const isAgent = redacted.origin === 'agent';
  const base = (firstLine || 'Problem report').slice(0, 120);
  const title = isAgent ? `[agent] ${base}` : base;
  const agent = redacted.agent;
  const client = redacted.client as {
    version?: string; url?: string; userAgent?: string;
    ring?: Array<{ kind: string; message: string }>;
    posthog?: { replayUrl?: string } | null;
    domSnapshot?: string;
  } | undefined;
  const ring = client?.ring ?? [];
  const lines = [
    redacted.note,
    '',
    '---',
    '**Environment**',
    `- gitspace: ${redacted.server.version} (${redacted.server.platform}) · pid ${redacted.server.pid} · up ${redacted.server.uptimeSec}s`,
    client?.url ? `- page: ${client.url}` : '',
    client?.userAgent ? `- ua: ${client.userAgent}` : '',
    client?.posthog?.replayUrl ? `- [PostHog session replay](${client.posthog.replayUrl})` : '',
    '',
    ...(isAgent
      ? [
          '**Origin**',
          `- filed by: agent${agent?.model ? ` (${agent.model})` : ''}`,
          agent?.sessionId ? `- session: ${agent.sessionId}${agent.sessionTitle ? ` · ${agent.sessionTitle}` : ''}` : '',
          agent?.workspaceId ? `- workspace: ${agent.workspaceId}` : '',
          agent?.tool ? `- tool reported: ${agent.tool}` : '',
          '',
        ]
      : []),
    `**Recent client errors (${ring.length})**`,
    ...(ring.length > 0
      ? ['```', ...ring.slice(-15).map((e) => `[${e.kind}] ${e.message}`), '```']
      : ['_none captured_']),
    '',
    logsUrl
      ? `**Full logs** (daemon log, server trace, client console, DOM snapshot, full report): ${logsUrl}`
      : '_Full logs saved to the machine-local report.json (gist upload unavailable)._',
    '',
    isAgent
      ? '_Filed from GitSpace · agent report (report_tool_issue). Diagnostics redacted (tokens, home paths)._'
      : '_Filed from GitSpace · report a problem. Diagnostics redacted (tokens, home paths)._',
  ].filter((l) => l !== '');
  return { title, body: lines.join('\n') };
}

/**
 * The full pipeline terminus, shared by user reports (daemon 'report-problem'
 * command) and agent reports: write the redacted local report (the reversible
 * sink + fallback), then file a GitHub issue to reportRepoSlug() with the full
 * logs attached as a secret gist. Issue-filing failure degrades to local-only
 * and is logged — the report is never lost.
 *
 * `exec` is the injectable `gh` seam (core/github-issues.ts) so tests can
 * assert the constructed payload WITHOUT executing gh.
 */
export async function fileProblemReport(
  note: string,
  clientBundle: unknown,
  now: number,
  options: ProblemReportOptions = {},
  exec?: GhExec,
): Promise<{ path: string; issueUrl?: string; issueNumber?: number }> {
  const { redacted } = buildProblemReport(note, clientBundle, now, options);
  const path = writeRedactedReport(redacted, now);

  let issueUrl: string | undefined;
  let issueNumber: number | undefined;
  try {
    const { createIssue, createGist, reportRepoSlug } = await import('../../core/github-issues.js');
    // Attach the FULL logs (no truncation) as a gist, link it in the issue.
    const logsUrl = await createGist(
      issueLogFiles(redacted),
      `GitSpace problem report — ${new Date(now).toISOString()}`,
      exec,
    );
    const { title, body } = issueTitleAndBody(redacted, logsUrl ?? undefined);
    const issue = await createIssue(
      { slug: reportRepoSlug(), title, body, labels: ['gitspace-report'], cwd: getWorkspaceRoot() },
      exec,
    );
    issueUrl = issue.url;
    issueNumber = issue.number;
  } catch (e) {
    console.error(`[report] GitHub issue filing failed (report saved locally at ${path}): ${e instanceof Error ? e.message : String(e)}`);
  }
  return { path, issueUrl, issueNumber };
}

/**
 * File an agent-originated report (SDK report_tool_issue → GitSpace pipeline).
 * Identical filing path to user reports; origin 'agent' + session context ride
 * in the report, the issue title gets the '[agent]' prefix, and the whole
 * payload passes redactDeep like everything else.
 */
export async function fileAgentReport(
  payload: AgentReportPayload,
  now: number,
  exec?: GhExec,
): Promise<{ path: string; issueUrl?: string; issueNumber?: number }> {
  const note = `${payload.tool}: ${payload.report}`;
  return fileProblemReport(
    note,
    { agentReport: payload },
    now,
    {
      origin: 'agent',
      agent: {
        sessionId: payload.sessionId,
        workspaceId: payload.workspaceId,
        sessionTitle: payload.sessionTitle,
        model: payload.model,
        tool: payload.tool,
      },
    },
    exec,
  );
}
