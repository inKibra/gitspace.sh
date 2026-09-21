import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

describe('user storage authority', () => {
  it('keeps the user-to-bucket mapping immutable across provisioning retries', async () => {
    const stub = env.USER_STORAGE.getByName('user-a');
    const first = await stub.beginProvisioning({ userId: 'user-a', gitBucketName: 'gsp-u-user-a' });
    expect(first).toMatchObject({ userId: 'user-a', gitBucketName: 'gsp-u-user-a', state: 'provisioning' });
    const retry = await stub.beginProvisioning({ userId: 'user-a', gitBucketName: 'gsp-u-user-a' });
    expect(retry.gitBucketName).toBe(first.gitBucketName);
    await expect(Promise.resolve(stub.beginProvisioning({ userId: 'user-a', gitBucketName: 'gsp-u-different' }))).rejects.toThrow();
    const ready = await stub.markReady({ userId: 'user-a', gitBucketName: 'gsp-u-user-a' });
    expect(ready.state).toBe('ready');
    const required = await stub.requireReady('user-a');
    expect(required.gitBucketName).toBe('gsp-u-user-a');
    await expect(Promise.resolve(stub.requireReady('user-b'))).rejects.toThrow();
  });
});
