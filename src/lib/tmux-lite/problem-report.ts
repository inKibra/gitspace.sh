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

export function writeProblemReport(note: string, clientBundle: unknown, now: number): { path: string } {
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
  const redacted = redactDeep(report);

  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const dir = join(getWorkspaceRoot(), '.logs', 'reports', stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'report.json');
  writeFileSync(path, JSON.stringify(redacted, null, 2), { mode: 0o600 });
  return { path };
}
