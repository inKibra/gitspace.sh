import { describe, expect, it } from 'bun:test';
import { buildOpenCodeWebUrl } from '../opencode-web';

describe('buildOpenCodeWebUrl', () => {
  it('builds a workspace session route for OpenCode web', () => {
    const url = buildOpenCodeWebUrl({
      runtimeKey: 'machine',
      workspaceId: 'demo:ws',
      workspacePath: '/tmp/demo/workspaces/ws',
      hostname: '127.0.0.1',
      port: 42001,
      baseUrl: 'http://127.0.0.1:42001',
      username: 'gitspace',
      password: 'secret',
      startedAt: '2026-03-14T00:00:00.000Z',
    }, '/tmp/demo/workspaces/ws', 'sess-123');

    expect(url).toContain('/session/sess-123');
    expect(url).toContain('gitspace:secret@127.0.0.1:42001');
  });
});
