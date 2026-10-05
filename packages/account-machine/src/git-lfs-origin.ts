import { z } from 'zod';
import { confirmGitLfsObjects, type GitLfsConfirmedObject, type GitLfsObject, type GitLfsOriginConfirmation } from '@gitspace/protocol-workspace';

type Git = (root: string, args: string[], env?: Record<string, string>, input?: string | Uint8Array) => Promise<Uint8Array>;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
const positives = new Map<string, { identity: string; objects: Map<string, number> }>();
const Authentication = z.object({ href: z.string().url(), header: z.record(z.string(), z.string()).optional() });

function originIdentity(origin: string): string | null {
  try {
    const scp = /^(?:[^@/:]+@)?([^/:]+):([^/].*)$/u.exec(origin);
    const url = new URL(scp && !origin.includes('://') ? `ssh://${scp[1]}/${scp[2]}` : origin);
    return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}/${url.pathname.replace(/^\//u, '').replace(/\/$/u, '').replace(/\.git$/u, '')}`;
  } catch { return null; }
}

export async function originConfirmation(root: string, head: string | null, git: Git, environment: Record<string, string>, options?: {
  canonicalOrigin?: string | null;
  confirmOrigin?(receipt: GitLfsOriginConfirmation): Promise<void>;
}) {
  const config = async (args: string[]) => {
    try { return decode(await git(root, ['config', ...args], environment)); } catch { return ''; }
  };
  const origin = await config(['--get', 'remote.origin.url']);
  if (options?.canonicalOrigin === null || (options?.canonicalOrigin && (!originIdentity(origin) || originIdentity(origin) !== originIdentity(options.canonicalOrigin)))) {
    positives.delete(root);
    return async (_objects: readonly GitLfsObject[]): Promise<GitLfsConfirmedObject[]> => [];
  }
  const explicit = await config(['--get', 'lfs.url']) || await config(['--get', 'remote.origin.lfsurl']);
  const committed = head ? await config(['--blob', `${head}:.lfsconfig`, '--get', 'lfs.url']) : '';
  let rewritten = origin;
  try { rewritten = decode(await git(root, ['remote', 'get-url', 'origin'], environment)); } catch { /* A configured LFS endpoint does not require a Git remote. */ }
  let endpoint: URL;
  const headers = new Headers();
  try {
    if (explicit || committed) endpoint = new URL(explicit || committed);
    else if (rewritten.startsWith('ssh://') || (!rewritten.includes('://') && rewritten.includes(':'))) {
      const ssh = new URL(rewritten.startsWith('ssh://') ? rewritten : `ssh://${rewritten.replace(':', '/')}`);
      const host = `${ssh.username ? `${ssh.username}@` : ''}${ssh.hostname}`;
      if (host.startsWith('-') || /[\r\n]/u.test(host)) throw new Error('Invalid SSH LFS host');
      const repository = decodeURIComponent(ssh.pathname.replace(/^\//u, ''));
      const command = environment.GIT_SSH_COMMAND || await config(['--get', 'core.sshCommand']) || 'ssh';
      const remoteCommand = `git-lfs-authenticate '${repository.replace(/'/gu, `'\\''`)}' download`;
      const args = ['sh', '-c', `exec ${command} "$@"`, 'git-lfs-authenticate', '-o', 'BatchMode=yes', ...(ssh.port ? ['-p', ssh.port] : []), host, remoteCommand];
      const child = Bun.spawn(args, { cwd: root, env: { ...Bun.env, ...environment, GIT_TERMINAL_PROMPT: '0' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (code !== 0) throw new Error('SSH LFS authentication failed');
      const authenticated = Authentication.parse(JSON.parse(output));
      endpoint = new URL(authenticated.href);
      for (const [name, value] of Object.entries(authenticated.header ?? {})) headers.set(name, value);
    } else endpoint = new URL(`${rewritten.replace(/\/$/u, '').replace(/\.git$/u, '')}.git/info/lfs`);
    if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('Unsupported LFS endpoint');
    if (endpoint.username || endpoint.password) {
      headers.set('authorization', `Basic ${Buffer.from(`${decodeURIComponent(endpoint.username)}:${decodeURIComponent(endpoint.password)}`).toString('base64')}`);
      endpoint.username = ''; endpoint.password = '';
    }
  } catch {
    positives.delete(root);
    return async (_objects: readonly GitLfsObject[]): Promise<GitLfsConfirmedObject[]> => [];
  }
  const extra = await config(['--get-urlmatch', 'http.extraHeader', endpoint.href]);
  for (const line of extra.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  if (!headers.has('authorization')) {
    try {
      const credential = decode(await git(root, ['credential', 'fill'], { ...environment, GIT_TERMINAL_PROMPT: '0' }, `url=${endpoint.href}\n\n`));
      let username = ''; let password = '';
      for (const line of credential.split('\n')) {
        if (line.startsWith('username=')) username = line.slice(9);
        if (line.startsWith('password=')) password = line.slice(9);
      }
      if (username || password) headers.set('authorization', `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
    } catch { /* Anonymous confirmation remains possible; failure never grants ownership. */ }
  }
  const identity = JSON.stringify([origin, rewritten, explicit, committed, endpoint.href, extra, environment, options?.canonicalOrigin]);
  const previous = positives.get(root);
  const cache = previous?.identity === identity ? previous.objects : new Map<string, number>();
  positives.set(root, { identity, objects: cache });
  return async (objects: readonly GitLfsObject[]): Promise<GitLfsConfirmedObject[]> => {
    const missing = objects.filter(object => cache.get(object.oid) !== object.size);
    const fresh = await confirmGitLfsObjects({ endpoint: endpoint.href, objects: missing, headers });
    if (fresh.length) await options?.confirmOrigin?.({ origin: options?.canonicalOrigin ?? origin, endpoint: endpoint.href, objects: fresh });
    for (const object of fresh) cache.set(object.oid, object.size);
    return objects.filter(object => cache.get(object.oid) === object.size).map(object => ({ ...object, location: { origin: options?.canonicalOrigin ?? origin, endpoint: endpoint.href } }));
  };
}
