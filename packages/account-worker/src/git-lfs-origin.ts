import { confirmGitLfsObjects, type GitLfsObject, type GitLfsConfirmedObject } from '@gitspace/protocol-workspace';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';

/** Only committed routing is considered. Private origins use signed native-auth receipts. */
export async function confirmCloudOrigin(input: { code: ArtifactsCodeStore; repository: string; commit: string; origin: string; objects: readonly GitLfsObject[]; fetcher?: typeof fetch }): Promise<GitLfsConfirmedObject[]> {
  const normalized = input.origin.replace(/^git@([^:]+):/u, 'https://$1/');
  let origin: URL;
  try { origin = new URL(normalized); } catch { return []; }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) return [];
  let endpoint = `${origin.href.replace(/\/$/u, '')}/info/lfs`;
  const config = await input.code.readFile(input.repository, input.commit, '.lfsconfig');
  if (config) {
    if (config.size > 64 * 1024) return [];
    let section = ''; let configured: string | undefined;
    for (const raw of (await config.text()).split(/\r?\n/u)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const heading = /^\[([^\]]+)\]$/u.exec(line);
      if (heading) { section = heading[1]!.trim().toLowerCase(); continue; }
      const setting = /^([\w.-]+)\s*=\s*(.*?)\s*$/u.exec(line);
      if (section === 'lfs' && setting?.[1]?.toLowerCase() === 'url') {
        if (configured !== undefined) return [];
        configured = setting[2]!.replace(/^"(.*)"$/u, '$1');
      }
    }
    if (configured !== undefined) {
      try { endpoint = new URL(configured, origin).href; } catch { return []; }
    }
  }
  return (await confirmGitLfsObjects({ endpoint, objects: input.objects, fetcher: input.fetcher, signal: AbortSignal.timeout(30_000) })).map(object => ({ ...object, location: { origin: input.origin, endpoint } }));
}
