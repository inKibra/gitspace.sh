import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudProjectSummary, CloudWorkspaceDefinition } from '@gitspace/protocol';
import { CredentialVaultDO } from '../src/application.js';
import { ProjectAuthorityDO, UserProjectIndexDO } from '../src/project-authority.js';
import { SpaceAuthorityDO } from '../src/space-authority.js';
import { BudgetedDurableObject } from '../src/storage-quarantine.js';
import { acrossRelease, ReleaseUpdatingError, restartObjectsForRelease } from '../src/release-worker.js';
import { browser } from './fixtures/passkeys.js';

afterEach(() => vi.restoreAllMocks());

/** What a Durable Object still on code from before a release answers for a method that release added. */
const outdated = (method: string) => new TypeError(`The RPC receiver does not implement the method "${method}".`);
const timestamp = '2026-11-20T00:00:00.000Z';
const project: CloudProjectSummary = { id: 'rollout-project', name: 'Rollout', lifecycle: 'active', repositoryReference: null, baseBranch: 'main', revision: 1, remote: null, archivedAt: null, updatedAt: timestamp, role: null, source: null };
const workspace: CloudWorkspaceDefinition = { id: 'rollout-space', projectId: project.id, kind: 'worktree', name: 'Rollout space', branch: 'feature', phase: 'code', sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, revision: 1, remote: null, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };

describe('objects left on older code by a release', () => {
  it('an account object on another release restarts on the new code; one on this release stays', async () => {
    // A fresh stub per call: one bound to a restarted instance stays broken.
    const vault = () => env.CREDENTIALS.getByName(env.ACCOUNT_ID);
    const instance = () => runInDurableObject(vault(), (current: CredentialVaultDO) => current);
    const running = await instance();
    expect(await vault().restartForRelease('test-inference-worker')).toBe('current');
    expect(await instance()).toBe(running);
    expect(await vault().restartForRelease('next-release')).toBe('restarting');
    await vi.waitFor(async () => expect(await instance()).not.toBe(running));
  });

  it('a live release reaches the account\'s objects, each project\'s and each workspace\'s, and the release object last', async () => {
    vi.spyOn(UserProjectIndexDO.prototype, 'list').mockReturnValue([project]);
    vi.spyOn(ProjectAuthorityDO.prototype, 'listWorkspaces').mockReturnValue([workspace]);
    const told: string[] = [];
    vi.spyOn(BudgetedDurableObject.prototype, 'restartForRelease').mockImplementation(async function (this: BudgetedDurableObject) { told.push(this.constructor.name); return 'current'; });
    vi.spyOn(SpaceAuthorityDO.prototype, 'restartForRelease').mockImplementation(async function (this: SpaceAuthorityDO) { told.push(this.constructor.name); return 'when-idle'; });
    await restartObjectsForRelease(env, env.ACCOUNT_ID, 'next-release');
    expect(told.at(-1)).toBe('TenantReleasesDO');
    expect(told.slice(0, -1).sort()).toEqual([
      'AccountStateDO', 'AccountStateDO', 'CredentialVaultDO', 'FleetCatalogDO', 'GitHubAppDO', 'ProjectAuthorityDO', 'ProjectAutomationsDO', 'ProjectChatterDO', 'ProjectSecretsDO',
      'SpaceAuthorityDO', 'UserMcpConnectionsDO', 'UserProjectIndexDO', 'UserRelayDO', 'UserSettingsDO', 'UserSkillsDO', 'UserStorageDO',
    ]);
  });
});

describe('calling a method a recent release added', () => {
  it('retries while the object answers from older code, then gets the answer', async () => {
    let calls = 0;
    expect(await acrossRelease(async () => {
      calls += 1;
      if (calls < 3) throw outdated('secureInputRecord');
      return 'recorded';
    })).toBe('recorded');
    expect(calls).toBe(3);
  });

  it('says GitSpace is finishing an update when the object stays on older code, and passes any other error at once', async () => {
    let calls = 0;
    await expect(acrossRelease(async () => { calls += 1; throw outdated('secureInputRecord'); })).rejects.toThrow(ReleaseUpdatingError);
    expect(calls).toBe(5);
    calls = 0;
    await expect(acrossRelease(async () => { calls += 1; throw new TypeError('Cannot read properties of undefined'); })).rejects.toThrow('Cannot read properties of undefined');
    expect(calls).toBe(1);
  });

  it('a passkey sign-in reaches a vault that catches up, and answers 503 RELEASE_UPDATING while it does not', async () => {
    await browser();
    const signInOptions = () => SELF.fetch(new URL('/v1/passkeys/sign-in/options', env.ACCOUNT_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const before = vi.spyOn(CredentialVaultDO.prototype, 'passkeySignInOptions').mockImplementationOnce(() => { throw outdated('passkeySignInOptions'); });
    const caughtUp = await signInOptions();
    expect(before).toHaveBeenCalledTimes(2);
    expect(caughtUp.status).not.toBe(503);
    before.mockRestore();
    vi.spyOn(CredentialVaultDO.prototype, 'passkeySignInOptions').mockImplementation(() => { throw outdated('passkeySignInOptions'); });
    const stale = await signInOptions();
    expect(stale.status).toBe(503);
    expect(await stale.json()).toMatchObject({ error: { code: 'RELEASE_UPDATING', message: 'GitSpace is finishing an update. Try again in a minute.' } });
  });
});
