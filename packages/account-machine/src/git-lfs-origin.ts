import { z } from 'zod';
import { confirmGitLfsObjects, downloadGitLfsObject, type GitLfsConfirmedObject, type GitLfsObject, type GitLfsOriginConfirmation } from '@gitspace/protocol-workspace';
import { createHash } from 'node:crypto';
import { originLfsInventory } from './git-lfs-inventory.js';

type Git = (root: string, args: string[], env?: Record<string, string>, input?: string | Uint8Array) => Promise<Uint8Array>;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
const Authentication = z.object({ href: z.string().url(), header: z.record(z.string(), z.string()).optional() });
const confirmations = new Map<string, Promise<void>>();


function cleanUrl(value: string): string {
  const url = new URL(value);
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return url.href;
}

function cleanOrigin(value: string): string {
  try { return cleanUrl(value); } catch { return value; }
}

async function endpointHeaders(root: string, endpoint: URL, headers: Headers, git: Git, environment: Record<string, string>): Promise<string> {
  if (endpoint.username || endpoint.password) {
    headers.set('authorization', `Basic ${Buffer.from(`${decodeURIComponent(endpoint.username)}:${decodeURIComponent(endpoint.password)}`).toString('base64')}`);
    endpoint.username = ''; endpoint.password = '';
  }
  let extra = '';
  try { extra = decode(await git(root, ['config', '--get-urlmatch', 'http.extraHeader', endpoint.href], environment)); } catch { /* No matching header. */ }
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
    } catch { /* Anonymous access remains possible; failure never grants ownership. */ }
  }
  return extra;
}

export async function downloadQueryObject(root: string, endpoint: string, object: GitLfsObject, git: Git, environment: Record<string, string>): Promise<AsyncIterable<Uint8Array>> {
  const url = new URL(endpoint);
  const headers = new Headers();
  await endpointHeaders(root, url, headers, git, environment);
  const bytes = await downloadGitLfsObject({ endpoint: url.href, object, headers, signal: AbortSignal.timeout(10_000) });
  if (!bytes) throw new Error('Origin LFS download unavailable');
  return bytes;
}

/** Recover machine-only URL credentials only for the exact confirmed endpoint. */
export async function hydrationEndpoint(root: string, ref: string | undefined, endpoint: string, git: Git, environment: Record<string, string>): Promise<string> {
  const settings = [['--get', 'lfs.url'], ['--get', 'remote.origin.lfsurl'], ...(ref ? [['--blob', `${ref}:.lfsconfig`, '--get', 'lfs.url']] : [])];
  for (const setting of settings) {
    try {
      const configured = decode(await git(root, ['config', ...setting], environment));
      if (cleanUrl(configured) === endpoint) return configured;
    } catch { /* Absent or invalid routes cannot supply endpoint credentials. */ }
  }
  return endpoint;
}
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
  recheck?: boolean;
}) {
  const config = async (args: string[]) => {
    try { return decode(await git(root, ['config', ...args], environment)); } catch { return ''; }
  };
  const origin = await config(['--get', 'remote.origin.url']);
  if (options?.canonicalOrigin === null || (options?.canonicalOrigin && (!originIdentity(origin) || originIdentity(origin) !== originIdentity(options.canonicalOrigin)))) {
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
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(timeout));
      if (code !== 0) throw new Error('SSH LFS authentication failed');
      const authenticated = Authentication.parse(JSON.parse(output));
      endpoint = new URL(authenticated.href);
      for (const [name, value] of Object.entries(authenticated.header ?? {})) headers.set(name, value);
    } else endpoint = new URL(`${rewritten.replace(/\/$/u, '').replace(/\.git$/u, '')}.git/info/lfs`);
    if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('Unsupported LFS endpoint');
  } catch {
    return async (_objects: readonly GitLfsObject[]): Promise<GitLfsConfirmedObject[]> => [];
  }
  const extra = await endpointHeaders(root, endpoint, headers, git, environment);
  const identity = createHash('sha256').update(JSON.stringify([origin, rewritten, explicit, committed, endpoint.href, extra, environment, options?.canonicalOrigin, Boolean(options?.confirmOrigin)])).digest('hex');
  const location = { origin: cleanOrigin(options?.canonicalOrigin ?? origin), endpoint: cleanUrl(endpoint.href) };
  return async (objects: readonly GitLfsObject[]): Promise<GitLfsConfirmedObject[]> => {
    const operation = (confirmations.get(root) ?? Promise.resolve()).then(async () => {
      const inventory = await originLfsInventory(root, identity, git);
      const candidates = options?.recheck
        ? [...inventory.attempted.values()].filter(object => inventory.confirmed.get(object.oid)?.size !== object.size).sort((a, b) => a.oid.localeCompare(b.oid))
        : objects.filter(object => inventory.attempted.get(object.oid)?.size !== object.size);
      const cursor = inventory.cursor;
      const afterCursor = cursor ? candidates.findIndex(object => object.oid > cursor) : 0;
      const start = afterCursor < 0 ? 0 : afterCursor;
      const missing = options?.recheck ? [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, 64) : candidates;
      const fresh = await confirmGitLfsObjects({ endpoint: endpoint.href, objects: missing, headers, signal: AbortSignal.timeout(10_000) });
      // A failed receipt must remain undiscovered so the next capture can safely retry it.
      if (fresh.length) await options?.confirmOrigin?.({ ...location, objects: fresh });
      for (const object of missing) inventory.attempted.set(object.oid, object);
      for (const object of fresh) inventory.confirmed.set(object.oid, object);
      if (options?.recheck && missing.length) inventory.cursor = missing[missing.length - 1]!.oid;
      if (missing.length) await inventory.save();
      return objects.filter(object => inventory.confirmed.get(object.oid)?.size === object.size).map(object => ({ ...object, location }));
    });
    const settled = operation.then(() => {}, () => {});
    confirmations.set(root, settled);
    try { return await operation; }
    finally { if (confirmations.get(root) === settled) confirmations.delete(root); }
  };
}
