import { describe, expect, it } from 'bun:test';
import { OpenCodeClient } from '../opencode-client';

describe('OpenCodeClient', () => {
  it('trims trailing slashes from baseUrl', () => {
    const client = new OpenCodeClient({
      baseUrl: 'http://localhost:4096/',
      fetch: async () => new Response(JSON.stringify([]), { status: 200 }),
    });

    expect(client.baseUrl).toBe('http://localhost:4096');
  });

  it('requests the expected session endpoint', async () => {
    const seen: string[] = [];
    const client = new OpenCodeClient({
      baseUrl: 'http://localhost:4096/',
      fetch: async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });

    await client.listSessions();

    expect(seen).toEqual(['http://localhost:4096/session']);
  });
});
