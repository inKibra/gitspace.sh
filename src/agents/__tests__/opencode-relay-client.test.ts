import { describe, expect, it } from 'bun:test';
import { OpenCodeRelayClient } from '../opencode-relay-client';

describe('OpenCodeRelayClient', () => {
  it('lists sessions through the bridge backend', async () => {
    const client = new OpenCodeRelayClient({
      workspaceId: 'project:workspace',
      backend: {
        async requestOpenCode() {
          return {
            requestId: 'req-1',
            status: 200,
            bodyBase64: Buffer.from(JSON.stringify([{ id: 'sess-1' }])).toString('base64'),
          };
        },
        async subscribeOpenCode() {
          return async () => {};
        },
      },
    });

    const sessions = await client.listSessions() as Array<{ id: string }>;
    expect(sessions).toEqual([{ id: 'sess-1' }]);
  });
});
