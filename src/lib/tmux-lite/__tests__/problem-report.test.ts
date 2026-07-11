/**
 * Problem-report assembly + filing, origin 'user' | 'agent'.
 *
 * Issue creation is verified WITHOUT publishing: gh runs through the injected
 * GhExec seam (core/github-issues.ts) and GITSPACE_REPORT_REPO points at a
 * dummy slug. No real GitHub issue or gist is ever created here.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { GhExec } from '../../../core/github-issues.js';
import {
  buildProblemReport,
  fileAgentReport,
  fileProblemReport,
  issueTitleAndBody,
} from '../problem-report.js';

let tmpRoot: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'gssh-report-test-'));
  for (const key of ['GITSPACE_WORKSPACE_ROOT', 'GITSPACE_REPORT_REPO']) {
    savedEnv[key] = process.env[key];
  }
  process.env.GITSPACE_WORKSPACE_ROOT = tmpRoot;
  process.env.GITSPACE_REPORT_REPO = 'example/report-dummy';
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

const NOW = Date.parse('2026-07-11T12:00:00.000Z');

describe('buildProblemReport origins', () => {
  test('defaults to origin user with no agent context (user reports unchanged)', () => {
    const { report, redacted } = buildProblemReport('the pane went blank', { url: 'https://x.test' }, NOW);
    expect(report.origin).toBe('user');
    expect(report.agent).toBeUndefined();
    const { title, body } = issueTitleAndBody(redacted);
    expect(title).toBe('the pane went blank');
    expect(title.startsWith('[agent]')).toBe(false);
    expect(body).not.toContain('**Origin**');
    expect(body).toContain('report a problem');
  });

  test('origin agent carries session context; title gets the [agent] prefix', () => {
    const { redacted } = buildProblemReport(
      'bash: exit code lost on pipelines',
      { agentReport: { tool: 'bash', report: 'exit code lost on pipelines' } },
      NOW,
      {
        origin: 'agent',
        agent: {
          sessionId: 'ses_123',
          workspaceId: 'proj/ws-1',
          sessionTitle: 'Fix flaky tests',
          model: 'anthropic/claude-test-1',
          tool: 'bash',
        },
      },
    );
    expect(redacted.origin).toBe('agent');
    expect(redacted.agent?.sessionId).toBe('ses_123');

    const { title, body } = issueTitleAndBody(redacted);
    expect(title).toBe('[agent] bash: exit code lost on pipelines');
    expect(body).toContain('**Origin**');
    expect(body).toContain('- filed by: agent (anthropic/claude-test-1)');
    expect(body).toContain('- session: ses_123 · Fix flaky tests');
    expect(body).toContain('- workspace: proj/ws-1');
    expect(body).toContain('- tool reported: bash');
    expect(body).toContain('agent report (report_tool_issue)');
  });

  test('redactDeep runs over the whole agent payload (note + context)', () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4';
    const { redacted } = buildProblemReport(
      `bash: auth failed with ${token} reading /home/alice/secrets.txt`,
      { agentReport: { report: `token ${token}` } },
      NOW,
      { origin: 'agent', agent: { sessionId: 's', sessionTitle: `uses ${token}` } },
    );
    expect(redacted.note).not.toContain(token);
    expect(redacted.note).toContain('[REDACTED]');
    expect(redacted.note).not.toContain('/home/alice');
    expect(redacted.note).toContain('~');
    expect(JSON.stringify(redacted.client)).not.toContain(token);
    expect(redacted.agent?.sessionTitle).not.toContain(token);
  });
});

/** Capture every gh invocation + the JSON payload gh would have read. */
function captureGh(): { exec: GhExec; calls: Array<{ args: string[]; payload: unknown }> } {
  const calls: Array<{ args: string[]; payload: unknown }> = [];
  const exec: GhExec = async (args) => {
    const inputIdx = args.indexOf('--input');
    const payload = inputIdx >= 0 ? JSON.parse(readFileSync(args[inputIdx + 1]!, 'utf8')) : null;
    calls.push({ args, payload });
    if (args[1] === 'gists') {
      return { stdout: JSON.stringify({ html_url: 'https://gist.github.com/dummy/abc' }) };
    }
    return { stdout: JSON.stringify({ number: 77, html_url: 'https://github.com/example/report-dummy/issues/77' }) };
  };
  return { exec, calls };
}

describe('fileAgentReport (mocked gh — never publishes)', () => {
  test('files exactly like user reports: local write + gist + issue with [agent] title', async () => {
    const { exec, calls } = captureGh();
    const filed = await fileAgentReport(
      {
        sessionId: 'ses_abc',
        workspaceId: 'gitspace.sh/multi-pane',
        workspaceName: 'multi-pane',
        projectName: 'gitspace.sh',
        sessionTitle: 'Ticket #9',
        model: 'anthropic/claude-test-1',
        tool: 'edit',
        report: 'edit silently dropped a trailing newline',
      },
      NOW,
      exec,
    );

    // Local reversible sink written under <root>/.logs/reports/<ts>/report.json
    expect(existsSync(filed.path)).toBe(true);
    expect(filed.path.startsWith(join(tmpRoot, '.logs', 'reports'))).toBe(true);
    const onDisk = JSON.parse(readFileSync(filed.path, 'utf8'));
    expect(onDisk.origin).toBe('agent');
    expect(onDisk.agent.sessionId).toBe('ses_abc');

    // gh invoked twice: gist first, then the issue POST to the dummy repo.
    expect(calls.length).toBe(2);
    expect(calls[0]!.args.slice(0, 4)).toEqual(['api', 'gists', '--method', 'POST']);
    expect(calls[1]!.args.slice(0, 4)).toEqual(['api', 'repos/example/report-dummy/issues', '--method', 'POST']);

    const issuePayload = calls[1]!.payload as { title: string; body: string; labels: string[] };
    expect(issuePayload.title).toBe('[agent] edit: edit silently dropped a trailing newline');
    expect(issuePayload.labels).toEqual(['gitspace-report']);
    expect(issuePayload.body).toContain('- filed by: agent (anthropic/claude-test-1)');
    expect(issuePayload.body).toContain('- session: ses_abc · Ticket #9');
    expect(issuePayload.body).toContain('- tool reported: edit');
    expect(issuePayload.body).toContain('https://gist.github.com/dummy/abc');

    expect(filed.issueUrl).toBe('https://github.com/example/report-dummy/issues/77');
    expect(filed.issueNumber).toBe(77);
  });

  test('issue-filing failure degrades to local-only (report never lost)', async () => {
    const exec: GhExec = async () => {
      throw new Error('gh not authenticated');
    };
    const filed = await fileAgentReport(
      {
        sessionId: 's2',
        workspaceId: 'w',
        workspaceName: 'w',
        projectName: 'p',
        tool: 'bash',
        report: 'nope',
      },
      NOW + 1000,
      exec,
    );
    expect(existsSync(filed.path)).toBe(true);
    expect(filed.issueUrl).toBeUndefined();
    expect(filed.issueNumber).toBeUndefined();
  });
});

describe('fileProblemReport (user path via shared routine)', () => {
  test('keeps the unprefixed title and gitspace-report label', async () => {
    const { exec, calls } = captureGh();
    const filed = await fileProblemReport('terminal froze after resize', { url: 'https://app.test' }, NOW + 2000, {}, exec);

    expect(existsSync(filed.path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filed.path, 'utf8'));
    expect(onDisk.origin).toBe('user');

    const issuePayload = calls[1]!.payload as { title: string; body: string; labels: string[] };
    expect(issuePayload.title).toBe('terminal froze after resize');
    expect(issuePayload.title.startsWith('[agent]')).toBe(false);
    expect(issuePayload.labels).toEqual(['gitspace-report']);
    expect(issuePayload.body).not.toContain('**Origin**');
  });
});
