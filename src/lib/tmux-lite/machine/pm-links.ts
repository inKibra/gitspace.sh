import { exec } from 'child_process';
import { promisify } from 'util';
import { getLinearConfig, fetchLinearIssueByIdentifier } from '../../../core/linear.js';
import { escapeShellArg } from '../../../utils/shell-escape.js';
import { checkCommandExists } from '../../../utils/deps.js';
import type { WorkspaceRuntimeRecord } from '../protocol.js';
import type {
  MachinePullRequestReviewDecision,
  MachineWorkspaceLinearSyncState,
  MachineWorkspaceLinearRecord,
  MachineWorkspacePmActor,
  MachineWorkspacePullRequestSyncState,
  MachineWorkspacePullRequestRecord,
} from './types.js';

const execAsync = promisify(exec);
const REFRESH_TTL_MS = 5 * 60 * 1000;

type WorkspacePmState = {
  pullRequest: MachineWorkspacePullRequestRecord;
  linear: MachineWorkspaceLinearRecord;
};

type CacheEntry = {
  fingerprint: string;
  refreshedAt: number;
  data: WorkspacePmState;
};

interface GitHubActorPayload {
  login?: string;
  html_url?: string;
}

interface GitHubPullRequestPayload {
  number: number;
  html_url: string;
  title: string;
  state: 'open' | 'closed';
  merged_at?: string | null;
  draft?: boolean;
  user?: GitHubActorPayload;
  requested_reviewers?: GitHubActorPayload[];
}

interface GitHubReviewPayload {
  state?: string;
  submitted_at?: string | null;
  user?: GitHubActorPayload;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let gitHubAccessCache:
  | { checkedAt: number; value: { ok: true } | { ok: false; state: MachineWorkspacePullRequestSyncState; message: string } }
  | null = null;
let gitHubAccessInflight: Promise<{ ok: true } | { ok: false; state: MachineWorkspacePullRequestSyncState; message: string }> | null = null;

function buildFingerprint(workspace: WorkspaceRuntimeRecord): string {
  return [workspace.projectName, workspace.name, workspace.path, workspace.branch ?? ''].join('::');
}

function buildPullRequestSeed(workspace: WorkspaceRuntimeRecord): MachineWorkspacePullRequestRecord {
  return {
    syncState: workspace.branch ? 'loading' : 'not_found',
    reviewers: [],
    requestedReviewers: [],
    changesRequestedBy: [],
  };
}

function extractIssueIdentifier(workspace: WorkspaceRuntimeRecord): string | null {
  const match = (workspace.branch ?? workspace.name).match(/([a-z][a-z0-9]+-\d+)/i);
  return match?.[1] ? match[1].toUpperCase() : null;
}

function buildLinearSeed(workspace: WorkspaceRuntimeRecord): MachineWorkspaceLinearRecord {
  const identifier = extractIssueIdentifier(workspace);
  return {
    syncState: identifier ? 'loading' : 'identifier_missing',
    identifier: identifier ?? undefined,
  };
}

function buildSeedState(workspace: WorkspaceRuntimeRecord): WorkspacePmState {
  return {
    pullRequest: buildPullRequestSeed(workspace),
    linear: buildLinearSeed(workspace),
  };
}

function normalizeGitHubActor(actor: GitHubActorPayload | undefined): MachineWorkspacePmActor | undefined {
  const login = actor?.login?.trim();
  if (!login) {
    return undefined;
  }
  return {
    login,
    url: actor?.html_url,
  };
}

function upsertActor(map: Map<string, MachineWorkspacePmActor>, actor: MachineWorkspacePmActor | undefined): void {
  if (!actor) {
    return;
  }
  map.set(actor.login, actor);
}

function toArray(map: Map<string, MachineWorkspacePmActor>): MachineWorkspacePmActor[] {
  return [...map.values()].sort((a, b) => a.login.localeCompare(b.login));
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getGitHubAccessState(): Promise<
  { ok: true }
  | { ok: false; state: MachineWorkspacePullRequestSyncState; message: string }
> {
  const now = Date.now();
  if (gitHubAccessCache && now - gitHubAccessCache.checkedAt < REFRESH_TTL_MS) {
    return gitHubAccessCache.value;
  }

  if (gitHubAccessInflight) {
    return gitHubAccessInflight;
  }

  gitHubAccessInflight = (async () => {
    if (!(await checkCommandExists('gh'))) {
      return {
        ok: false as const,
        state: 'cli_missing' as const,
        message: 'GitHub CLI not installed on this machine',
      };
    }

    try {
      await execAsync('gh auth status', { timeout: 15000 });
      return { ok: true as const };
    } catch {
      return {
        ok: false as const,
        state: 'unauthenticated' as const,
        message: 'Run gh auth login on this machine',
      };
    }
  })();

  try {
    const value = await gitHubAccessInflight;
    gitHubAccessCache = { checkedAt: now, value };
    return value;
  } finally {
    gitHubAccessInflight = null;
  }
}

function buildPullRequestState(params: {
  syncState: MachineWorkspacePullRequestSyncState;
  checkedAt: string;
  errorMessage?: string;
}): MachineWorkspacePullRequestRecord {
  return {
    syncState: params.syncState,
    checkedAt: params.checkedAt,
    errorMessage: params.errorMessage,
    reviewers: [],
    requestedReviewers: [],
    changesRequestedBy: [],
  };
}

function buildLinearState(params: {
  syncState: MachineWorkspaceLinearSyncState;
  checkedAt: string;
  identifier?: string;
  errorMessage?: string;
}): MachineWorkspaceLinearRecord {
  return {
    syncState: params.syncState,
    checkedAt: params.checkedAt,
    identifier: params.identifier,
    errorMessage: params.errorMessage,
  };
}

async function detectPrNumber(workspacePath: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync('gh pr view --json number --jq .number', {
      cwd: workspacePath,
      timeout: 15000,
    });
    const num = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(num) ? null : num;
  } catch {
    return null;
  }
}

async function getRepoCoordinates(cwd: string): Promise<{ owner: string; repo: string }> {
  const { stdout } = await execAsync(
    `gh repo view --json owner,name --jq '.owner.login + "/" + .name'`,
    { cwd },
  );
  const trimmed = stdout.trim();
  const [owner, repo] = trimmed.split('/');
  if (!owner || !repo) {
    throw new Error(`Could not resolve repository for ${cwd}`);
  }
  return { owner, repo };
}

async function fetchGitHubApi<T>(endpoint: string, cwd: string): Promise<T> {
  const { stdout } = await execAsync(`gh api ${escapeShellArg(endpoint)}`, { cwd });
  return JSON.parse(stdout) as T;
}

async function fetchPaginatedGitHubApi<T>(endpoint: string, cwd: string): Promise<T[]> {
  const { stdout } = await execAsync(
    `gh api ${escapeShellArg(endpoint)} --paginate --slurp`,
    { cwd },
  );
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  if (parsed.length === 0) {
    return [];
  }
  if (Array.isArray(parsed[0])) {
    return (parsed as T[][]).flat();
  }
  return parsed as T[];
}

function computeReviewState(reviews: GitHubReviewPayload[]): {
  reviewers: MachineWorkspacePmActor[];
  changesRequestedBy: MachineWorkspacePmActor[];
  reviewDecision?: MachinePullRequestReviewDecision;
} {
  const latestByReviewer = new Map<string, { actor: MachineWorkspacePmActor; state: string }>();

  for (const review of reviews) {
    const actor = normalizeGitHubActor(review.user);
    if (!actor) {
      continue;
    }
    const state = review.state?.toUpperCase();
    if (!state || state === 'PENDING') {
      continue;
    }
    if (state === 'DISMISSED') {
      latestByReviewer.delete(actor.login);
      continue;
    }
    latestByReviewer.set(actor.login, { actor, state });
  }

  const reviewers = toArray(new Map(
    [...latestByReviewer.values()].map((entry) => [entry.actor.login, entry.actor]),
  ));
  const changesRequestedBy = [...latestByReviewer.values()]
    .filter((entry) => entry.state === 'CHANGES_REQUESTED')
    .map((entry) => entry.actor)
    .sort((a, b) => a.login.localeCompare(b.login));
  const hasApproval = [...latestByReviewer.values()].some((entry) => entry.state === 'APPROVED');

  let reviewDecision: MachinePullRequestReviewDecision | undefined;
  if (changesRequestedBy.length > 0) {
    reviewDecision = 'changes_requested';
  } else if (hasApproval) {
    reviewDecision = 'approved';
  } else if (reviewers.length > 0) {
    reviewDecision = 'review_required';
  }

  return {
    reviewers,
    changesRequestedBy,
    reviewDecision,
  };
}

async function resolvePullRequest(workspace: WorkspaceRuntimeRecord): Promise<MachineWorkspacePullRequestRecord> {
  const checkedAt = new Date().toISOString();
  if (!workspace.branch) {
    return buildPullRequestState({ syncState: 'not_found', checkedAt });
  }

  try {
    const access = await getGitHubAccessState();
    if (!access.ok) {
      return buildPullRequestState({
        syncState: access.state,
        checkedAt,
        errorMessage: access.message,
      });
    }

    const prNumber = await detectPrNumber(workspace.path);
    if (!prNumber) {
      return buildPullRequestState({ syncState: 'not_found', checkedAt });
    }

    const { owner, repo } = await getRepoCoordinates(workspace.path);
    const [pullRequest, reviews] = await Promise.all([
      fetchGitHubApi<GitHubPullRequestPayload>(`repos/${owner}/${repo}/pulls/${prNumber}`, workspace.path),
      fetchPaginatedGitHubApi<GitHubReviewPayload>(`repos/${owner}/${repo}/pulls/${prNumber}/reviews`, workspace.path),
    ]);

    const requestedReviewers = new Map<string, MachineWorkspacePmActor>();
    for (const actor of pullRequest.requested_reviewers ?? []) {
      upsertActor(requestedReviewers, normalizeGitHubActor(actor));
    }

    const reviewState = computeReviewState(reviews);
    const reviewDecision = reviewState.reviewDecision
      ?? (requestedReviewers.size > 0 || pullRequest.state === 'open' ? 'review_required' : undefined);

    return {
      syncState: 'ready',
      checkedAt,
      number: pullRequest.number,
      url: pullRequest.html_url,
      title: pullRequest.title,
      state: pullRequest.merged_at ? 'merged' : pullRequest.state,
      isDraft: pullRequest.draft === true,
      author: normalizeGitHubActor(pullRequest.user),
      reviewers: reviewState.reviewers,
      requestedReviewers: toArray(requestedReviewers),
      changesRequestedBy: reviewState.changesRequestedBy,
      reviewDecision,
    };
  } catch (error) {
    return buildPullRequestState({
      syncState: 'unavailable',
      checkedAt,
      errorMessage: formatErrorMessage(error),
    });
  }
}

async function resolveLinearIssue(workspace: WorkspaceRuntimeRecord): Promise<MachineWorkspaceLinearRecord> {
  const checkedAt = new Date().toISOString();
  const identifier = extractIssueIdentifier(workspace);
  if (!identifier) {
    return buildLinearState({
      syncState: 'identifier_missing',
      checkedAt,
      errorMessage: 'No Linear issue key in branch or workspace name',
    });
  }

  try {
    const config = await getLinearConfig(workspace.projectName);
    if (!config.apiKey || config.teamKeys.length === 0) {
      return buildLinearState({
        syncState: 'unconfigured',
        checkedAt,
        identifier,
        errorMessage: 'Linear not configured for this machine/project',
      });
    }

    const issue = await fetchLinearIssueByIdentifier(config.apiKey, identifier);
    if (!issue) {
      return buildLinearState({
        syncState: 'not_found',
        checkedAt,
        identifier,
        errorMessage: 'Linear issue not found',
      });
    }

    return {
      syncState: 'ready',
      checkedAt,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      stateName: issue.stateName ?? undefined,
    };
  } catch (error) {
    return buildLinearState({
      syncState: 'unavailable',
      checkedAt,
      identifier,
      errorMessage: formatErrorMessage(error),
    });
  }
}

async function resolveWorkspacePmState(workspace: WorkspaceRuntimeRecord): Promise<WorkspacePmState> {
  const [pullRequest, linear] = await Promise.all([
    resolvePullRequest(workspace),
    resolveLinearIssue(workspace),
  ]);
  return { pullRequest, linear };
}

function emitUpdates(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // non-fatal
    }
  }
}

async function refreshWorkspacePmState(workspace: WorkspaceRuntimeRecord, fingerprint: string): Promise<void> {
  const next = await resolveWorkspacePmState(workspace);
  const previous = cache.get(workspace.id);
  if (previous && previous.fingerprint !== fingerprint) {
    return;
  }

  const nextEntry: CacheEntry = {
    fingerprint,
    refreshedAt: Date.now(),
    data: next,
  };
  const changed = !previous || JSON.stringify(previous.data) !== JSON.stringify(next);
  cache.set(workspace.id, nextEntry);
  if (changed) {
    emitUpdates();
  }
}

function scheduleWorkspacePmRefresh(workspace: WorkspaceRuntimeRecord, fingerprint: string): void {
  if (inflight.has(workspace.id)) {
    return;
  }
  const promise = refreshWorkspacePmState(workspace, fingerprint)
    .catch(() => {
      // resolveWorkspacePmState already converts expected failures into structured states
    })
    .finally(() => {
      inflight.delete(workspace.id);
    });
  inflight.set(workspace.id, promise);
}

export function subscribeWorkspacePmUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWorkspacePmSnapshot(workspaces: WorkspaceRuntimeRecord[]): Record<string, WorkspacePmState> {
  const now = Date.now();
  const activeIds = new Set(workspaces.map((workspace) => workspace.id));

  for (const workspaceId of cache.keys()) {
    if (!activeIds.has(workspaceId)) {
      cache.delete(workspaceId);
    }
  }

  const snapshot: Record<string, WorkspacePmState> = {};
  for (const workspace of workspaces) {
    const fingerprint = buildFingerprint(workspace);
    const entry = cache.get(workspace.id);

    if (!entry || entry.fingerprint !== fingerprint) {
      const seeded = buildSeedState(workspace);
      cache.set(workspace.id, {
        fingerprint,
        refreshedAt: 0,
        data: seeded,
      });
      snapshot[workspace.id] = seeded;
      scheduleWorkspacePmRefresh(workspace, fingerprint);
      continue;
    }

    snapshot[workspace.id] = entry.data;
    if (now - entry.refreshedAt > REFRESH_TTL_MS) {
      scheduleWorkspacePmRefresh(workspace, fingerprint);
    }
  }

  return snapshot;
}
