import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('install domains', () => {
  it('tells the browser app the install\'s domains', async () => {
    const response = await SELF.fetch('https://account.test/v1/domains');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ account: 'account.test', service: 'relay.test' });
  });
});
