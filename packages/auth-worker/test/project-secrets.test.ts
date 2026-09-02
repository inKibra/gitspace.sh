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
      expect(await instance.materialize('project-a', ['API_TOKEN', 'MISSING'])).toEqual({ API_TOKEN: 'first-value' });

      const replaced = await instance.put({ projectId: 'project-a', name: 'API_TOKEN', value: 'second-value', updatedBy: 'machine-b' });
      expect(replaced.revision).toBe(2);
      expect(await instance.materialize('project-a', [])).toEqual({ API_TOKEN: 'second-value' });
      expect(instance.delete('project-a', 'API_TOKEN')).toBe(true);
      expect(instance.delete('project-a', 'API_TOKEN')).toBe(false);
      expect(instance.list('project-a')).toEqual([]);
    });
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
