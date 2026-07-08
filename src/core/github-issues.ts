/**
 * GitHub issue filing (docs/REPORT-A-PROBLEM.md, Loop 1 → GitHub).
 *
 * Models the POST idiom from github-review.ts (gh api … --method POST --input
 * <tmpfile>, array-safe via escapeShellArg). The `exec` seam is dependency-
 * injected so issue creation is unit-testable WITHOUT publishing a real issue.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SpacesError } from '../types/errors.js';

const execFileAsync = promisify(execFile);

/** Runs a `gh` invocation with argv (no shell). Injectable for tests. */
export type GhExec = (args: string[], cwd?: string) => Promise<{ stdout: string }>;

const defaultGhExec: GhExec = async (args, cwd) => {
  const { stdout } = await execFileAsync('gh', args, { cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf-8' });
  return { stdout };
};

/** `<owner>/<repo>` for the git repo at cwd, or null if not resolvable. */
export async function resolveRepoSlug(cwd: string, exec: GhExec = defaultGhExec): Promise<string | null> {
  try {
    const { stdout } = await exec(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd);
    const slug = stdout.trim();
    return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

/** One open issue by number. Throws (via gh) if it doesn't exist. */
export async function fetchIssue(slug: string, number: number, cwd?: string, exec: GhExec = defaultGhExec): Promise<GithubIssue> {
  const { stdout } = await exec(['api', `repos/${slug}/issues/${number}`], cwd);
  const j = JSON.parse(stdout) as { number: number; title: string; body?: string; html_url: string; pull_request?: unknown };
  if (j.pull_request) throw new SpacesError(`#${number} is a pull request, not an issue`, 'USER_ERROR', 1);
  return { number: j.number, title: j.title, body: j.body ?? '', url: j.html_url };
}

/** Open issues, newest first, optionally filtered by label. */
export async function listIssues(slug: string, opts: { label?: string; limit?: number } = {}, cwd?: string, exec: GhExec = defaultGhExec): Promise<GithubIssue[]> {
  const args = ['api', `repos/${slug}/issues?state=open&per_page=${opts.limit ?? 30}${opts.label ? `&labels=${encodeURIComponent(opts.label)}` : ''}`];
  const { stdout } = await exec(args, cwd);
  const arr = JSON.parse(stdout) as Array<{ number: number; title: string; body?: string; html_url: string; pull_request?: unknown }>;
  return arr
    .filter((j) => !j.pull_request) // the issues endpoint includes PRs; drop them
    .map((j) => ({ number: j.number, title: j.title, body: j.body ?? '', url: j.html_url }));
}

export interface CreateIssueInput {
  slug: string;            // owner/repo
  title: string;
  body: string;
  labels?: string[];
  cwd?: string;
}

export interface CreatedIssue {
  number: number;
  url: string;
}

/** Create a GitHub issue via `gh api repos/<slug>/issues --method POST`. */
export async function createIssue(input: CreateIssueInput, exec: GhExec = defaultGhExec): Promise<CreatedIssue> {
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.slug)) {
    throw new SpacesError(`Invalid repo slug: ${input.slug}`, 'USER_ERROR', 1);
  }
  const payload = {
    title: input.title,
    body: input.body,
    ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
  };
  const tmpFile = join(tmpdir(), `gssh-issue-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify(payload), 'utf-8');
    const { stdout } = await exec(
      ['api', `repos/${input.slug}/issues`, '--method', 'POST', '--input', tmpFile],
      input.cwd,
    );
    const parsed = JSON.parse(stdout) as { number?: number; html_url?: string };
    if (typeof parsed.number !== 'number' || !parsed.html_url) {
      throw new SpacesError('GitHub issue create returned an unexpected shape', 'SYSTEM_ERROR', 1);
    }
    return { number: parsed.number, url: parsed.html_url };
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}
