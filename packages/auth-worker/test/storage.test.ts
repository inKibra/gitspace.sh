import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { CloudflareR2PlatformClient, UserStorageDO } from '../src/storage.js';

describe('user storage authority', () => {
  it('keeps the user-to-bucket mapping immutable across provisioning retries', async () => {
    const stub = env.USER_STORAGE.getByName('user-a');
    const first = await runInDurableObject(stub, (_instance: UserStorageDO) => _instance.beginProvisioning({ userId: 'user-a', gitBucketName: 'gsp-u-user-a' }));
    expect(first).toMatchObject({ userId: 'user-a', gitBucketName: 'gsp-u-user-a', state: 'provisioning' });
    const retry = await runInDurableObject(stub, (_instance: UserStorageDO) => _instance.beginProvisioning({ userId: 'user-a', gitBucketName: 'gsp-u-user-a' }));
    expect(retry.gitBucketName).toBe(first.gitBucketName);
    await expect(runInDurableObject(stub, (_instance: UserStorageDO) => _instance.beginProvisioning({ userId: 'user-a', gitBucketName: 'gsp-u-different' }))).rejects.toThrow('immutable');
    const ready = await runInDurableObject(stub, (_instance: UserStorageDO) => _instance.markReady({ userId: 'user-a', gitBucketName: 'gsp-u-user-a' }));
    expect(ready.state).toBe('ready');
    const required = await runInDurableObject(stub, (_instance: UserStorageDO) => _instance.requireReady('user-a'));
    expect(required.gitBucketName).toBe('gsp-u-user-a');
  });

  it('provisions a bucket and mints project-prefix temporary credentials without exposing the parent secret', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      if (String(input).endsWith('/r2/buckets')) return Response.json({ success: true, result: { name: 'gsp-u-user-a' } });
      return Response.json({ success: true, result: { accessKeyId: 'temporary-id', secretAccessKey: 'temporary-secret', sessionToken: 'temporary-session' } });
    };
    const client = new CloudflareR2PlatformClient({
      accountId: 'account-a',
      apiToken: 'platform-api-token',
      parentAccessKeyId: 'parent-access-id',
      fetcher,
      now: () => 1_000,
    });
    await client.createBucket({ bucketName: 'gsp-u-user-a' });
    const credentials = await client.mintTemporaryCredentials({
      bucketName: 'gsp-u-user-a',
      prefixes: ['projects/project-a/repo/'],
      ttlSeconds: 3_600,
    });
    expect(credentials).toEqual({
      accessKeyId: 'temporary-id',
      secretAccessKey: 'temporary-secret',
      sessionToken: 'temporary-session',
      expiresAt: new Date(3_601_000).toISOString(),
    });
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[1]!.init!.body))).toEqual({
      bucket: 'gsp-u-user-a',
      parentAccessKeyId: 'parent-access-id',
      permission: 'object-read-write',
      ttlSeconds: 3_600,
      prefixes: ['projects/project-a/repo/'],
    });
    expect(JSON.stringify(requests)).not.toContain('parent-secret');
  });
});
