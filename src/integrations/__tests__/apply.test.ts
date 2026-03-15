import { describe, expect, it } from 'bun:test';

describe('prepareWorkspaceIntegrations', () => {
  it('returns empty env and requiredIntegrationIds (stub - deferred to issue #70)', async () => {
    const { prepareWorkspaceIntegrations } = await import('../apply');
    const result = await prepareWorkspaceIntegrations('demo', '/tmp/demo');

    expect(result.env).toEqual({});
    expect(result.requiredIntegrationIds).toEqual([]);
  });
});
