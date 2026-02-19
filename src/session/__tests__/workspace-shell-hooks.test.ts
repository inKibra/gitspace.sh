import { describe, expect, it } from 'bun:test';
import { buildWorkspaceSessionHooks } from '../workspace-shell-hooks.js';

describe('buildWorkspaceSessionHooks', () => {
  it('injects workspace environment context', () => {
    const hooks = buildWorkspaceSessionHooks('acme', 'feature-1');

    expect(hooks.env).toEqual({
      GSSH_SESSION_MODE: 'workspace',
      GSSH_SPACE_PROJECT: 'acme',
      GSSH_SPACE_WORKSPACE: 'feature-1',
    });
  });

  it('builds bash and zsh space function with escaped args', () => {
    const hooks = buildWorkspaceSessionHooks("acme's repo", 'feat one');

    const expected =
      `space() { GSSH_SPACE_PROJECT='acme'\\''s repo' GSSH_SPACE_WORKSPACE='feat one' gssh space "$@"; }`;

    expect(hooks.shellInit?.bash).toBe(expected);
    expect(hooks.shellInit?.zsh).toBe(expected);
  });
});
