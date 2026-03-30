import { describe, expect, it } from 'bun:test';
import { buildWorkspaceSessionCommand, buildWorkspaceSessionHooks, resolveWorkspaceSessionLauncherArgs } from '../workspace-shell-hooks.js';

describe('buildWorkspaceSessionHooks', () => {
  it('injects workspace environment context', () => {
    const hooks = buildWorkspaceSessionHooks('acme', 'feature-1', ['gssh']);

    expect(hooks.env).toEqual({
      GSSH_SESSION_MODE: 'workspace',
      GSSH_SPACE_PROJECT: 'acme',
      GSSH_SPACE_WORKSPACE: 'feature-1',
    });
  });

  it('builds bash and zsh space function with escaped args', () => {
    const hooks = buildWorkspaceSessionHooks("acme's repo", 'feat one', ['gssh']);

    const expected =
      `space() { GSSH_SPACE_PROJECT='acme'\\''s repo' GSSH_SPACE_WORKSPACE='feat one' gssh space "$@"; }`;

    expect(hooks.shellInit?.bash).toBe(expected);
    expect(hooks.shellInit?.zsh).toBe(expected);
  });

  it('supports launcher commands with spaces', () => {
    const hooks = buildWorkspaceSessionHooks('acme', 'feature-1', ['bun', '/tmp/dev repo/src/index.ts']);

    const expected =
      `space() { GSSH_SPACE_PROJECT='acme' GSSH_SPACE_WORKSPACE='feature-1' bun '/tmp/dev repo/src/index.ts' space "$@"; }`;

    expect(hooks.shellInit?.bash).toBe(expected);
    expect(hooks.shellInit?.zsh).toBe(expected);
  });
});

describe('buildWorkspaceSessionCommand', () => {
  it('reuses the current launcher strategy for workspace commands', () => {
    expect(buildWorkspaceSessionCommand(['commit'], ['bun', '/tmp/dev repo/src/index.ts'])).toEqual({
      command: 'bun',
      args: ['/tmp/dev repo/src/index.ts', 'space', 'commit'],
    });
  });
});

describe('resolveWorkspaceSessionLauncherArgs', () => {
  it('targets the main gssh entrypoint when running under bun', () => {
    const launcher = resolveWorkspaceSessionLauncherArgs();

    expect(launcher[0]).toBe(process.execPath);
    expect(launcher[1]).toContain('/src/index.ts');
    expect(launcher[1]).not.toContain('/lib/tmux-lite/server.ts');
  });
});
