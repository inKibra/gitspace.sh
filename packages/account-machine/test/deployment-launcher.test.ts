import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkspaceTarget, DeploymentLauncher, deploymentSource } from '../src/deployment-launcher.js';
import { ExecutorJournal, type LocalAttachment } from '@gitspace/runtime-machine';
import { RuntimeAttachmentSchema } from '@gitspace/protocol-runtime';
import { releaseRecordSchema, releaseTargetSchema, type LaunchProgress, type ReleaseRecord } from '@gitspace/protocol';
import type { BuiltArtifact } from '@gitspace/deployment';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace release pipeline', () => {
  it('uses edited workspace build code and its transitive imports on each deployment build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-source-builder-'));
    roots.push(root);
    const source = join(root, 'packages/deployment/src');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'builders.ts'), `
      import { mkdir, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { page } from './page.ts';
      export async function buildFrontendTree(_root, output) {
        await mkdir(output, { recursive: true });
        await writeFile(join(output, 'index.html'), page);
        return { path: output, hash: 'sha256:' + new Bun.CryptoHasher('sha256').update('index.html\\0').update(page).update('\\0').digest('hex') };
      }
    `);
    await writeFile(join(source, 'page.ts'), 'export const page = \"first source page\";');
    const first = await buildWorkspaceTarget<BuiltArtifact>(root, 'first', 'frontend', join(root, 'first'));
    expect(await readFile(join(first.path, 'index.html'), 'utf8')).toBe('first source page');
    await writeFile(join(source, 'page.ts'), 'export const page = \"edited source page\";');
    const next = await buildWorkspaceTarget<BuiltArtifact>(root, 'next', 'frontend', join(root, 'next'));
    expect(await readFile(join(next.path, 'index.html'), 'utf8')).toBe('edited source page');
    expect(next.hash).not.toBe(first.hash);
  });

  it('rejects a retired OMP target at the release input boundary', () => {
    expect(() => releaseTargetSchema.parse('omp')).toThrow();
  });

});

describe('canonical cache deployment sources', () => {
  function cache(rootPath: string): LocalAttachment {
    return {
      rootPath, executionSecret: 'source-secret', prerequisitesComplete: true,
      attachment: RuntimeAttachmentSchema.parse({
        projectId: 'project', workspaceId: 'workspace', machineId: 'builder', attachmentId: 'cache', generation: 1,
        role: 'cache', state: 'ready', checkout: { kind: 'shared', branch: 'feature/source' }, capabilities: [], updatedAt: '2026-10-01T00:00:00.000Z',
        cache: { state: 'live', platform: 'linux', activity: [], lastActivityAt: '2026-10-01T00:00:00.000Z', pausedAt: null, reclaimAt: null, lastSyncAt: null, localWorkOptIn: false, setup: [] },
      }),
    };
  }

  it.each(['pending', 'failed'] as const)('builds the journal cache and reports %s activation honestly', async activation => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-cache-launch-'));
    roots.push(root);
    const checkout = join(root, 'canonical-checkout');
    await mkdir(join(checkout, 'packages/deployment/src'), { recursive: true });
    await mkdir(join(checkout, 'packages/protocol'), { recursive: true });
    await mkdir(join(checkout, 'packages/account-web'), { recursive: true });
    await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'cache-source-fixture', private: true }));
    await writeFile(join(checkout, 'packages/protocol/package.json'), JSON.stringify({ name: '@gitspace/protocol' }));
    await writeFile(join(checkout, 'packages/account-web/package.json'), JSON.stringify({ name: '@gitspace/account-web', gitspace: { inferenceVersion: 1 } }));
    await writeFile(join(checkout, 'selected-source.txt'), 'built from the cloud cache');
    await writeFile(join(checkout, 'packages/deployment/src/builders.ts'), `
      import { mkdir, readFile, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export async function buildFrontendTree(root, output) {
        await mkdir(output, { recursive: true });
        const content = await readFile(join(root, 'selected-source.txt'));
        await writeFile(join(output, 'index.html'), content);
        return { path: output, hash: 'sha256:' + new Bun.CryptoHasher('sha256').update(content).digest('hex') };
      }
    `);
    for (const command of [
      [process.execPath, 'install', '--lockfile-only', '--ignore-scripts'],
      ['git', 'init', '-b', 'main'],
      ['git', 'add', '.'],
      ['git', '-c', 'user.name=Cache Test', '-c', 'user.email=cache@example.invalid', 'commit', '-m', 'source'],
    ]) {
      const child = Bun.spawn(command, { cwd: checkout, stdout: 'pipe', stderr: 'pipe' });
      if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
    }
    const journal = new ExecutorJournal(join(root, 'attempts.sqlite'));
    journal.installAttachment(cache(checkout));
    const uploaded = new Map<string, string>();
    const progress: LaunchProgress[] = [];
    let staged: ReleaseRecord | null = null;
    const completed = Promise.withResolvers<void>();
    const launcher = new DeploymentLauncher({
      attachments: () => journal.attachments(), machineId: 'builder', buildRoot: join(root, 'builds'),
      blobs: { put: async (key, bytes) => { uploaded.set(key, new TextDecoder().decode(bytes)); return `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`; } },
      authority: {
        reportLaunchProgress: async value => { progress.push(value); if (value.status !== 'running') completed.resolve(); },
        stageRelease: async input => {
          staged = releaseRecordSchema.parse({ ...input, builtBy: 'builder', createdAt: new Date().toISOString(), status: { worker: 'skipped', frontend: 'pending', machines: {} }, error: null });
          return staged;
        },
        launchRelease: async sha => {
          if (!staged || staged.sha !== sha) throw new Error('Release was not staged');
          staged.status.frontend = activation;
          staged.error = activation === 'failed' ? 'Deployment rejected by platform' : null;
          return { record: staged, desired: { worker: null, machine: null, frontend: sha, updatedAt: new Date().toISOString() } };
        },
      },
    });
    try {
      const launched = launcher.launchAndWait({ workspaceId: 'workspace', targets: ['frontend'] });
      if (activation === 'failed') {
        await expect(launched).rejects.toThrow();
        await completed.promise;
        expect(progress.at(-1)).toMatchObject({ status: 'failed', phase: 'failed' });
        expect(progress.at(-1)?.error).not.toBeNull();
      } else {
        const record = await launched;
        await completed.promise;
        expect(record.workspaceId).toBe('workspace');
        expect(progress.at(-1)).toMatchObject({ status: 'succeeded', error: null });
      }
      expect([...uploaded.entries()].find(([key]) => key.endsWith('/index.html'))?.[1]).toBe('built from the cloud cache');
      expect(existsSync(join(root, 'gitspace.db'))).toBe(false);
    } finally { journal.close(); }
  });

  it.each(['attaching', 'draining', 'detached', 'lost'] as const)('refuses a %s cache instead of building its retained files', state => {
    const local = cache('/retained');
    expect(() => deploymentSource([{ ...local, attachment: { ...local.attachment, state } }], 'builder', 'workspace')).toThrow('ready live cache');
  });

  it.each(['paused', 'reclaimed', 'setup', 'draining'] as const)('refuses a cache whose observation is %s', state => {
    const local = cache('/not-live');
    expect(() => deploymentSource([{ ...local, attachment: { ...local.attachment, cache: { ...local.attachment.cache!, state } } }], 'builder', 'workspace')).toThrow('ready live cache');
  });

  it('requires completed prerequisites and exact workspace, machine, and cache role', () => {
    const local = cache('/selected');
    expect(() => deploymentSource([{ ...local, prerequisitesComplete: false }], 'builder', 'workspace')).toThrow('ready live cache');
    expect(() => deploymentSource([local], 'other-machine', 'workspace')).toThrow('Attach workspace');
    expect(() => deploymentSource([local], 'builder', 'other-workspace')).toThrow('Attach workspace');
    expect(() => deploymentSource([{ ...local, attachment: { ...local.attachment, role: 'runner' } }], 'builder', 'workspace')).toThrow('Attach workspace');
    expect(() => deploymentSource([], 'builder', 'workspace')).toThrow('Attach workspace');
  });

  it('reads an existing recovery journal without writes or requiring a fresh heartbeat', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-readonly-cache-'));
    roots.push(root);
    const path = join(root, 'attempts.sqlite');
    const writer = new ExecutorJournal(path);
    writer.installAttachment(cache(join(root, 'checkout')));
    writer.close();
    const reader = new ExecutorJournal(path, { readonly: true });
    try {
      expect(deploymentSource(reader.attachments(), 'builder', 'workspace').rootPath).toBe(join(root, 'checkout'));
      expect(() => reader.installAttachment(cache(join(root, 'other')))).toThrow();
      expect(reader.attachments()[0]?.rootPath).toBe(join(root, 'checkout'));
    } finally { reader.close(); }
    const missing = join(root, 'missing.sqlite');
    expect(() => new ExecutorJournal(missing, { readonly: true })).toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});
