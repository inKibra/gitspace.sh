import { afterEach, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpaceSshAgentManager } from '../src/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('loads a brokered key into a per-space agent without writing the private key into the repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-ssh-agent-'));
  roots.push(root);
  const repository = join(root, 'repo');
  const keyPath = join(root, 'proof-key');
  expect(Bun.spawnSync(['git', 'init', '-b', 'main', repository]).exitCode).toBe(0);
  expect(Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', keyPath]).exitCode).toBe(0);
  const privateKey = readFileSync(keyPath, 'utf8');
  rmSync(keyPath, { force: true });
  rmSync(`${keyPath}.pub`, { force: true });

  const manager = new SpaceSshAgentManager({ credential: async () => ({ privateKey }) });
  const agent = await manager.start('space-a', repository);
  expect(existsSync(agent.socketPath)).toBe(true);
  const listed = Bun.spawnSync(['ssh-add', '-l'], { env: { ...Bun.env, SSH_AUTH_SOCK: agent.socketPath } });
  expect(listed.exitCode).toBe(0);
  expect(listed.stdout.toString()).toContain('ED25519');
  const configured = Bun.spawnSync(['git', 'config', '--worktree', '--get', 'core.sshCommand'], { cwd: repository });
  expect(configured.exitCode).toBe(0);
  expect(configured.stdout.toString()).toContain(agent.socketPath);
  expect(Bun.spawnSync(['git', 'status', '--short'], { cwd: repository }).stdout.toString()).not.toContain('PRIVATE KEY');

  await manager.stop('space-a');
  expect(existsSync(agent.socketPath)).toBe(false);
});
