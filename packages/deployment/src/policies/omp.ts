import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Result, type Result as ResultType } from 'better-result';
import { z } from 'zod';
import type { EntrypointId } from '../contracts.js';
import type { ReplacementContext, ReplacementDriver } from '../engine.js';
import { ReplacementActionError } from '../engine.js';
import { actionFailure, atomicWrite, copyArtifact, hashArtifactPath, verifyArtifact } from './shared.js';

const generationPointerSchema = z.object({
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  artifactPath: z.string().min(1),
});
export type OmpGenerationPointer = z.infer<typeof generationPointerSchema>;

export interface OmpWorkerReplacementHost {
  stopAdmissions(): Promise<void>;
  pauseAgentTree(): Promise<void>;
  awaitAgentTreeSettled(): Promise<void>;
  persistSessions(): Promise<void>;
  currentWorkerGeneration(): Promise<OmpGenerationPointer | null>;
  startProbe(next: OmpGenerationPointer): Promise<void>;
  probeWorker(next: OmpGenerationPointer): Promise<void>;
  activateWorkerGeneration(next: OmpGenerationPointer, previous: OmpGenerationPointer | null): Promise<void>;
  restoreWorkerGeneration(previous: OmpGenerationPointer | null): Promise<void>;
  reopenDrainedSessions(): Promise<void>;
  stopProbe(next: OmpGenerationPointer): Promise<void>;
  resumeAdmissions(): Promise<void>;
}

export interface OmpBrokerReplacementHost {
  stopAdmissions(): Promise<void>;
  listInteractivePtys(): Promise<string[]>;
  persistMetadata(): Promise<void>;
  currentBrokerGeneration(): Promise<OmpGenerationPointer | null>;
  stopBroker(generation: OmpGenerationPointer | null): Promise<void>;
  startBroker(next: OmpGenerationPointer): Promise<void>;
  reAdoptDetached(): Promise<void>;
  probeBroker(next: OmpGenerationPointer): Promise<void>;
  activateBrokerGeneration(next: OmpGenerationPointer): Promise<void>;
  restoreBrokerGeneration(previous: OmpGenerationPointer | null): Promise<void>;
  resumeAdmissions(): Promise<void>;
}

abstract class OmpGenerationDriver implements ReplacementDriver {
  abstract readonly entrypoint: EntrypointId;

  constructor(protected readonly environmentRoot: string) {}

  abstract drain(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>>;
  abstract activate(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>>;
  abstract health(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>>;
  abstract commit(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>>;
  abstract finalize(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>>;
  abstract rollback(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>>;

  async stage(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    const verified = await verifyArtifact(context.artifact, 'stage');
    if (verified.status === 'error') return verified;
    try {
      const next = await this.nextPointer(context);
      await mkdir(join(this.environmentRoot, 'omp', this.entrypoint, 'generations'), { recursive: true });
      try {
        const existingHash = await hashArtifactPath(next.artifactPath);
        if (existingHash !== context.artifact.hash) throw new Error(`Existing ${this.entrypoint} generation has the wrong hash`);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          await copyArtifact(context.artifact.path, next.artifactPath);
        } else {
          throw error;
        }
      }
      await atomicWrite(this.rollbackPath(context), JSON.stringify(await this.currentGeneration()));
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'stage', error);
    }
  }

  protected abstract currentGeneration(): Promise<OmpGenerationPointer | null>;

  protected async nextPointer(context: ReplacementContext): Promise<OmpGenerationPointer> {
    const generation = context.artifact.hash.slice('sha256:'.length);
    const metadata = await stat(context.artifact.path);
    return {
      hash: context.artifact.hash,
      artifactPath: join(
        this.environmentRoot,
        'omp',
        this.entrypoint,
        'generations',
        generation,
        metadata.isDirectory() ? 'runtime' : basename(context.artifact.path),
      ),
    };
  }

  protected rollbackPath(context: ReplacementContext): string {
    return join(this.environmentRoot, 'omp', this.entrypoint, `rollback-${context.plan.id}-${context.attempt}.json`);
  }

  /** Missing record means cleanup already completed; recorded null means an initial deployment. */
  protected async previousGeneration(context: ReplacementContext): Promise<OmpGenerationPointer | null | undefined> {
    try {
      return generationPointerSchema.nullable().parse(JSON.parse(await readFile(this.rollbackPath(context), 'utf8')));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
}

export class OmpWorkerReplacementDriver extends OmpGenerationDriver {
  readonly entrypoint = 'omp-worker' as const;

  constructor(environmentRoot: string, private readonly host: OmpWorkerReplacementHost) {
    super(environmentRoot);
  }

  async drain(_context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      await this.host.stopAdmissions();
      await this.host.pauseAgentTree();
      await this.host.awaitAgentTreeSettled();
      await this.host.persistSessions();
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'drain', error);
    }
  }

  async activate(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      await this.host.startProbe(await this.nextPointer(context));
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'activate', error);
    }
  }

  async health(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      await this.host.probeWorker(await this.nextPointer(context));
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'health', error);
    }
  }

  async commit(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      const next = await this.nextPointer(context);
      const previous = await this.previousGeneration(context);
      if (previous === undefined) throw new Error('OMP worker rollback record is missing');
      await this.host.activateWorkerGeneration(next, previous);
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'commit', error);
    }
  }

  async finalize(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      if (await this.previousGeneration(context) === undefined) return Result.ok(undefined);
      await this.host.reopenDrainedSessions();
      await this.host.resumeAdmissions();
      await rm(this.rollbackPath(context), { force: true });
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'finalize', error);
    }
  }

  async rollback(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      const previous = await this.previousGeneration(context);
      if (previous === undefined) return Result.ok(undefined);
      const next = await this.nextPointer(context);
      await this.host.stopProbe(next);
      await this.host.restoreWorkerGeneration(previous);
      await this.host.reopenDrainedSessions();
      await this.host.resumeAdmissions();
      await rm(this.rollbackPath(context), { force: true });
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'rollback', error);
    }
  }

  protected currentGeneration(): Promise<OmpGenerationPointer | null> {
    return this.host.currentWorkerGeneration();
  }
}

export class OmpBrokerReplacementDriver extends OmpGenerationDriver {
  readonly entrypoint = 'omp-broker' as const;

  constructor(environmentRoot: string, private readonly host: OmpBrokerReplacementHost) {
    super(environmentRoot);
  }

  async drain(_context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      await this.host.stopAdmissions();
      const interactive = await this.host.listInteractivePtys();
      if (interactive.length > 0) {
        return Result.err(new ReplacementActionError({
          entrypoint: this.entrypoint,
          phase: 'drain',
          message: `OMP broker has ${interactive.length} interactive PTY(s) without an external holder`,
        }));
      }
      await this.host.persistMetadata();
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'drain', error);
    }
  }

  async activate(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      await this.host.stopBroker(await this.currentGeneration());
      await this.host.startBroker(await this.nextPointer(context));
      await this.host.reAdoptDetached();
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'activate', error);
    }
  }

  async health(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      await this.host.probeBroker(await this.nextPointer(context));
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'health', error);
    }
  }

  async commit(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      if (await this.previousGeneration(context) === undefined) throw new Error('OMP broker rollback record is missing');
      await this.host.activateBrokerGeneration(await this.nextPointer(context));
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'commit', error);
    }
  }

  async finalize(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      if (await this.previousGeneration(context) === undefined) return Result.ok(undefined);
      await this.host.resumeAdmissions();
      await rm(this.rollbackPath(context), { force: true });
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'finalize', error);
    }
  }

  async rollback(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      const previous = await this.previousGeneration(context);
      if (previous === undefined) return Result.ok(undefined);
      await this.host.stopBroker(await this.nextPointer(context));
      await this.host.restoreBrokerGeneration(previous);
      await this.host.reAdoptDetached();
      await this.host.resumeAdmissions();
      await rm(this.rollbackPath(context), { force: true });
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'rollback', error);
    }
  }

  protected currentGeneration(): Promise<OmpGenerationPointer | null> {
    return this.host.currentBrokerGeneration();
  }
}
