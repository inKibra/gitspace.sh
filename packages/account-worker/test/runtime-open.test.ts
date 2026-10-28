import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, test } from 'vitest';
import { RuntimeIdentitySchema, RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { RuntimeQaDocumentSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { ProjectAuthorityDO } from '../src/index.js';
import { appendRuntimeQa } from '../src/runtime-qa.js';
import type { RuntimeIdentity } from '../src/runtime-services.js';

const space = (workspaceId: string) => env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`);
const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

/** Every call to the project object waits until `released` settles, as the live object did for about 20 s while a
 * reconnected machine opened every workspace of its project. Calls the object makes to itself afterwards run as before. */
function stallProject(released: Promise<void>) {
  let open = false;
  void released.then(() => { open = true; });
  for (const name of Object.getOwnPropertyNames(ProjectAuthorityDO.prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(ProjectAuthorityDO.prototype, name);
    if (name === 'constructor' || typeof descriptor?.value !== 'function') continue;
    const original: (...args: unknown[]) => unknown = descriptor.value;
    Object.defineProperty(ProjectAuthorityDO.prototype, name, { ...descriptor, value(this: ProjectAuthorityDO, ...args: unknown[]) { return open ? original.apply(this, args) : released.then(() => original.apply(this, args)); } });
    restores.push(() => Object.defineProperty(ProjectAuthorityDO.prototype, name, descriptor));
  }
}

const issues = async (identity: RuntimeIdentity) => RuntimeQaDocumentSchema.parse(RuntimeSnapshotSchema.parse(await (await space(identity.workspaceId).runtimeSnapshot(identity)).json()).documents['gitspace.qa']).items.map(item => item.title);

test('the workspaces of a project open together, with their issues, while the project object answers nothing', async () => {
  const projectId = `open-${crypto.randomUUID()}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const created = await authority.bootstrap({ id: projectId, name: projectId, repositoryReference: null, baseBranch: 'main', createdBy: 'test' });
  await authority.setProjectLifecycle(created.revision, 'active');
  const workspaces = ['a', 'b', 'c'].map(name => RuntimeIdentitySchema.parse({ projectId, workspaceId: `${projectId}-${name}` }));
  for (const identity of workspaces) {
    await authority.putWorkspace({ id: identity.workspaceId, projectId, kind: 'worktree', name: identity.workspaceId, branch: identity.workspaceId, phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await runInDurableObject(space(identity.workspaceId), (_instance, state) => { appendRuntimeQa(state.storage, identity, crypto.randomUUID(), { message: `Failure in ${identity.workspaceId}` }); });
    // A workspace holds its metadata from its first use on; it is not read from the project again.
    await space(identity.workspaceId).runtimeAccess(identity, false);
  }
  const released = Promise.withResolvers<void>();
  stallProject(released.promise);
  try { expect(await Promise.all(workspaces.map(issues))).toEqual(workspaces.map(identity => [`Failure in ${identity.workspaceId}`])); }
  finally { released.resolve(); }
});
