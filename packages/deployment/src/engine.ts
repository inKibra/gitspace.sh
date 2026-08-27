import { Result, TaggedError, type Result as ResultType } from 'better-result';
import { verifyDeploymentPlan, type DeploymentArtifact, type DeploymentPlan, type EntrypointId } from './contracts.js';
import { DeploymentJournal, type DeploymentRunRecord, type DeploymentStepState } from './journal.js';

export type ReplacementPhase = 'drain' | 'stage' | 'activate' | 'health' | 'commit' | 'rollback';

export class ReplacementActionError extends TaggedError('ReplacementActionError')<{
  entrypoint: EntrypointId;
  phase: ReplacementPhase;
  message: string;
}> {}

export class DeploymentExecutionError extends TaggedError('DeploymentExecutionError')<{
  deploymentId: string;
  entrypoint?: EntrypointId;
  phase?: ReplacementPhase;
  message: string;
}> {}

export interface ReplacementContext {
  plan: DeploymentPlan;
  artifact: DeploymentArtifact;
  ordinal: number;
  attempt: number;
}

export interface ReplacementDriver {
  readonly entrypoint: EntrypointId;
  drain(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>>;
  stage(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>>;
  activate(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>>;
  health(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>>;
  commit(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>>;
  rollback(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>>;
}

function needsRollback(state: DeploymentStepState): boolean {
  return state === 'staged' || state === 'activated' || state === 'healthy' || state === 'committed';
}

export class DeploymentEngine {
  private readonly drivers: Map<EntrypointId, ReplacementDriver>;

  constructor(
    private readonly journal: DeploymentJournal,
    drivers: readonly ReplacementDriver[],
  ) {
    this.drivers = new Map(drivers.map((driver) => [driver.entrypoint, driver]));
    if (this.drivers.size !== drivers.length) throw new Error('Replacement drivers contain duplicate entrypoints');
  }

  async execute(plan: DeploymentPlan): Promise<ResultType<DeploymentRunRecord, DeploymentExecutionError>> {
    const verified = await verifyDeploymentPlan(plan);
    if (verified.status === 'error') {
      return Result.err(new DeploymentExecutionError({ deploymentId: plan.id, message: verified.error.message }));
    }
    for (const artifact of plan.artifacts) {
      if (!this.drivers.has(artifact.entrypoint)) {
        return Result.err(new DeploymentExecutionError({
          deploymentId: plan.id,
          entrypoint: artifact.entrypoint,
          message: `No replacement driver registered for ${artifact.entrypoint}`,
        }));
      }
    }

    const begun = this.journal.begin(plan);
    if (begun.status === 'error') {
      return Result.err(new DeploymentExecutionError({ deploymentId: plan.id, message: begun.error.message }));
    }
    if (begun.value.state === 'committed') return Result.ok(begun.value);
    if (!['planned', 'rolled-back', 'failed'].includes(begun.value.state)) {
      const recovered = await this.rollbackRecordedAttempt(plan, begun.value);
      if (recovered.status === 'error') return recovered;
      this.journal.restart(plan.id);
    } else if (begun.value.state !== 'planned') {
      this.journal.restart(plan.id);
    }

    const run = this.journal.load(plan.id)!;
    for (const [ordinal, artifact] of plan.artifacts.entries()) {
      this.journal.recordStep(plan.id, artifact.entrypoint, ordinal, 'pending');
    }

    const phases: Array<{
      runState: 'draining' | 'staging' | 'activating' | 'health-checking';
      action: Exclude<ReplacementPhase, 'commit' | 'rollback'>;
      stepState: Exclude<DeploymentStepState, 'pending' | 'committed' | 'rolled-back'>;
    }> = [
      { runState: 'draining', action: 'drain', stepState: 'drained' },
      { runState: 'staging', action: 'stage', stepState: 'staged' },
      { runState: 'activating', action: 'activate', stepState: 'activated' },
      { runState: 'health-checking', action: 'health', stepState: 'healthy' },
    ];

    for (const phase of phases) {
      this.journal.transition(plan.id, phase.runState);
      for (const [ordinal, artifact] of plan.artifacts.entries()) {
        const context: ReplacementContext = { plan, artifact, ordinal, attempt: run.attempt };
        const result = await this.invoke(this.drivers.get(artifact.entrypoint)!, phase.action, context);
        if (result.status === 'error') return this.failAndRollback(plan, result.error);
        this.journal.recordStep(plan.id, artifact.entrypoint, ordinal, phase.stepState);
      }
    }

    for (const [ordinal, artifact] of plan.artifacts.entries()) {
      const context: ReplacementContext = { plan, artifact, ordinal, attempt: run.attempt };
      const committed = await this.invoke(this.drivers.get(artifact.entrypoint)!, 'commit', context);
      if (committed.status === 'error') return this.failAndRollback(plan, committed.error);
      this.journal.recordStep(plan.id, artifact.entrypoint, ordinal, 'committed');
    }
    return Result.ok(this.journal.transition(plan.id, 'committed'));
  }

  private async invoke(
    driver: ReplacementDriver,
    phase: ReplacementPhase,
    context: ReplacementContext,
  ): Promise<ResultType<void, ReplacementActionError>> {
    try {
      return await driver[phase](context);
    } catch (error) {
      return Result.err(new ReplacementActionError({
        entrypoint: driver.entrypoint,
        phase,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async failAndRollback(
    plan: DeploymentPlan,
    failure: ReplacementActionError,
  ): Promise<ResultType<DeploymentRunRecord, DeploymentExecutionError>> {
    this.journal.transition(plan.id, 'rolling-back', failure.message);
    const steps = this.journal.steps(plan.id).filter((step) => needsRollback(step.state)).reverse();
    const rollbackErrors: string[] = [];
    for (const step of steps) {
      const artifact = plan.artifacts[step.ordinal]!;
      const context: ReplacementContext = {
        plan,
        artifact,
        ordinal: step.ordinal,
        attempt: step.attempt,
      };
      const rolledBack = await this.invoke(this.drivers.get(step.entrypoint)!, 'rollback', context);
      if (rolledBack.status === 'error') rollbackErrors.push(`${step.entrypoint}: ${rolledBack.error.message}`);
      else this.journal.recordStep(plan.id, step.entrypoint, step.ordinal, 'rolled-back');
    }
    const detail = rollbackErrors.length === 0
      ? failure.message
      : `${failure.message}; rollback errors: ${rollbackErrors.join('; ')}`;
    this.journal.transition(plan.id, rollbackErrors.length === 0 ? 'rolled-back' : 'failed', detail);
    return Result.err(new DeploymentExecutionError({
      deploymentId: plan.id,
      entrypoint: failure.entrypoint,
      phase: failure.phase,
      message: detail,
    }));
  }

  private async rollbackRecordedAttempt(
    plan: DeploymentPlan,
    run: DeploymentRunRecord,
  ): Promise<ResultType<DeploymentRunRecord, DeploymentExecutionError>> {
    this.journal.transition(plan.id, 'rolling-back', 'Recovering interrupted deployment attempt');
    const steps = this.journal.steps(plan.id).filter((step) => needsRollback(step.state)).reverse();
    for (const step of steps) {
      const artifact = plan.artifacts[step.ordinal]!;
      const context: ReplacementContext = { plan, artifact, ordinal: step.ordinal, attempt: run.attempt };
      const rolledBack = await this.invoke(this.drivers.get(step.entrypoint)!, 'rollback', context);
      if (rolledBack.status === 'error') {
        const failed = this.journal.transition(plan.id, 'failed', rolledBack.error.message);
        return Result.err(new DeploymentExecutionError({
          deploymentId: plan.id,
          entrypoint: step.entrypoint,
          phase: 'rollback',
          message: failed.error ?? rolledBack.error.message,
        }));
      }
      this.journal.recordStep(plan.id, step.entrypoint, step.ordinal, 'rolled-back');
    }
    return Result.ok(this.journal.transition(plan.id, 'rolled-back'));
  }
}
