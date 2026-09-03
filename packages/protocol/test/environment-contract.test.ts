import { describe, expect, it } from 'bun:test';
import {
  EnvironmentBundleSchema,
  classifyLifecycleScript,
  executionHash,
  resolveEnvironmentProfile,
  resolveEnvironmentValues,
  resolveExecutionApproval,
  selectLifecycleScripts,
  type EnvironmentBundle,
} from '../src/environment-contract.js';

const bundle: EnvironmentBundle = {
  version: 1,
  defaultProfile: 'backend',
  profiles: {
    base: { checks: ['git'], secrets: ['GITHUB_TOKEN'], values: ['LOG_LEVEL'] },
    backend: { checks: ['docker'], secrets: ['DATABASE_URL'], values: ['REGION'] },
    ios: { checks: ['xcode'], secrets: ['APPLE_TEAM_ID'], values: ['APPLE_TEAM'] },
  },
  checks: {
    git: { kind: 'built-in', check: 'git' },
    docker: { kind: 'built-in', check: 'docker' },
    xcode: { kind: 'built-in', check: 'xcode' },
  },
  values: {
    LOG_LEVEL: { default: 'info' },
    REGION: { default: 'us-east-1' },
    APPLE_TEAM: {},
  },
};

describe('EnvironmentBundleSchema', () => {
  it('requires base and rejects references to missing definitions', () => {
    expect(EnvironmentBundleSchema.safeParse(bundle).success).toBe(true);
    expect(EnvironmentBundleSchema.safeParse({ ...bundle, profiles: { ios: bundle.profiles.ios } }).success).toBe(false);
    expect(EnvironmentBundleSchema.safeParse({ ...bundle, profiles: { ...bundle.profiles, backend: { ...bundle.profiles.backend, checks: ['missing'] } } }).success).toBe(false);
  });
});

describe('resolveEnvironmentProfile', () => {
  it('combines reserved base with only the exact selected flat profile', () => {
    expect(resolveEnvironmentProfile(bundle, 'ios')).toEqual({
      name: 'ios',
      checks: ['git', 'xcode'],
      secrets: ['GITHUB_TOKEN', 'APPLE_TEAM_ID'],
      values: ['LOG_LEVEL', 'APPLE_TEAM'],
      notes: [],
    });
    expect(resolveEnvironmentProfile(bundle, 'base').checks).toEqual(['git']);
  });
});

describe('lifecycle script selection', () => {
  const profiles = new Set(['base', 'backend', 'ios']);

  it('runs unqualified scripts plus exact-profile scripts in lexical order', () => {
    expect(selectLifecycleScripts(['20-db.backend.sh', '01-base.sh', '30-xcode.ios.sh', '10-shell.sh'], 'ios', profiles)).toEqual([
      { fileName: '01-base.sh', profile: 'base' },
      { fileName: '10-shell.sh', profile: 'base' },
      { fileName: '30-xcode.ios.sh', profile: 'ios' },
    ]);
  });

  it('rejects malformed names and unknown profile qualifiers', () => {
    expect(() => classifyLifecycleScript('setup.sh', profiles)).toThrow('Invalid lifecycle script name');
    expect(() => classifyLifecycleScript('20-db.cloud.sh', profiles)).toThrow('Unknown lifecycle script profile');
  });
});

describe('approval and value resolution', () => {
  it('prefers matching project approval, then workspace approval, without upward flow', () => {
    expect(resolveExecutionApproval({ executionHash: 'a', projectApprovals: new Set(['a']), workspaceApprovals: new Set(['b']) })).toBe('project');
    expect(resolveExecutionApproval({ executionHash: 'b', projectApprovals: new Set(['a']), workspaceApprovals: new Set(['b']) })).toBe('workspace');
    expect(resolveExecutionApproval({ executionHash: 'c', projectApprovals: new Set(['a']), workspaceApprovals: new Set(['b']) })).toBeNull();
  });

  it('applies global, project, then workspace value precedence', () => {
    expect(resolveEnvironmentValues({ global: { A: 'global', B: 'global' }, project: { B: 'project', C: 'project' }, workspace: { C: 'workspace' } })).toEqual({ A: 'global', B: 'project', C: 'workspace' });
  });

  it('hashes the execution kind and exact command', async () => {
    const first = await executionHash({ kind: 'check', command: 'gh auth status' });
    expect(first).toBe(await executionHash({ kind: 'check', command: 'gh auth status' }));
    expect(first).not.toBe(await executionHash({ kind: 'script', command: 'gh auth status' }));
    expect(first).not.toBe(await executionHash({ kind: 'check', command: 'gh auth status ' }));
  });
});
