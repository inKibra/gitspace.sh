import { githubRepositoryOf, type GitHubRepositoryAccess } from '@gitspace/protocol/github';
import type { GitHttpAuth, OriginCredentials } from '@gitspace/runtime-workspace-do';

/** How the cloud reaches a project's origin. A repository an installation of the account's GitHub App covers is
 * reached only with an installation token for that repository; any other origin is read without credentials (a
 * private one then needs a machine holding the account SSH key). Never one path, then the other. `remote` is the
 * address the cloud reads: the HTTPS root for any GitHub form, otherwise the reference as stored (an SSH remote on
 * another host stays SSH, which only a machine can read). */
export type OriginAccess =
  | { kind: 'github-app'; repository: string; remote: string; auth(access: GitHubRepositoryAccess): Promise<GitHttpAuth> }
  | { kind: 'public'; remote: string };

export async function originAccess(env: Env, reference: string): Promise<OriginAccess> {
  const repository = githubRepositoryOf(reference);
  if (repository === null) return { kind: 'public', remote: reference.trim() };
  const remote = `https://github.com/${repository}.git`;
  const github = env.GITHUB_APP.getByName(env.ACCOUNT_ID);
  if (await github.coverage(repository) === null) return { kind: 'public', remote };
  return {
    kind: 'github-app', repository, remote,
    async auth(access) {
      const issued = await github.repositoryToken(repository, access);
      return { kind: 'basic', username: 'x-access-token', password: issued.token };
    },
  };
}

/** Read credentials for an origin, issued only once it is contacted; a public origin is read without any. */
export function originReadCredentials(access: OriginAccess): OriginCredentials {
  return access.kind === 'github-app' ? () => access.auth('read') : null;
}
