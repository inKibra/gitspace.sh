import { env, runInDurableObject } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { executionHash, type LifecycleActor, type LifecycleExecution, type LifecycleState } from '@gitspace/protocol-environment';
import { network } from './network.js';

afterEach(() => { vi.restoreAllMocks(); });

const API = 'https://api.github.com';
const TIP = '1'.repeat(40);
const LIFECYCLE = '.gitspace/lifecycle/machine/prepare';
const machine: LifecycleActor = { actorId: 'machine-a', machineId: 'machine-a', kind: 'machine', lifecycleControl: false };

/** One file at the base branch tip: its content, the commit that last changed it, and the pull requests GitHub
 * associates with that commit. */
interface TipFile { name: string; content: string; commit: string; pulls: Array<{ number: number; merged_at: string | null; base: { ref: string } }> }

const TIP_FILES: TipFile[] = [
  { name: '01-merged.sh', content: 'echo merged\n', commit: 'a'.repeat(40), pulls: [{ number: 1340, merged_at: '2026-11-01T00:00:00Z', base: { ref: 'main' } }] },
  { name: '02-direct.sh', content: 'echo pushed straight to main\n', commit: 'b'.repeat(40), pulls: [] },
  { name: '03-open.sh', content: 'echo from an open pull request\n', commit: 'c'.repeat(40), pulls: [{ number: 77, merged_at: null, base: { ref: 'main' } }] },
  { name: '04-elsewhere.sh', content: 'echo merged into another branch\n', commit: 'd'.repeat(40), pulls: [{ number: 78, merged_at: '2026-11-01T00:00:00Z', base: { ref: 'develop' } }] },
];

/** The repository on GitHub as its REST API serves the tip's lifecycle scripts; `requests` counts every call. */
function github(files: TipFile[], reachable: { value: boolean }) {
  const requests: string[] = [];
  network.use(http.get(`${API}/repos/inKibra/pantry/*`, ({ request }) => {
    const url = new URL(request.url);
    requests.push(`${url.pathname}${url.search}`);
    if (!reachable.value) return HttpResponse.error();
    const rest = url.pathname.slice('/repos/inKibra/pantry/'.length);
    if (rest.startsWith('contents/')) {
      if (rest !== `contents/${LIFECYCLE}` || url.searchParams.get('ref') !== TIP) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      return HttpResponse.json(files.map(file => ({ type: 'file', path: `${LIFECYCLE}/${file.name}`, sha: `blob-${file.name}`, size: file.content.length })));
    }
    if (rest === 'commits') {
      const file = files.find(entry => `${LIFECYCLE}/${entry.name}` === url.searchParams.get('path'));
      return HttpResponse.json(file && url.searchParams.get('sha') === TIP ? [{ sha: file.commit }] : []);
    }
    const pulls = /^commits\/([0-9a-f]{40})\/pulls$/u.exec(rest);
    if (pulls) return HttpResponse.json(files.find(file => file.commit === pulls[1])?.pulls ?? []);
    const blob = /^git\/blobs\/blob-(.+)$/u.exec(rest);
    const file = blob ? files.find(entry => entry.name === blob[1]) : undefined;
    if (file) return HttpResponse.json({ content: btoa(file.content), encoding: 'base64' });
    return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
  }));
  return requests;
}

/** A project on github.com/inKibra/pantry whose base branch tip GitSpace recorded as `TIP`, with one workspace. */
async function project() {
  const projectId = `trust-${crypto.randomUUID()}`;
  const workspaceId = `${projectId}-worker`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: projectId, repositoryReference: 'https://github.com/inKibra/pantry.git', baseBranch: 'main', createdBy: 'machine-a' });
  await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'worker', branch: 'worker', phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  await runInDurableObject(authority, (_instance, context) => { context.storage.sql.exec('UPDATE project SET remote_head=?,remote_checked_at=?,remote_behind=0', TIP, new Date().toISOString()); });
  const space = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`);
  const identity = { projectId, workspaceId };
  /** The workspace's derived scripts, configured as the cloud's derivation or a machine's would. */
  const configure = async (scripts: Array<{ name: string; content: string }>): Promise<LifecycleState> => {
    const executions = await Promise.all(scripts.map(async ({ name, content }): Promise<LifecycleExecution> => ({
      id: `machine/prepare:${name}`, kind: 'script', label: name, command: `${LIFECYCLE}/${name}`, phase: 'machine/prepare', fileName: name, content, hash: await executionHash({ kind: 'script', command: content }),
    })));
    const result = await space.mutateLifecycleState(identity, { op: 'configure', bundleJson: JSON.stringify({ version: 1, profiles: { base: {} } }), executions }, machine);
    if (result.status === 'error') throw new Error(result.failure.message);
    return result.state;
  };
  return { configure };
}

const hashOf = (content: string) => executionHash({ kind: 'script', command: content });

it('approves for the project only base-tip content whose last change came through a pull request merged into the base branch', async () => {
  const requests = github(TIP_FILES, { value: true });
  const p = await project();
  const state = await p.configure([
    ...TIP_FILES.map(({ name, content }) => ({ name, content })),
    // A workspace's edit of a merged file, and content that exists only on a pull request branch.
    { name: '05-changed.sh', content: 'echo merged\nrm -rf "$HOME/cache"\n' },
    { name: '06-branch.sh', content: 'echo only on feature/pr-branch\n' },
  ]);
  expect(state.approvals).toEqual([{ scope: 'project', executionHash: await hashOf('echo merged\n'), approvedAt: expect.any(String), approvedBy: 'github:merged:#1340' }]);
  // The tip was read once: another derivation at the same tip asks GitHub nothing.
  const asked = requests.length;
  await p.configure([{ name: '07-new.sh', content: 'echo added in the workspace\n' }]);
  expect(requests).toHaveLength(asked);
});

it('approves nothing while GitHub is unreachable, and applies the rule once it answers', async () => {
  const reachable = { value: false };
  github(TIP_FILES, reachable);
  const p = await project();
  const scripts = [{ name: '01-merged.sh', content: 'echo merged\n' }];
  expect((await p.configure(scripts)).approvals).toEqual([]);
  reachable.value = true;
  expect((await p.configure([...scripts, { name: '02-direct.sh', content: 'echo pushed straight to main\n' }])).approvals).toEqual([
    expect.objectContaining({ scope: 'project', executionHash: await hashOf('echo merged\n'), approvedBy: 'github:merged:#1340' }),
  ]);
});

it('reads a new base branch tip when GitSpace records it, before any workspace derives its scripts', async () => {
  github(TIP_FILES, { value: true });
  vi.spyOn(ArtifactsCodeStore.prototype, 'resolveRef').mockResolvedValue(null);
  const projectId = `trust-${crypto.randomUUID()}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: projectId, repositoryReference: 'https://github.com/inKibra/pantry.git', baseBranch: 'main', createdBy: 'machine-a' });
  expect((await authority.environmentShared()).approvals).toEqual([]);
  await authority.recordRemoteHeads([{ branch: 'main', head: TIP }]);
  await vi.waitFor(async () => expect((await authority.environmentShared()).approvals).toEqual([
    expect.objectContaining({ scope: 'project', executionHash: await hashOf('echo merged\n'), approvedBy: 'github:merged:#1340' }),
  ]));
});
