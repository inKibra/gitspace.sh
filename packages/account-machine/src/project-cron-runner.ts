import type { ProjectCronRunView, ProjectCronTarget } from '@gitspace/protocol/cron-contract';

export interface ClaimedProjectCronRun {
  run: ProjectCronRunView;
  claimToken: string;
  leaseExpiresAt: Date;
}

export interface ResolvedCanonicalCronAgent<TAgent> {
  status: 'ready';
  agent: TAgent;
  spaceId: string;
  generation: number;
}

export interface BlockedCanonicalCronAgent {
  status: 'blocked';
  message: string;
}

export type CanonicalCronAgentResolution<TAgent> = ResolvedCanonicalCronAgent<TAgent> | BlockedCanonicalCronAgent;

export type CanonicalCronPromptResult =
  | { status: 'accepted'; message?: string }
  | { status: 'blocked'; message: string }
  | { status: 'failed'; message: string };

export interface CanonicalCronPromptInput<TAgent> {
  agent: TAgent;
  spaceId: string;
  generation: number;
  runId: string;
  prompt: string;
  readScopes: readonly string[];
  writeScopes: readonly string[];
}

export interface ProjectCronRunCompletion {
  projectId: string;
  runId: string;
  claimToken: string;
  state: 'succeeded' | 'blocked' | 'failed';
  message: string | null;
  resolvedSpaceId: string | null;
  resolvedGeneration: number | null;
}

export interface ProjectCronExecutionAdapter<TAgent> {
  resolveCanonicalAgent(target: ProjectCronTarget): Promise<CanonicalCronAgentResolution<TAgent>>;
  promptCanonicalAgent(input: CanonicalCronPromptInput<TAgent>): Promise<CanonicalCronPromptResult>;
  completeRun(input: ProjectCronRunCompletion): Promise<ProjectCronRunView>;
}

export interface ProjectCronRunnerAdapter<TAgent> extends ProjectCronExecutionAdapter<TAgent> {
  claimNext(input: { projectId: string; claimedBy: string }): Promise<ClaimedProjectCronRun | null>;
}


export function buildProjectCronPrompt(run: ProjectCronRunView): string {
  const target = run.target.scope === 'project'
    ? `project ${run.target.projectId}`
    : `workspace ${run.target.spaceId} in project ${run.target.projectId}`;
  const readScopes = run.readScopes.length === 0 ? 'none' : run.readScopes.join(', ');
  const writeScopes = run.writeScopes.length === 0 ? 'none' : run.writeScopes.join(', ');
  return [
    run.prompt.trim(),
    '',
    `This is an unattended ${run.trigger} run of project cron "${run.cronName}" (${run.schedule}).`,
    `Stable target: ${target}. Run id: ${run.id}.`,
    `Explicit read scopes: ${readScopes}.`,
    `Explicit write scopes: ${writeScopes}.`,
    'Do not read or write outside those authority scopes. A missing capability is a blocked run, not permission to widen scope.',
  ].join('\n');
}

async function finishFailure<TAgent>(
  claim: ClaimedProjectCronRun,
  adapter: ProjectCronExecutionAdapter<TAgent>,
  message: string,
  resolved: ResolvedCanonicalCronAgent<TAgent> | null,
): Promise<ProjectCronRunView> {
  return adapter.completeRun({
    projectId: claim.run.projectId,
    runId: claim.run.id,
    claimToken: claim.claimToken,
    state: 'failed',
    message,
    resolvedSpaceId: resolved?.spaceId ?? null,
    resolvedGeneration: resolved?.generation ?? null,
  });
}

export async function runClaimedProjectCron<TAgent>(
  claim: ClaimedProjectCronRun,
  adapter: ProjectCronExecutionAdapter<TAgent>,
): Promise<ProjectCronRunView> {
  const { run } = claim;
  if (run.state !== 'running') throw new Error(`Project cron run ${run.id} must be claimed before execution`);
  if (run.target.projectId !== run.projectId) throw new Error(`Project cron run ${run.id} targets another project`);
  if (claim.leaseExpiresAt.getTime() <= Date.now()) {
    return finishFailure(claim, adapter, 'Cron claim expired before execution began', null);
  }

  let resolution: CanonicalCronAgentResolution<TAgent>;
  try {
    resolution = await adapter.resolveCanonicalAgent(run.target);
  } catch (error) {
    return finishFailure(claim, adapter, `Canonical agent resolution failed: ${error instanceof Error ? error.message : String(error)}`, null);
  }
  if (resolution.status === 'blocked') {
    return adapter.completeRun({
      projectId: run.projectId,
      runId: run.id,
      claimToken: claim.claimToken,
      state: 'blocked',
      message: resolution.message,
      resolvedSpaceId: null,
      resolvedGeneration: null,
    });
  }
  if (!Number.isSafeInteger(resolution.generation) || resolution.generation < 1 || !resolution.spaceId) {
    return finishFailure(claim, adapter, 'Canonical agent resolution returned an invalid space identity', null);
  }

  let outcome: CanonicalCronPromptResult;
  try {
    outcome = await adapter.promptCanonicalAgent({
      agent: resolution.agent,
      spaceId: resolution.spaceId,
      generation: resolution.generation,
      runId: run.id,
      prompt: buildProjectCronPrompt(run),
      readScopes: run.readScopes,
      writeScopes: run.writeScopes,
    });
  } catch (error) {
    return finishFailure(claim, adapter, `Canonical agent prompt failed: ${error instanceof Error ? error.message : String(error)}`, resolution);
  }

  return adapter.completeRun({
    projectId: run.projectId,
    runId: run.id,
    claimToken: claim.claimToken,
    state: outcome.status === 'accepted' ? 'succeeded' : outcome.status,
    message: outcome.status === 'accepted' ? outcome.message ?? null : outcome.message,
    resolvedSpaceId: resolution.spaceId,
    resolvedGeneration: resolution.generation,
  });
}

export async function runNextProjectCron<TAgent>(
  projectId: string,
  claimedBy: string,
  adapter: ProjectCronRunnerAdapter<TAgent>,
): Promise<ProjectCronRunView | null> {
  const claim = await adapter.claimNext({ projectId, claimedBy });
  return claim ? runClaimedProjectCron(claim, adapter) : null;
}
