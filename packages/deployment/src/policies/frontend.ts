import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Result, type Result as ResultType } from 'better-result';
import { z } from 'zod';
import type { ReplacementContext, ReplacementDriver } from '../engine.js';
import { ReplacementActionError } from '../engine.js';
import { actionFailure, atomicWrite, copyArtifact, hashArtifactPath, verifyArtifact } from './shared.js';

interface FrontendPointer {
  hash: string;
  generationPath: string;
}

const frontendPointerSchema = z.object({
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  generationPath: z.string().min(1),
});

export interface FrontendReplacementHost {
  checkpointClients(nextHash: string): Promise<void>;
  publishGeneration(nextHash: string): Promise<void>;
  probeGeneration(generationPath: string, hash: string): Promise<void>;
}

export class FrontendReplacementDriver implements ReplacementDriver {
  readonly entrypoint = 'frontend' as const;

  constructor(
    private readonly environmentRoot: string,
    private readonly host: FrontendReplacementHost,
  ) {}

  async drain(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      await this.host.checkpointClients(context.artifact.hash);
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'drain', error);
    }
  }

  async stage(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    const verified = await verifyArtifact(context.artifact, 'stage');
    if (verified.status === 'error') return verified;
    try {
      const generationPath = this.generationPath(context.artifact.hash);
      await mkdir(join(this.environmentRoot, 'frontend', 'generations'), { recursive: true });
      try {
        const existingHash = await hashArtifactPath(generationPath);
        if (existingHash !== context.artifact.hash) throw new Error(`Existing frontend generation ${generationPath} has the wrong hash`);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          await copyArtifact(context.artifact.path, generationPath);
        } else {
          throw error;
        }
      }
      await atomicWrite(this.rollbackPath(context), JSON.stringify(await this.currentPointer()));
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'stage', error);
    }
  }

  async activate(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      const pointer: FrontendPointer = {
        hash: context.artifact.hash,
        generationPath: this.generationPath(context.artifact.hash),
      };
      await atomicWrite(this.currentPath(), JSON.stringify(pointer));
      await this.host.publishGeneration(context.artifact.hash);
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'activate', error);
    }
  }

  async health(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      const generationPath = this.generationPath(context.artifact.hash);
      await access(join(generationPath, 'index.html'));
      await this.host.probeGeneration(generationPath, context.artifact.hash);
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'health', error);
    }
  }

  async commit(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      await rm(this.rollbackPath(context), { force: true });
      return Result.ok(undefined);
    } catch (error) {
      return actionFailure(this.entrypoint, 'commit', error);
    }
  }

  async rollback(context: ReplacementContext): Promise<ResultType<void, ReplacementActionError>> {
    try {
      const previous = frontendPointerSchema.nullable().parse(JSON.parse(await readFile(this.rollbackPath(context), 'utf8')));
      if (previous) {
        await atomicWrite(this.currentPath(), JSON.stringify(previous));
        await this.host.publishGeneration(previous.hash);
      } else {
        await rm(this.currentPath(), { force: true });
      }
      await rm(this.rollbackPath(context), { force: true });
      return Result.ok(undefined);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return Result.ok(undefined);
      return actionFailure(this.entrypoint, 'rollback', error);
    }
  }

  private generationPath(hash: string): string {
    return join(this.environmentRoot, 'frontend', 'generations', hash.slice('sha256:'.length));
  }

  private currentPath(): string {
    return join(this.environmentRoot, 'frontend', 'current.json');
  }

  private rollbackPath(context: ReplacementContext): string {
    return join(this.environmentRoot, 'frontend', `rollback-${context.plan.id}-${context.attempt}.json`);
  }

  private async currentPointer(): Promise<FrontendPointer | null> {
    try {
      return frontendPointerSchema.parse(JSON.parse(await readFile(this.currentPath(), 'utf8')));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
}
