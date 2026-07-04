/**
 * Integration tests for run-workspace-scripts.ts
 *
 * Exercises the idempotent automatic lifecycle path (discriminated
 * ScriptLifecycleOutcome), explicit rerun, and non-executable script visibility.
 * Uses real temporary directories + scripts. The bundle-refresh mock returns no
 * bundle, so fingerprints reduce to the script manifests — which is exactly what
 * we want to test manifest-driven invalidation.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let mockProjectConfig: {
  repository: string;
  baseBranch: string;
  bundleValues: Record<string, string>;
  bundleSecretKeys: string[];
  bundleConfirmHistory: Record<string, unknown>;
};

let mockSecretStore: Record<string, string>;

type RunWorkspaceScriptsFn = typeof import('../run-workspace-scripts').runWorkspaceScripts;
type RerunWorkspaceBundleScriptsFn = typeof import('../run-workspace-scripts').rerunWorkspaceBundleScripts;
type Outcome = Awaited<ReturnType<RunWorkspaceScriptsFn>>;

function setupModuleMocks(): void {
  mockSecretStore = {};
  mock.module('../../core/config', () => ({
    readProjectConfig: () => mockProjectConfig,
    updateProjectConfig: () => {},
    getProjectBaseDir: () => '/tmp',
    getProjectWorkspacesDir: () => '/tmp',
    getProjectDir: () => '/tmp',
    readGlobalConfig: () => ({ currentProject: null }),
    updateGlobalConfig: () => {},
  }));

  // Mirror the full secrets module surface so this mock never leaks an
  // incomplete API into other test files sharing bun's global module registry.
  mock.module('../secrets', () => ({
    clearSecretsCache: () => {},
    getProjectSecrets: async (_projectName: string, keys: string[]) => {
      const out: Record<string, string> = {};
      for (const key of keys) {
        if (key in mockSecretStore) out[key] = mockSecretStore[key];
      }
      return out;
    },
    getProjectSecret: async (_projectName: string, key: string) => (key in mockSecretStore ? mockSecretStore[key] : null),
    setProjectSecret: async (_projectName: string, key: string, value: string) => { mockSecretStore[key] = value; },
    deleteProjectSecret: async (_projectName: string, key: string) => {
      if (!(key in mockSecretStore)) return false;
      delete mockSecretStore[key];
      return true;
    },
    deleteProjectSecrets: async (_projectName: string, keys: string[]) => { for (const key of keys) delete mockSecretStore[key]; },
    deleteAllProjectSecrets: async () => { for (const key of Object.keys(mockSecretStore)) delete mockSecretStore[key]; },
    preloadProjectSecrets: async () => ({}),
    setSecret: async (key: string, value: string) => { mockSecretStore[key] = value; },
    getSecret: async (key: string) => (key in mockSecretStore ? mockSecretStore[key] : null),
    deleteSecret: async (key: string) => {
      if (!(key in mockSecretStore)) return false;
      delete mockSecretStore[key];
      return true;
    },
    migrateSecrets: async () => {},
  }));

  mock.module('../../core/bundle-refresh', () => ({
    detectBundleChanges: () => ({ hasBundle: false, hasChanged: false }),
  }));

  mock.module('../logger', () => ({
    logger: {
      log: () => {}, dim: () => {}, bold: () => {}, info: () => {},
      success: () => {}, warning: () => {}, error: () => {}, debug: () => {},
    },
  }));
}

async function loadModule(): Promise<{
  runWorkspaceScripts: RunWorkspaceScriptsFn;
  rerunWorkspaceBundleScripts: RerunWorkspaceBundleScriptsFn;
}> {
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mod = await import(`../run-workspace-scripts.ts?cacheBust=${cacheBust}`);
  return { runWorkspaceScripts: mod.runWorkspaceScripts, rerunWorkspaceBundleScripts: mod.rerunWorkspaceBundleScripts };
}

describe('runWorkspaceScripts lifecycle', () => {
  let testDir: string;
  let workspacePath: string;
  let preDir: string;
  let setupDir: string;
  let selectDir: string;
  let outputFile: string;
  let runWorkspaceScripts: RunWorkspaceScriptsFn;
  let rerunWorkspaceBundleScripts: RerunWorkspaceBundleScriptsFn;

  const write = (dir: string, name: string, body: string, exec = true): string => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/bash\n${body}\n`);
    if (exec) chmodSync(p, 0o755);
    return p;
  };
  const appendScript = (dir: string, name: string, token: string, exitCode = 0, exec = true): string =>
    write(dir, name, `echo "${token}" >> "${outputFile}"\nexit ${exitCode}`, exec);
  const lines = (): string[] => (existsSync(outputFile) ? readFileSync(outputFile, 'utf-8').trim().split('\n').filter(Boolean) : []);
  const run = (extra?: Partial<Parameters<RunWorkspaceScriptsFn>[0]>): Promise<Outcome> =>
    runWorkspaceScripts({ projectName: 'test-project', workspacePath, workspaceName: 'ws', repository: 'owner/repo', ...extra });

  beforeEach(async () => {
    mockProjectConfig = {
      repository: 'owner/repo',
      baseBranch: 'main',
      bundleValues: {},
      bundleSecretKeys: [],
      bundleConfirmHistory: {},
    };
    setupModuleMocks();
    ({ runWorkspaceScripts, rerunWorkspaceBundleScripts } = await loadModule());

    testDir = join(tmpdir(), `wss-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workspacePath = join(testDir, 'workspace');
    preDir = join(workspacePath, '.gitspace', 'scripts', 'pre');
    setupDir = join(workspacePath, '.gitspace', 'scripts', 'setup');
    selectDir = join(workspacePath, '.gitspace', 'scripts', 'select');
    outputFile = join(testDir, 'output.txt');
    mkdirSync(preDir, { recursive: true });
    mkdirSync(setupDir, { recursive: true });
    mkdirSync(selectDir, { recursive: true });
  });

  afterEach(() => {
    mock.restore();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it('scriptPolicy skip is a no-op', async () => {
    appendScript(setupDir, '01.sh', 'setup');
    const r = await run({ scriptPolicy: 'skip' });
    expect(r.kind).toBe('skipped-current');
    expect(lines()).toEqual([]);
  });

  it('first run executes setup then select and reports phasesRun', async () => {
    appendScript(setupDir, '01.sh', 'setup');
    appendScript(selectDir, '01.sh', 'select');
    const r = await run();
    expect(r.kind).toBe('ran');
    if (r.kind === 'ran') expect(r.phasesRun).toEqual(['setup', 'select']);
    expect(lines()).toEqual(['setup', 'select']);
  });

  it('second unchanged run skips both phases (idempotent)', async () => {
    appendScript(setupDir, '01.sh', 'setup');
    appendScript(selectDir, '01.sh', 'select');
    expect((await run()).kind).toBe('ran');
    const r2 = await run();
    expect(r2.kind).toBe('skipped-current');
    expect(lines()).toEqual(['setup', 'select']); // not re-appended
  });

  it('auto setup failure is not retried on an unchanged run (blocked-previous-failure)', async () => {
    appendScript(setupDir, '01.sh', 'setup', 1); // fails
    const r1 = await run();
    expect(r1.kind).toBe('failed');
    if (r1.kind === 'failed') expect(r1.phase).toBe('setup');
    const r2 = await run();
    expect(r2.kind).toBe('blocked-previous-failure');
    if (r2.kind === 'blocked-previous-failure') expect(r2.blockedPhase).toBe('setup');
    expect(lines()).toEqual(['setup']); // failing script ran once, not retried
  });

  it('changed setup script re-runs after a failure', async () => {
    appendScript(setupDir, '01.sh', 'setup', 1);
    expect((await run()).kind).toBe('failed');
    appendScript(setupDir, '01.sh', 'setup-fixed', 0); // content changed -> fingerprint changes
    const r2 = await run();
    expect(r2.kind).toBe('ran');
    expect(lines()).toContain('setup-fixed');
  });

  it('auto select failure is not retried; setup is not re-run', async () => {
    appendScript(setupDir, '01.sh', 'setup');
    appendScript(selectDir, '01.sh', 'select', 1); // select fails
    const r1 = await run();
    expect(r1.kind).toBe('failed');
    if (r1.kind === 'failed') expect(r1.phase).toBe('select');
    const r2 = await run();
    expect(r2.kind).toBe('blocked-previous-failure');
    if (r2.kind === 'blocked-previous-failure') expect(r2.blockedPhase).toBe('select');
    // setup ran once, select ran once — neither retried
    expect(lines()).toEqual(['setup', 'select']);
  });

  it('changed setup invalidates a previously-successful select (setup dependency)', async () => {
    appendScript(setupDir, '01.sh', 'setup');
    appendScript(selectDir, '01.sh', 'select');
    expect((await run()).kind).toBe('ran');
    // Change setup content; select should re-run because its fingerprint depends on setup's.
    appendScript(setupDir, '01.sh', 'setup2');
    const r2 = await run();
    expect(r2.kind).toBe('ran');
    if (r2.kind === 'ran') expect(r2.phasesRun).toEqual(['setup', 'select']);
    expect(lines()).toEqual(['setup', 'select', 'setup2', 'select']);
  });

  it('noSetup runs only select', async () => {
    appendScript(setupDir, '01.sh', 'setup');
    appendScript(selectDir, '01.sh', 'select');
    const r = await run({ noSetup: true });
    expect(r.kind).toBe('ran');
    if (r.kind === 'ran') expect(r.phasesRun).toEqual(['select']);
    expect(lines()).toEqual(['select']);
  });

  it('non-executable script in a phase fails with a naming error and does not silently skip', async () => {
    appendScript(setupDir, '00-first.sh', 'first', 0, /* exec */ false); // .sh but not +x
    appendScript(setupDir, '01-second.sh', 'second');
    const r = await run();
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') {
      expect(r.phase).toBe('setup');
      expect(r.error).toContain('00-first.sh');
      expect(r.error.toLowerCase()).toContain('chmod +x');
    }
    // The later executable script must NOT have run — the phase erred first.
    expect(lines()).toEqual([]);
  });

  it('chmod +x on a previously non-executable script re-runs the phase', async () => {
    const p = appendScript(setupDir, '00.sh', 'first', 0, false);
    expect((await run()).kind).toBe('failed');
    chmodSync(p, 0o755); // now executable -> manifest fingerprint changes
    const r2 = await run();
    expect(r2.kind).toBe('ran');
    expect(lines()).toContain('first');
  });

  it('explicit rerun runs setup even when current/successful', async () => {
    appendScript(setupDir, '01.sh', 'setup');
    appendScript(selectDir, '01.sh', 'select');
    expect((await run()).kind).toBe('ran');
    const rr = await rerunWorkspaceBundleScripts({
      projectName: 'test-project', workspacePath, workspaceName: 'ws', repository: 'owner/repo', selection: 'setup',
    });
    expect(rr.success).toBe(true);
    expect(lines()).toEqual(['setup', 'select', 'setup']); // setup ran again
  });

  it('explicit select rerun runs select even when current', async () => {
    appendScript(setupDir, '01.sh', 'setup');
    appendScript(selectDir, '01.sh', 'select');
    expect((await run()).kind).toBe('ran');
    const rr = await rerunWorkspaceBundleScripts({
      projectName: 'test-project', workspacePath, workspaceName: 'ws', repository: 'owner/repo', selection: 'select',
    });
    expect(rr.success).toBe(true);
    // After an explicit select rerun, the auto path should skip (fingerprint updated).
    expect((await run()).kind).toBe('skipped-current');
    expect(lines()).toEqual(['setup', 'select', 'select']);
  });
});
