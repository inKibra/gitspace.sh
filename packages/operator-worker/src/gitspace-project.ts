import { gitSpaceSourceProvenanceSchema, type CloudProjectSummary, type GitSpaceSourceProvenance } from '@gitspace/protocol';
import type { AccountRegistryDO } from './account-registry.js';
import type { ProjectAuthorityDO, UserProjectIndexDO } from './project-authority.js';
import type { TenantReleasesDO } from './tenant-releases.js';

/** Cloud-only account invariant. The index reserves identity synchronously before any cross-DO writes. */
export async function ensureAccountGitSpaceProject(
  env: Env,
  userId: string,
  fallback: { sourceBranch?: string; sourceCommit?: string } = {},
): Promise<CloudProjectSummary> {
  const namespace = env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>;
  const index = namespace.get(namespace.idFromName(userId));
  const authorityNamespace = env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>;
  const existing = (await index.list()).find((project) => project.role === 'gitspace-source');
  if (existing && existing.lifecycle !== 'cloud-only') {
    const authority = authorityNamespace.get(authorityNamespace.idFromName(`${userId}:${existing.id}`));
    return index.put(await authority.ensureGitSpaceProject(existing));
  }
  const releasesNamespace = env.TENANT_RELEASES as DurableObjectNamespace<TenantReleasesDO>;
  const accountsNamespace = env.ACCOUNTS as DurableObjectNamespace<AccountRegistryDO>;
  const [frontend, account] = await Promise.all([
    releasesNamespace.get(releasesNamespace.idFromName(userId)).frontend(),
    accountsNamespace.get(accountsNamespace.idFromName('global')).get(userId),
  ]);
  const release = frontend?.sha ?? account?.tenantRelease ?? null;
  let source: GitSpaceSourceProvenance = gitSpaceSourceProvenanceSchema.parse({
    release,
    branch: fallback.sourceBranch?.trim() || null,
    commit: release && /^[a-f0-9]{40,64}$/iu.test(release) ? release : fallback.sourceCommit?.trim() || null,
  });
  // Channel assets carry the same metadata injected into the served frontend. Do not
  // apply channel metadata to a tenant-selected frontend built from another release.
  if (!frontend && env.ASSETS) {
    const response = await env.ASSETS.fetch(new Request('https://gitspace.invalid/__account/gitspace-source.json'));
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      const metadata = gitSpaceSourceProvenanceSchema.parse(await response.json());
      source = { ...metadata, release: metadata.release ?? release };
    }
  }
  if (frontend) {
    const object = await env.DATA.get(`users/${userId}/${frontend.keyPrefix}/gitspace-source.json`);
    if (object) {
      const metadata = gitSpaceSourceProvenanceSchema.parse(await object.json());
      source = { ...metadata, release: frontend.sha, commit: /^[a-f0-9]{40,64}$/iu.test(frontend.sha) ? frontend.sha : metadata.commit };
    } else {
      const status = await releasesNamespace.get(releasesNamespace.idFromName(userId)).status({ sha: null, version: null });
      const record = status.releases.find((candidate) => candidate.sha === frontend.sha);
      if (record?.workspaceId) {
        const projectId = await index.locateWorkspace(record.workspaceId);
        if (projectId) {
          const workspaces = await authorityNamespace.get(authorityNamespace.idFromName(`${userId}:${projectId}`)).listWorkspaces();
          source.branch = workspaces.find((workspace) => workspace.id === record.workspaceId)?.branch ?? source.branch;
        }
      }
    }
  }
  const reserved = await index.ensureGitSpaceProject(source);
  const authority = authorityNamespace.get(authorityNamespace.idFromName(`${userId}:${reserved.id}`));
  return index.put(await authority.ensureGitSpaceProject(reserved));
}
