import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';


describe('durable subscription ownership', () => {
  it('ends an idle producer when its remote owner is disposed, without another mutation', async () => {
    const authority = env.USER_PROJECTS.getByName('idle-stream-disposal');
    const subscription = await authority.watch(null);
    const reader = subscription.stream.getReader();
    try {
      const initial = await reader.read();
      expect(initial.done).toBe(false);
      expect(JSON.parse(new TextDecoder().decode(initial.value))).toMatchObject({ type: 'snapshot', resource: 'projects', value: [] });
      const pending = reader.read();
      subscription[Symbol.dispose]();
      expect(await pending).toEqual({ done: true, value: undefined });
      expect(await authority.list()).toEqual([]);
    } finally {
      subscription[Symbol.dispose]();
      await reader.cancel();
      reader.releaseLock();
    }
  });
});
