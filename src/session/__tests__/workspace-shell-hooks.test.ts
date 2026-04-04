import { describe, expect, it } from 'bun:test';
import {
  buildWorkspaceScopedExecCommand,
  buildWorkspaceSessionCommand,
  buildWorkspaceSessionEnv,
  buildWorkspaceSessionHooks,
  resolveWorkspaceSessionLauncherArgs,
} from '../workspace-shell-hooks.js';

describe('buildWorkspaceSessionEnv', () => {
  it('injects workspace environment context', () => {
    expect(buildWorkspaceSessionEnv('acme', 'feature-1')).toEqual({
      GSSH_SESSION_MODE: 'workspace',
      GSSH_SPACE_PROJECT: 'acme',
      GSSH_SPACE_WORKSPACE: 'feature-1',
    });
  });
});

describe('buildWorkspaceSessionHooks', () => {
  it('injects workspace environment context', () => {
    const hooks = buildWorkspaceSessionHooks('acme', 'feature-1', ['gssh']);

    expect(hooks.env).toEqual(buildWorkspaceSessionEnv('acme', 'feature-1'));
  });

  it('builds bash and zsh space function with escaped args', () => {
    const hooks = buildWorkspaceSessionHooks("acme's repo", 'feat one', ['gssh']);

    const expected =
      String.raw`space() { GSSH_SPACE_PROJECT='acme'\''s repo' GSSH_SPACE_WORKSPACE='feat one' gssh space "$@"; }`;

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

describe('buildWorkspaceScopedExecCommand', () => {
  it('wraps workspace commands in a scoped env invocation', () => {
    expect(buildWorkspaceScopedExecCommand('acme', 'feature-1', ['review', 'list'], ['bun', '/tmp/dev repo/src/index.ts'])).toEqual({
      command: 'env',
      args: [
        'GSSH_SESSION_MODE=workspace',
        'GSSH_SPACE_PROJECT=acme',
        'GSSH_SPACE_WORKSPACE=feature-1',
        'bun',
        '/tmp/dev repo/src/index.ts',
        'space',
        'review',
        'list',
      ],
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
