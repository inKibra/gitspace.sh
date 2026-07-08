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

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getWorkspaceRoot } from '../../core/paths.js';
import { redactDeep } from '../../utils/redact.js';
import { PACKAGE_VERSION } from './protocol.js';

export interface ProblemReport {
  v: 1;
  note: string;
  createdAt: string;
  server: {
    version: string;
    pid: number;
    uptimeSec: number;
    platform: string;
  };
  client: unknown;
}

export function buildProblemReport(note: string, clientBundle: unknown, now: number): { report: ProblemReport; redacted: ProblemReport } {
  const report: ProblemReport = {
    v: 1,
    note,
    createdAt: new Date(now).toISOString(),
    server: {
      version: PACKAGE_VERSION,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      platform: process.platform,
    },
    client: clientBundle,
  };
  // Redact the WHOLE record on egress — client stacks/logs and server context
  // both routinely carry tokens/paths. redactDeep fails closed per-string.
  return { report, redacted: redactDeep(report) };
}

export function writeProblemReport(note: string, clientBundle: unknown, now: number): { path: string } {
  const { redacted } = buildProblemReport(note, clientBundle, now);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const dir = join(getWorkspaceRoot(), '.logs', 'reports', stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'report.json');
  writeFileSync(path, JSON.stringify(redacted, null, 2), { mode: 0o600 });
  return { path };
}

/** The issue title (first line of the note, trimmed) + a redacted markdown body. */
export function issueTitleAndBody(redacted: ProblemReport): { title: string; body: string } {
  const firstLine = (redacted.note.split('\n')[0] ?? '').trim();
  const title = (firstLine || 'Problem report').slice(0, 120);
  const client = redacted.client as {
    version?: string; url?: string; userAgent?: string;
    ring?: Array<{ kind: string; message: string }>;
    posthog?: { replayUrl?: string } | null;
  } | undefined;
  const ring = client?.ring ?? [];
  const lines = [
    redacted.note,
    '',
    '---',
    '**Environment**',
    `- gitspace: ${redacted.server.version} (${redacted.server.platform})`,
    client?.url ? `- page: ${client.url}` : '',
    client?.userAgent ? `- ua: ${client.userAgent}` : '',
    client?.posthog?.replayUrl ? `- [PostHog session replay](${client.posthog.replayUrl})` : '',
    '',
    `**Recent client errors (${ring.length})**`,
    ...(ring.length > 0
      ? ['```', ...ring.slice(-15).map((e) => `[${e.kind}] ${e.message}`), '```']
      : ['_none captured_']),
    '',
    '_Filed from GitSpace · report a problem. Diagnostics redacted (tokens, home paths)._',
  ].filter((l) => l !== '');
  return { title, body: lines.join('\n') };
}
