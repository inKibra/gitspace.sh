import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export type CheckoutSource = { remote: string; ref: string; commit: string };
export type ArtifactFsHost = {
  binary?: string;
  root: string;
  /** Supervisor owns the persistent daemon, its private environment and stop evidence. */
  ensureDaemon(input: { binary: string; args: string[]; env: Record<string, string> }): Promise<void>;
  /** Refreshable credential helper environment, never credentials embedded in a remote. */
  gitEnvironment(): Promise<Record<string, string>>;
};

async function execute(binary: string, args: string[], env: Record<string, string>, cwd: string | undefined, signal: AbortSignal): Promise<string> {
  const child = Bun.spawn([binary, ...args], { cwd, signal, env: { ...Bun.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${binary} ${args[0]} failed: ${stderr.trim()}`);
  return stdout.trim();
}

export async function artifactFsAvailable(binary: string): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    await access(binary, constants.X_OK);
    await access('/dev/fuse', constants.R_OK | constants.W_OK);
    return (await readFile('/proc/filesystems', 'utf8')).includes('fuse');
  } catch { return false; }
}

/** A fixed commit constrains the source, not the writable overlay. Unsupported hosts use Git. */
export async function acquireCheckout(input: {
  name: string;
  directory: string;
  source: CheckoutSource;
  fixed: boolean;
  requiresFiltersOrSubmodules: boolean;
  host: ArtifactFsHost;
  signal: AbortSignal;
  hydrateLfs(directory: string): Promise<void>;
}): Promise<{ mode: 'artifactfs' | 'git'; directory: string; commit: string }> {
  const command = (binary: string, args: string[], env: Record<string, string>, cwd?: string) => execute(binary, args, env, cwd, input.signal);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.name)) throw new Error('Invalid checkout identity');
  if (!/^[0-9a-f]{40}$/u.test(input.source.commit)) throw new Error('Checkout requires a full source commit');
  if (!/^[0-9a-f]{40}$/u.test(input.source.ref) && (!/^refs\/[A-Za-z0-9._/-]+$/u.test(input.source.ref) || input.source.ref.includes('..'))) throw new Error('Checkout requires a canonical source ref or full commit');
  const remote = new URL(input.source.remote);
  if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash) throw new Error('Checkout requires a credential-free HTTPS remote');
  input.signal.throwIfAborted();
  const env = await input.host.gitEnvironment();
  if (!input.host.binary || /^[0-9a-f]{40}$/u.test(input.source.ref) || input.requiresFiltersOrSubmodules || !await artifactFsAvailable(input.host.binary)) {
    await mkdir(input.directory, { recursive: true });
    await command('git', ['init', input.directory], env);
    await command('git', ['config', 'remote.origin.url', input.source.remote], env, input.directory);
    await command('git', ['fetch', '--no-tags', input.source.remote, input.source.ref], { ...env, GIT_LFS_SKIP_SMUDGE: '1' }, input.directory);
    const acquired = await command('git', ['rev-parse', 'FETCH_HEAD^{commit}'], env, input.directory);
    if (acquired !== input.source.commit) throw new Error('Acquired source differs from assigned commit');
    const branch = input.source.ref.startsWith('refs/heads/') ? input.source.ref.slice('refs/heads/'.length) : input.source.ref;
    await command('git', input.fixed || /^[0-9a-f]{40}$/u.test(input.source.ref) ? ['checkout', '--detach', input.source.commit] : ['checkout', '-b', branch, input.source.commit], { ...env, GIT_LFS_SKIP_SMUDGE: '1' }, input.directory);
    await input.hydrateLfs(input.directory);
    if (input.requiresFiltersOrSubmodules) await command('git', ['submodule', 'update', '--init', '--recursive'], env, input.directory);
    input.signal.throwIfAborted();
    return { mode: 'git', directory: input.directory, commit: acquired };
  }
  const directory = join(input.host.root, input.name);
  if (directory !== input.directory) throw new Error('ArtifactFS checkout must use its registered mount path');
  await command(input.host.binary, ['add-repo', '--name', input.name, '--remote', input.source.remote, '--ref', input.source.ref,
    ...(input.fixed ? ['--require-commit', input.source.commit, '--refresh', 'never'] : []), '--mount-root', input.host.root], env);
  await input.host.ensureDaemon({ binary: input.host.binary, args: ['daemon', '--root', input.host.root], env });
  while (!input.signal.aborted) {
    const status = await command(input.host.binary, ['status', '--name', input.name], env);
    if (/state=failed\b/u.test(status)) throw new Error('ArtifactFS acquisition failed');
    if (/state=mounted\b/u.test(status) && status.includes(`base_commit=${input.source.commit}`) && (!input.fixed || /acquisition=verified\b/u.test(status))) {
      const head = await command('git', ['rev-parse', 'HEAD'], env, directory);
      if (head !== input.source.commit) throw new Error('Mounted checkout differs from assigned commit');
      return { mode: 'artifactfs', directory, commit: head };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  input.signal.throwIfAborted();
  throw new Error('Checkout acquisition interrupted');
}
