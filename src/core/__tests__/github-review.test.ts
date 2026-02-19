import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { importGitHubReview, pushGitHubReview } from '../github-review.js';
import { readReviewSession, writeReviewSession } from '../review.js';
import type { ReviewComment, ReviewThread } from '../../types/review.js';

const OWNER = 'acme';
const REPO = 'widget';
const PR_NUMBER = 7;
const WORKSPACE_NAME = 'review-workspace';
const BASE_BRANCH = 'main';

type EnvSnapshot = {
  PATH?: string;
  GH_STUB_IMPORT_FILE?: string;
  GH_STUB_CALL_LOG?: string;
  GH_STUB_PAYLOAD_LOG?: string;
  GH_STUB_REPLY_COUNTER_FILE?: string;
  GH_STUB_REVIEW_COUNTER_FILE?: string;
};

function captureEnv(): EnvSnapshot {
  return {
    PATH: process.env.PATH,
    GH_STUB_IMPORT_FILE: process.env.GH_STUB_IMPORT_FILE,
    GH_STUB_CALL_LOG: process.env.GH_STUB_CALL_LOG,
    GH_STUB_PAYLOAD_LOG: process.env.GH_STUB_PAYLOAD_LOG,
    GH_STUB_REPLY_COUNTER_FILE: process.env.GH_STUB_REPLY_COUNTER_FILE,
    GH_STUB_REVIEW_COUNTER_FILE: process.env.GH_STUB_REVIEW_COUNTER_FILE,
  };
}

function restoreEnv(env: EnvSnapshot): void {
  if (env.PATH === undefined) delete process.env.PATH;
  else process.env.PATH = env.PATH;

  if (env.GH_STUB_IMPORT_FILE === undefined) delete process.env.GH_STUB_IMPORT_FILE;
  else process.env.GH_STUB_IMPORT_FILE = env.GH_STUB_IMPORT_FILE;

  if (env.GH_STUB_CALL_LOG === undefined) delete process.env.GH_STUB_CALL_LOG;
  else process.env.GH_STUB_CALL_LOG = env.GH_STUB_CALL_LOG;

  if (env.GH_STUB_PAYLOAD_LOG === undefined) delete process.env.GH_STUB_PAYLOAD_LOG;
  else process.env.GH_STUB_PAYLOAD_LOG = env.GH_STUB_PAYLOAD_LOG;

  if (env.GH_STUB_REPLY_COUNTER_FILE === undefined) delete process.env.GH_STUB_REPLY_COUNTER_FILE;
  else process.env.GH_STUB_REPLY_COUNTER_FILE = env.GH_STUB_REPLY_COUNTER_FILE;

  if (env.GH_STUB_REVIEW_COUNTER_FILE === undefined) delete process.env.GH_STUB_REVIEW_COUNTER_FILE;
  else process.env.GH_STUB_REVIEW_COUNTER_FILE = env.GH_STUB_REVIEW_COUNTER_FILE;
}

function writeGhStub(binPath: string): void {
  const script = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';

const args = process.argv.slice(2);
const callLog = process.env.GH_STUB_CALL_LOG;
if (callLog) {
  appendFileSync(callLog, JSON.stringify({ args }) + '\n', 'utf-8');
}

function readFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function readInputPayload() {
  const inputFile = readFlag('--input');
  if (!inputFile || !existsSync(inputFile)) return null;
  return JSON.parse(readFileSync(inputFile, 'utf-8'));
}

function nextCounter(file, start) {
  let current = start;
  if (existsSync(file)) {
    current = parseInt(readFileSync(file, 'utf-8').trim(), 10);
    if (Number.isNaN(current)) current = start;
  }
  const next = current + 1;
  writeFileSync(file, String(next), 'utf-8');
  return next;
}

const payloadLog = process.env.GH_STUB_PAYLOAD_LOG;

if (args[0] === 'repo' && args[1] === 'view') {
  if (args.includes('owner')) {
    process.stdout.write('${OWNER}\n');
  } else {
    process.stdout.write('${REPO}\n');
  }
  process.exit(0);
}

if (args[0] !== 'api') {
  process.stderr.write('Unsupported gh invocation: ' + args.join(' ') + '\n');
  process.exit(1);
}

const endpoint = args[1] ?? '';
const method = readFlag('--method') ?? 'GET';

if (method === 'GET' && endpoint === 'repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments') {
  const importFile = process.env.GH_STUB_IMPORT_FILE;
  if (importFile && existsSync(importFile)) {
    process.stdout.write(readFileSync(importFile, 'utf-8'));
  } else {
    process.stdout.write('[]');
  }
  process.exit(0);
}

if (method === 'POST' && endpoint === 'repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/comments') {
  const payload = readInputPayload() ?? {};
  if (payloadLog) {
    appendFileSync(payloadLog, JSON.stringify({ kind: 'reply', endpoint, payload }) + '\n', 'utf-8');
  }
  const counterFile = process.env.GH_STUB_REPLY_COUNTER_FILE;
  const id = counterFile ? nextCounter(counterFile, 5000) : 5001;
  process.stdout.write(JSON.stringify({ id, html_url: 'https://example.invalid/discussion/' + id }));
  process.exit(0);
}

if (method === 'POST' && endpoint === 'repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews') {
  const payload = readInputPayload() ?? {};
  if (payloadLog) {
    appendFileSync(payloadLog, JSON.stringify({ kind: 'review', endpoint, payload }) + '\n', 'utf-8');
  }
  const counterFile = process.env.GH_STUB_REVIEW_COUNTER_FILE;
  const id = counterFile ? nextCounter(counterFile, 9000) : 9001;
  process.stdout.write(JSON.stringify({ id, html_url: 'https://example.invalid/review/' + id }));
  process.exit(0);
}

process.stderr.write('Unhandled gh api endpoint: ' + endpoint + ' method=' + method + '\n');
process.exit(1);
`;

  writeFileSync(binPath, script, 'utf-8');
  chmodSync(binPath, 0o755);
}

function setImportComments(importFile: string, comments: unknown[]): void {
  writeFileSync(importFile, JSON.stringify(comments), 'utf-8');
}

function setImportPayload(importFile: string, payload: unknown): void {
  writeFileSync(importFile, JSON.stringify(payload), 'utf-8');
}

function readPayloadLog(payloadLog: string): Array<{ kind: string; endpoint: string; payload: any }> {
  if (!existsSync(payloadLog)) return [];
  const raw = readFileSync(payloadLog, 'utf-8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('github-review sync behavior', () => {
  let envSnapshot: EnvSnapshot;
  let tempRoot: string;
  let workspacePath: string;
  let importFile: string;
  let callLog: string;
  let payloadLog: string;
  let replyCounter: string;
  let reviewCounter: string;

  beforeEach(() => {
    envSnapshot = captureEnv();

    tempRoot = mkdtempSync(join(tmpdir(), 'github-review-sync-'));
    workspacePath = join(tempRoot, 'workspace');
    const binDir = join(tempRoot, 'bin');
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    importFile = join(tempRoot, 'import-comments.json');
    callLog = join(tempRoot, 'gh-calls.log');
    payloadLog = join(tempRoot, 'gh-payloads.log');
    replyCounter = join(tempRoot, 'reply-counter.txt');
    reviewCounter = join(tempRoot, 'review-counter.txt');

    setImportComments(importFile, []);
    writeFileSync(callLog, '', 'utf-8');
    writeFileSync(payloadLog, '', 'utf-8');

    const ghPath = join(binDir, 'gh');
    writeGhStub(ghPath);

    process.env.PATH = `${binDir}:${envSnapshot.PATH ?? ''}`;
    process.env.GH_STUB_IMPORT_FILE = importFile;
    process.env.GH_STUB_CALL_LOG = callLog;
    process.env.GH_STUB_PAYLOAD_LOG = payloadLog;
    process.env.GH_STUB_REPLY_COUNTER_FILE = replyCounter;
    process.env.GH_STUB_REVIEW_COUNTER_FILE = reviewCounter;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('imports incrementally without duplicating existing comments', async () => {
    setImportComments(importFile, [
      {
        id: 101,
        body: 'Root from GitHub',
        path: 'src/main.ts',
        line: 12,
        original_line: 12,
        side: 'RIGHT',
        start_line: 12,
        original_start_line: 12,
        diff_hunk: '@@ -10,2 +10,3 @@ context',
        user: { login: 'octocat' },
        created_at: '2026-02-19T10:00:00Z',
        pull_request_review_id: 10,
      },
    ]);

    const first = await importGitHubReview(workspacePath, WORKSPACE_NAME, BASE_BRANCH, PR_NUMBER);
    expect(first.imported).toBe(1);
    expect(first.threads).toHaveLength(1);
    expect(first.threads[0]?.comments).toHaveLength(1);

    setImportComments(importFile, [
      {
        id: 101,
        body: 'Root from GitHub',
        path: 'src/main.ts',
        line: 12,
        original_line: 12,
        side: 'RIGHT',
        start_line: 12,
        original_start_line: 12,
        diff_hunk: '@@ -10,2 +10,3 @@ context',
        user: { login: 'octocat' },
        created_at: '2026-02-19T10:00:00Z',
        pull_request_review_id: 10,
      },
      {
        id: 102,
        body: 'Follow-up reply from GitHub',
        path: 'src/main.ts',
        line: 12,
        original_line: 12,
        side: 'RIGHT',
        start_line: 12,
        original_start_line: 12,
        diff_hunk: '@@ -10,2 +10,3 @@ context',
        user: { login: 'maintainer' },
        created_at: '2026-02-19T11:00:00Z',
        in_reply_to_id: 101,
        pull_request_review_id: 10,
      },
    ]);

    const second = await importGitHubReview(workspacePath, WORKSPACE_NAME, BASE_BRANCH, PR_NUMBER);
    expect(second.imported).toBe(0);
    expect(second.threads).toHaveLength(1);
    expect(second.threads[0]?.comments).toHaveLength(2);

    const third = await importGitHubReview(workspacePath, WORKSPACE_NAME, BASE_BRANCH, PR_NUMBER);
    expect(third.imported).toBe(0);
    expect(third.threads[0]?.comments).toHaveLength(2);
  });

  it('imports paginated slurp responses by flattening pages', async () => {
    setImportPayload(importFile, [
      [
        {
          id: 401,
          body: 'Page one comment',
          path: 'src/one.ts',
          line: 3,
          original_line: 3,
          side: 'RIGHT',
          start_line: 3,
          original_start_line: 3,
          diff_hunk: '@@ -1,1 +1,3 @@',
          user: { login: 'alice' },
          created_at: '2026-02-19T15:00:00Z',
          pull_request_review_id: 30,
        },
      ],
      [
        {
          id: 402,
          body: 'Page two comment',
          path: 'src/two.ts',
          line: 9,
          original_line: 9,
          side: 'RIGHT',
          start_line: 9,
          original_start_line: 9,
          diff_hunk: '@@ -8,1 +8,2 @@',
          user: { login: 'bob' },
          created_at: '2026-02-19T15:05:00Z',
          pull_request_review_id: 30,
        },
      ],
    ]);

    const result = await importGitHubReview(workspacePath, WORKSPACE_NAME, BASE_BRANCH, PR_NUMBER);
    expect(result.imported).toBe(2);
    expect(result.threads).toHaveLength(2);
  });

  it('pushes only unsynced local comments and avoids replay on repeat push', async () => {
    setImportComments(importFile, [
      {
        id: 201,
        body: 'Imported root comment',
        path: 'src/main.ts',
        line: 8,
        original_line: 8,
        side: 'RIGHT',
        start_line: 8,
        original_start_line: 8,
        diff_hunk: '@@ -6,2 +6,3 @@ context',
        user: { login: 'octocat' },
        created_at: '2026-02-19T12:00:00Z',
        pull_request_review_id: 20,
      },
    ]);

    await importGitHubReview(workspacePath, WORKSPACE_NAME, BASE_BRANCH, PR_NUMBER);

    const session = readReviewSession(workspacePath, WORKSPACE_NAME, BASE_BRANCH);
    const importedThread = session.threads[0] as ReviewThread;
    importedThread.comments.push({
      id: 'local-reply-1',
      threadId: importedThread.id,
      body: 'Local reply back to the imported thread',
      author: 'local',
      createdAt: '2026-02-19T12:30:00Z',
    });

    session.threads.push({
      id: 'local-line-thread',
      target: {
        kind: 'line',
        file: 'src/feature.ts',
        startLine: 14,
        endLine: 16,
        side: 'RIGHT',
      },
      resolved: false,
      comments: [
        {
          id: 'local-line-root',
          threadId: 'local-line-thread',
          body: 'A brand new local review note',
          author: 'local',
          createdAt: '2026-02-19T12:31:00Z',
        },
      ],
      createdAt: '2026-02-19T12:31:00Z',
      updatedAt: '2026-02-19T12:31:00Z',
    });

    writeReviewSession(workspacePath, WORKSPACE_NAME, session);

    const pushed = await pushGitHubReview(workspacePath, WORKSPACE_NAME, BASE_BRANCH, PR_NUMBER);
    expect(pushed.prNumber).toBe(PR_NUMBER);
    expect(pushed.url).toContain('review');

    const payloads = readPayloadLog(payloadLog);
    const replyPayload = payloads.find((entry) => entry.kind === 'reply');
    const reviewPayload = payloads.find((entry) => entry.kind === 'review');

    expect(replyPayload).toBeDefined();
    expect(replyPayload?.payload.in_reply_to).toBe(201);
    expect(replyPayload?.payload.body).toBe('Local reply back to the imported thread');

    expect(reviewPayload).toBeDefined();
    expect(Array.isArray(reviewPayload?.payload.comments)).toBe(true);
    expect(reviewPayload?.payload.comments).toHaveLength(1);
    expect(reviewPayload?.payload.comments[0]?.body).toContain('A brand new local review note');
    expect(reviewPayload?.payload.comments[0]?.body).not.toContain('Imported root comment');
    expect(reviewPayload?.payload.comments[0]?.start_line).toBe(14);
    expect(reviewPayload?.payload.comments[0]?.start_side).toBe('RIGHT');

    const afterFirstPush = readReviewSession(workspacePath, WORKSPACE_NAME, BASE_BRANCH);
    const pushedImportedReply = afterFirstPush.threads
      .flatMap((thread) => thread.comments)
      .find((comment) => comment.id === 'local-reply-1') as ReviewComment;
    expect(pushedImportedReply.githubId).toBeDefined();
    expect(pushedImportedReply.syncedToGitHubAt).toBeDefined();

    const pushedLocalLineRoot = afterFirstPush.threads
      .flatMap((thread) => thread.comments)
      .find((comment) => comment.id === 'local-line-root') as ReviewComment;
    expect(pushedLocalLineRoot.githubId).toBeUndefined();
    expect(pushedLocalLineRoot.syncedToGitHubAt).toBeDefined();

    writeFileSync(payloadLog, '', 'utf-8');
    const secondPush = await pushGitHubReview(workspacePath, WORKSPACE_NAME, BASE_BRANCH, PR_NUMBER);
    expect(secondPush.url).toContain(`/pull/${PR_NUMBER}`);

    const payloadsAfterSecondPush = readPayloadLog(payloadLog);
    expect(payloadsAfterSecondPush).toHaveLength(0);
  });
});
