import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Result, type Result as ResultType } from 'better-result';
import { z } from 'zod';
import type { ReplacementContext, ReplacementDriver } from '../engine.js';
import { ReplacementActionError } from '../engine.js';
import { actionFailure, atomicWrite, copyArtifact, hashArtifactPath, verifyArtifact } from './shared.js';

const machinePointerSchema = z.object({
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  artifactPath: z.string().min(1),
  socketPath: z.string().min(1),
});
export type MachineGenerationPointer = z.infer<typeof machinePointerSchema>;

const machineRollbackSchema = z.object({
  previous: machinePointerSchema.nullable(),
  databaseCheckpoint: z.string().min(1),
});
type MachineRollbackRecord = z.infer<typeof machineRollbackSchema>;

export interface MachineReplacementHost {
  stopAdmissions(): Promise<void>;
  drainRpc(): Promise<void>;
  drainWorkers(): Promise<void>;
  currentGeneration(): Promise<MachineGenerationPointer | null>;
  checkpointDatabase(): Promise<string>;
  migrateDatabase(nextGenerationHash: string): Promise<void>;
  restoreDatabase(checkpointId: string): Promise<void>;
  releaseDatabaseCheckpoint(checkpointId: string): Promise<void>;
  startSuccessor(next: MachineGenerationPointer): Promise<void>;
  probeSuccessor(next: MachineGenerationPointer): Promise<void>;
  switchActiveSocket(next: MachineGenerationPointer): Promise<void>;
  stopGeneration(generation: MachineGenerationPointer): Promise<void>;
  resumeAdmissions(): Promise<void>;
}

export class MachineReplacementDriver implements ReplacementDriver {
  readonly entrypoint = 'machine-daemon' as const;

  constructor(
    private readonly environmentRoot: string,
    private readonly host: MachineReplacementHost,
  ) {}

  async drain(_context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      await this.host.stopAdmissions();
      await this.host.drainRpc();
      await this.host.drainWorkers();
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'drain', error);
    }
  }

  async stage(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    const verified = await verifyArtifact(context.artifact, 'stage');
    if (verified.status === 'error') return verified;
    try {
      const next = await this.nextPointer(context);
      await mkdir(join(this.environmentRoot, 'machine', 'generations'), { recursive: true });
      try {
        const existingHash = await hashArtifactPath(next.artifactPath);
        if (existingHash !== context.artifact.hash) throw new Error('Staged machine generation has the wrong hash');
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          await copyArtifact(context.artifact.path, next.artifactPath);
        } else {
          throw error;
        }
      }
      const rollback: MachineRollbackRecord = {
        previous: await this.host.currentGeneration(),
        databaseCheckpoint: await this.host.checkpointDatabase(),
      };
      await atomicWrite(this.rollbackPath(context), JSON.stringify(rollback));
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'stage', error);
    }
  }

  async activate(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      await this.host.migrateDatabase(context.artifact.hash);
      await this.host.startSuccessor(await this.nextPointer(context));
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'activate', error);
    }
  }

  async health(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      await this.host.probeSuccessor(await this.nextPointer(context));
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'health', error);
    }
  }

  async commit(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      const next = await this.nextPointer(context);
      const rollback = await this.rollbackRecord(context);
      const previous = rollback?.previous ?? null;
      await this.host.switchActiveSocket(next);
      await atomicWrite(this.currentPath(), JSON.stringify(next));
      if (previous) await this.host.stopGeneration(previous);
      if (rollback) await this.host.releaseDatabaseCheckpoint(rollback.databaseCheckpoint);
      await this.host.resumeAdmissions();
      await rm(this.rollbackPath(context), { force: true });
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'commit', error);
    }
  }

  async rollback(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      const next = await this.nextPointer(context);
      const rollback = await this.rollbackRecord(context);
      const previous = rollback?.previous ?? null;
      await this.host.stopGeneration(next);
      if (rollback) await this.host.restoreDatabase(rollback.databaseCheckpoint);
      if (previous) {
        await this.host.switchActiveSocket(previous);
        await atomicWrite(this.currentPath(), JSON.stringify(previous));
      } else {
        await rm(this.currentPath(), { force: true });
      }
      await this.host.resumeAdmissions();
      await rm(this.rollbackPath(context), { force: true });
      return Result.ok(undefined);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        await this.host.resumeAdmissions();
        return Result.ok(undefined);
      }
      return actionFailure(this.entrypoint, 'rollback', error);
    }
  }

  private async nextPointer(context: ReplacementContext): Promise<MachineGenerationPointer> {
    const generation = context.artifact.hash.slice('sha256:'.length);
    const metadata = await stat(context.artifact.path);
    const artifactName = metadata.isDirectory() ? 'machine' : basename(context.artifact.path);
    return {
      hash: context.artifact.hash,
      artifactPath: join(this.environmentRoot, 'machine', 'generations', generation, artifactName),
      socketPath: join(this.environmentRoot, 'machine', 'sockets', `machine-${generation}.sock`),
    };
  }

  private currentPath(): string {
    return join(this.environmentRoot, 'machine', 'current.json');
  }

  private rollbackPath(context: ReplacementContext): string {
    return join(this.environmentRoot, 'machine', `rollback-${context.plan.id}-${context.attempt}.json`);
  }

  private async rollbackRecord(context: ReplacementContext): Promise<MachineRollbackRecord | null> {
    try {
      return machineRollbackSchema.parse(JSON.parse(await readFile(this.rollbackPath(context), 'utf8')));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
}
