import { eq } from 'drizzle-orm';
import { Result, TaggedError, type Result as ResultType } from 'better-result';
import type { GitSpaceDatabase } from './database.js';
import { LocalArtifactResolver, type ArtifactCapability } from './artifacts.js';
import {
  artifactEntries,
  artifactPromotions,
  artifactScopes,
  type ArtifactPromotion,
} from './schema.js';

export class ArtifactPromotionDenied extends TaggedError('ArtifactPromotionDenied')<{
  message: string;
}> {}
export class ArtifactPromotionConflict extends TaggedError('ArtifactPromotionConflict')<{
  promotionId: string;
  message: string;
}> {}
export class ArtifactPromotionFailed extends TaggedError('ArtifactPromotionFailed')<{
  promotionId: string;
  message: string;
}> {}
export type ArtifactPromotionError = ArtifactPromotionDenied | ArtifactPromotionConflict | ArtifactPromotionFailed;

function promotionPath(path: string): string | null {
  const normalized = path.replace(/^\/+|\/+$/gu, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return null;
  return normalized;
}

export class ArtifactPromoter {
  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly artifacts: LocalArtifactResolver,
  ) {}

  async promote(input: {
    capability: Extract<ArtifactCapability, { kind: 'project' }>;
    workspaceId: string;
    paths: string[];
    expectedBaseGeneration: number;
  }): Promise<ResultType<ArtifactPromotion, ArtifactPromotionError>> {
    const uniquePaths = [...new Set(input.paths.map(promotionPath))];
    if (uniquePaths.length === 0 || uniquePaths.some((path) => path === null)) {
      return Result.err(new ArtifactPromotionDenied({ message: 'Promotion requires valid workspace-relative paths' }));
    }
    const workspace = this.database.getWorkspace(input.workspaceId);
    if (!workspace || workspace.projectId !== input.capability.projectId) {
      return Result.err(new ArtifactPromotionDenied({ message: 'Workspace does not belong to the promoted project' }));
    }
    const workspaceScope = this.database.orm.select().from(artifactScopes)
      .where(eq(artifactScopes.spaceId, input.workspaceId)).get();
    const baseScope = this.database.orm.select().from(artifactScopes)
      .where(eq(artifactScopes.spaceId, input.capability.projectId)).get();
    if (!workspaceScope || !baseScope) {
      return Result.err(new ArtifactPromotionDenied({ message: 'Artifact scopes are missing' }));
    }

    const promotionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const createRecord = (state: ArtifactPromotion['state']): ArtifactPromotion => this.database.orm.insert(artifactPromotions).values({
      id: promotionId,
      projectId: input.capability.projectId,
      sourceSpaceId: input.workspaceId,
      sourceGeneration: workspaceScope.generation,
      expectedBaseGeneration: input.expectedBaseGeneration,
      paths: uniquePaths as string[],
      state,
      createdAt: now,
      updatedAt: now,
    }).returning().get();

    if (baseScope.generation !== input.expectedBaseGeneration) {
      createRecord('conflict');
      return Result.err(new ArtifactPromotionConflict({
        promotionId,
        message: `Expected base generation ${input.expectedBaseGeneration}, received ${baseScope.generation}`,
      }));
    }

    const entries = this.database.orm.select().from(artifactEntries)
      .where(eq(artifactEntries.scopeId, workspaceScope.id)).orderBy(artifactEntries.path).all();
    const selected = entries.filter((entry) => uniquePaths.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)));
    if (selected.length === 0) {
      return Result.err(new ArtifactPromotionDenied({ message: 'No committed workspace artifacts matched the promotion paths' }));
    }
    if (selected.some((entry) => entry.generation !== workspaceScope.generation)) {
      return Result.err(new ArtifactPromotionDenied({ message: 'Workspace artifacts must be committed before promotion' }));
    }

    createRecord('planned');
    const capability = { ...input.capability, currentWorkspaceId: input.workspaceId };
    try {
      for (const entry of selected) {
        const source = await this.artifacts.read(capability, `local://workspaces/${input.workspaceId}/${entry.path}`);
        if (source.status === 'error') throw source.error;
        const written = await this.artifacts.write(
          capability,
          `local://base/${entry.path}`,
          source.value,
          entry.mediaType ?? undefined,
        );
        if (written.status === 'error') throw written.error;
      }
      const committed = await this.artifacts.commit(capability, 'local://base/', input.expectedBaseGeneration);
      if (committed.status === 'error') throw committed.error;
      const updatedAt = new Date().toISOString();
      return Result.ok(this.database.orm.update(artifactPromotions).set({
        state: 'committed',
        committedBaseGeneration: committed.value.generation,
        updatedAt,
      }).where(eq(artifactPromotions.id, promotionId)).returning().get());
    } catch (error) {
      this.database.orm.update(artifactPromotions).set({ state: 'conflict', updatedAt: new Date().toISOString() })
        .where(eq(artifactPromotions.id, promotionId)).run();
      return Result.err(new ArtifactPromotionFailed({
        promotionId,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}
