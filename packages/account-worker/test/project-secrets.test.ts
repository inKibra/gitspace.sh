import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import type { ProjectSecretsDO } from '../src/project-secrets.js';

describe('ProjectSecretsDO', () => {
  it('stores encrypted write-only project secrets and materializes requested names', async () => {
    const stub = env.PROJECT_SECRETS.getByName(`secrets-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: ProjectSecretsDO) => {
      instance.bootstrap({ userId: 'user-a', vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(9)) });
      const first = await instance.put({ projectId: 'project-a', name: 'api_token', value: 'first-value', updatedBy: 'machine-a' });
      expect(first).toMatchObject({ projectId: 'project-a', name: 'API_TOKEN', revision: 1, updatedBy: 'machine-a' });
      expect(instance.list('project-a')).toEqual([first]);
      expect(JSON.stringify(instance.list('project-a'))).not.toContain('first-value');
      expect(await instance.materialize('project-a', ['API_TOKEN', 'MISSING'], null)).toEqual({ API_TOKEN: 'first-value' });

      const replaced = await instance.put({ projectId: 'project-a', name: 'API_TOKEN', value: 'second-value', updatedBy: 'machine-b' });
      expect(replaced.revision).toBe(2);
      expect(await instance.materialize('project-a', [], null)).toEqual({ API_TOKEN: 'second-value' });
      expect(instance.delete('project-a', 'API_TOKEN')).toBe(true);
      expect(instance.delete('project-a', 'API_TOKEN')).toBe(false);
      expect(instance.list('project-a')).toEqual([]);
    });
  });

  it('keeps encrypted account secrets write-only and revokes access without leaving stale grants', async () => {
    const stub = env.PROJECT_SECRETS.getByName(`secrets-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: ProjectSecretsDO, state) => {
      instance.bootstrap({ userId: 'user-a', vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(9)) });
      const first = await instance.putAccount({ name: 'api_token', value: 'account-first-value', updatedBy: 'machine-a' });
      expect(first).toMatchObject({ name: 'API_TOKEN', revision: 1, updatedBy: 'machine-a', grants: [] });
      expect(instance.listAccount()).toEqual([first]);
      expect(JSON.stringify(instance.listAccount())).not.toContain('account-first-value');
      const stored = state.storage.sql.exec<{ sealed_value: string }>('SELECT sealed_value FROM account_secrets WHERE name = ?', 'API_TOKEN').one();
      expect(stored.sealed_value).not.toContain('account-first-value');
      expect(new TextDecoder().decode(credentialProtocolBase64.decode(stored.sealed_value))).not.toContain('account-first-value');
      expect(await instance.materialize('project-a', [], null)).toEqual({});

      const granted = instance.grantAccount({ name: 'API_TOKEN', projectId: 'project-a' });
      expect(granted.grants).toEqual([{ projectId: 'project-a', projectSpaceEnabled: true, workspacesEnabled: true }]);
      expect(await instance.materialize('project-a', ['API_TOKEN', 'MISSING'], null)).toEqual({ API_TOKEN: 'account-first-value' });
      expect(await instance.materialize('project-a', [], 'workspace-a')).toEqual({ API_TOKEN: 'account-first-value' });
      expect(await instance.materialize('project-b', [], null)).toEqual({});
      const replaced = await instance.putAccount({ name: 'API_TOKEN', value: 'account-second-value', updatedBy: 'machine-b' });
      expect(replaced.revision).toBe(2);
      expect(replaced.grants).toEqual(granted.grants);
      expect(await instance.materialize('project-a', [], null)).toEqual({ API_TOKEN: 'account-second-value' });

      expect(instance.revokeAccount('API_TOKEN', 'project-a')).toEqual({ ...replaced, grants: [] });
      expect(instance.revokeAccount('API_TOKEN', 'project-a')).toEqual({ ...replaced, grants: [] });
      expect(instance.listEffective('project-a', null)).toEqual([]);
      expect(await instance.materialize('project-a', ['API_TOKEN'], null)).toEqual({});
      expect(await instance.materialize('project-a', [], 'workspace-a')).toEqual({});
      instance.grantAccount({ name: 'API_TOKEN', projectId: 'project-a' });
      expect(instance.deleteAccount('API_TOKEN')).toBe(true);
      expect(instance.deleteAccount('API_TOKEN')).toBe(false);
      expect(instance.listAccount()).toEqual([]);
      expect(() => instance.grantAccount({ name: 'API_TOKEN', projectId: 'project-a' })).toThrow();
      expect(() => instance.revokeAccount('API_TOKEN', 'project-a')).toThrow();
      await instance.putAccount({ name: 'API_TOKEN', value: 'recreated-value', updatedBy: 'machine-a' });
      expect(await instance.materialize('project-a', [], null)).toEqual({});
    });
  });

  it('applies account grants separately to project spaces and workspaces with project precedence', async () => {
    const stub = env.PROJECT_SECRETS.getByName(`secrets-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: ProjectSecretsDO) => {
      instance.bootstrap({ userId: 'user-a', vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(4)) });
      const shared = await instance.putAccount({ name: 'API_TOKEN', value: 'shared-value', updatedBy: 'machine-a' });
      instance.grantAccount({ name: 'API_TOKEN', projectId: 'project-a', projectSpaceEnabled: false });
      expect(await instance.materialize('project-a', [], null)).toEqual({});
      expect(await instance.materialize('project-a', [], 'workspace-a')).toEqual({ API_TOKEN: 'shared-value' });
      expect(instance.listEffective('project-a', 'workspace-a')).toEqual([{
        name: shared.name, revision: shared.revision, updatedAt: shared.updatedAt, updatedBy: shared.updatedBy,
        source: 'account', projectId: 'project-a',
      }]);
      instance.grantAccount({ name: 'API_TOKEN', projectId: 'project-a', workspacesEnabled: false });
      expect(await instance.materialize('project-a', [], null)).toEqual({ API_TOKEN: 'shared-value' });
      expect(await instance.materialize('project-a', [], 'workspace-a')).toEqual({});
      expect(instance.listEffective('project-a', 'workspace-a')).toEqual([]);

      const project = await instance.put({ projectId: 'project-a', name: 'API_TOKEN', value: 'project-value', updatedBy: 'machine-b' });
      expect(await instance.materialize('project-a', [], null)).toEqual({ API_TOKEN: 'project-value' });
      expect(await instance.materialize('project-a', [], 'workspace-a')).toEqual({ API_TOKEN: 'project-value' });
      expect(instance.listEffective('project-a', null)).toEqual([{ ...project, source: 'project' }]);
      instance.delete('project-a', 'API_TOKEN');
      expect(await instance.materialize('project-a', [], null)).toEqual({ API_TOKEN: 'shared-value' });
      expect(await instance.materialize('project-a', [], 'workspace-a')).toEqual({});
      instance.grantAccount({ name: 'API_TOKEN', projectId: 'project-a', projectSpaceEnabled: false, workspacesEnabled: false });
      expect(await instance.materialize('project-a', [], null)).toEqual({});
      expect(await instance.materialize('project-a', [], 'workspace-a')).toEqual({});
    });
  });

  it('rejects transplanted account ciphertext in a project secret row', async () => {
    const stub = env.PROJECT_SECRETS.getByName(`secrets-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: ProjectSecretsDO, state) => {
      instance.bootstrap({ userId: 'user-a', vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(4)) });
      await instance.putAccount({ name: 'API_TOKEN', value: 'shared-value', updatedBy: 'machine-a' });
      await instance.put({ projectId: 'project-a', name: 'API_TOKEN', value: 'project-value', updatedBy: 'machine-a' });
      state.storage.sql.exec('UPDATE project_secrets SET sealed_value = (SELECT sealed_value FROM account_secrets WHERE name = ?) WHERE project_id = ? AND name = ?', 'API_TOKEN', 'project-a', 'API_TOKEN');
      await expect(instance.materialize('project-a', [], null)).rejects.toThrow();
    });
  });

  it('serializes concurrent encrypted writes without losing revisions', async () => {
    const stub = env.PROJECT_SECRETS.getByName(`secrets-${crypto.randomUUID()}`);
    await stub.bootstrap({ userId: 'user-a', vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(4)) });
    const values = ['first-value', 'second-value', 'third-value'];
    const accountWrites = await Promise.all(values.map((value) => stub.putAccount({ name: 'API_TOKEN', value, updatedBy: 'machine-a' })));
    expect(accountWrites.map((row) => row.revision).sort()).toEqual([1, 2, 3]);
    await stub.grantAccount({ name: 'API_TOKEN', projectId: 'project-a' });
    expect(await stub.materialize('project-a', [], null)).toEqual({ API_TOKEN: values[accountWrites.findIndex((row) => row.revision === 3)] });

    const projectWrites = await Promise.all(values.map((value) => stub.put({ projectId: 'project-a', name: 'API_TOKEN', value, updatedBy: 'machine-a' })));
    expect(projectWrites.map((row) => row.revision).sort()).toEqual([1, 2, 3]);
    expect(await stub.materialize('project-a', [], null)).toEqual({ API_TOKEN: values[projectWrites.findIndex((row) => row.revision === 3)] });
  });

  it('rejects invalid names and oversized values', async () => {
    const stub = env.PROJECT_SECRETS.getByName(`secrets-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: ProjectSecretsDO) => {
      instance.bootstrap({ userId: 'user-a', vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(4)) });
      await expect(instance.put({ projectId: 'project-a', name: 'bad-name', value: 'x', updatedBy: 'machine-a' })).rejects.toThrow('uppercase environment variable');
      await expect(instance.put({ projectId: 'project-a', name: 'BIG', value: 'x'.repeat(70_000), updatedBy: 'machine-a' })).rejects.toThrow('64 KiB');
    });
  });
});
