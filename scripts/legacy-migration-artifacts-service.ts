import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';

/** Wire adapter for the isolated native-Git owner. No Node APIs enter the Worker bundle. */
export interface LegacyMigrationArtifactsEnvironment {
  LEGACY_GIT_ORIGIN: string;
  LEGACY_GIT_CONTROL_TOKEN: string;
}
const identitySchema = z.object({ name: z.string(), email: z.string() });
const commitSchema = z.object({ hash: z.string(), treeHash: z.string(), message: z.string(), author: identitySchema, committer: identitySchema, parents: z.array(z.string()), authoredAt: z.number(), committedAt: z.number() });
const treeSchema = z.array(z.object({ name: z.string(), mode: z.string(), hash: z.string(), type: z.enum(['tree', 'blob', 'exec', 'gitlink', 'symlink']) }));
const metadataSchema = z.object({ id: z.string(), name: z.string(), description: z.string().nullable(), defaultBranch: z.string(), createdAt: z.string(), updatedAt: z.string(), lastPushAt: z.string().nullable(), source: z.string().nullable(), readOnly: z.boolean() });
const infoSchema = metadataSchema.extend({ remote: z.string() });
const createdSchema = z.object({ id: z.string(), name: z.string(), description: z.string().nullable(), defaultBranch: z.string(), remote: z.string(), token: z.string() });
const tokenSchema = z.object({ id: z.string(), plaintext: z.string(), scope: z.enum(['read', 'write']), expiresAt: z.string() });
const tokensSchema = z.object({ tokens: z.array(z.object({ id: z.string(), scope: z.enum(['read', 'write']), state: z.enum(['active', 'expired', 'revoked']), createdAt: z.string(), expiresAt: z.string() })), total: z.number() });
const listSchema = z.object({ repos: z.array(metadataSchema), total: z.number(), cursor: z.string().optional() });
type CreateOptions = { readOnly?: boolean; description?: string; setDefaultBranch?: string };

async function call(environment: LegacyMigrationArtifactsEnvironment, repository: string | null, operation: string, args: unknown[]): Promise<Response> {
  const origin = new URL(environment.LEGACY_GIT_ORIGIN);
  if (origin.protocol !== 'https:' || origin.hostname !== 'legacy-migration-git.invalid' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Refusing non-isolated Artifacts owner');
  const response = await fetch(`${origin.origin}/rpc`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', authorization: `Bearer ${environment.LEGACY_GIT_CONTROL_TOKEN}` }, body: JSON.stringify({ repository, operation, args }) });
  if (response.status >= 300 && response.status < 400) throw new Error('Artifacts owner redirects are not allowed');
  if (!response.ok) {
    const error = z.object({ name: z.string(), code: z.string(), message: z.string() }).parse(await response.json());
    throw Object.assign(new Error(error.message), { name: error.name, code: error.code });
  }
  return response;
}
async function json<T>(environment: LegacyMigrationArtifactsEnvironment, repository: string | null, operation: string, args: unknown[], schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await (await call(environment, repository, operation, args)).json());
}
async function blob(environment: LegacyMigrationArtifactsEnvironment, repository: string, operation: string, args: unknown[]): Promise<Blob | null> {
  const response = await call(environment, repository, operation, args);
  if (response.headers.get('x-gitspace-result') === 'blob') return response.blob();
  return z.null().parse(await response.json());
}

class LegacyMigrationArtifactsRepository extends RpcTarget {
  constructor(private readonly environment: LegacyMigrationArtifactsEnvironment, private readonly repository: string) { super(); }
  info() { return json(this.environment, this.repository, 'info', [], infoSchema); }
  createToken(scope: 'read' | 'write' = 'write', ttl = 86400) { return json(this.environment, this.repository, 'createToken', [scope, ttl], tokenSchema); }
  revokeToken(token: string) { return json(this.environment, this.repository, 'revokeToken', [token], z.boolean()); }
  listTokens() { return json(this.environment, this.repository, 'listTokens', [], tokensSchema); }
  readCommit(hash: string) { return json(this.environment, this.repository, 'readCommit', [hash], commitSchema.nullable()); }
  readTree(hash: string) { return json(this.environment, this.repository, 'readTree', [hash], treeSchema.nullable()); }
  readBlob(hash: string) { return blob(this.environment, this.repository, 'readBlob', [hash]); }
  readFile(options: { ref: string; path: string }) { return blob(this.environment, this.repository, 'readFile', [options]); }
  log(options?: { ref?: string; limit?: number; offset?: number }) { return json(this.environment, this.repository, 'log', [options ?? {}], z.array(commitSchema)); }
  fork(name: string, options?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }) { return json(this.environment, this.repository, 'fork', [name, options ?? {}], createdSchema); }
}

/** Bind this entrypoint as ARTIFACTS for every production DO in the isolated Worker. */
export class LegacyMigrationArtifactsService extends WorkerEntrypoint<LegacyMigrationArtifactsEnvironment> {
  create(name: string, options?: CreateOptions) { return json(this.env, null, 'create', [name, options ?? {}], createdSchema); }
  async get(name: string) {
    await json(this.env, name, 'info', [], infoSchema);
    return new LegacyMigrationArtifactsRepository(this.env, name);
  }
  list(options?: { limit?: number; cursor?: string }) { return json(this.env, null, 'list', [options ?? {}], listSchema); }
  delete(name: string) { return json(this.env, null, 'delete', [name], z.boolean()); }
  import(): never { throw new Error('Isolated rehearsal forbids remote repository imports; seed recovered bytes through the native Git owner'); }
}
