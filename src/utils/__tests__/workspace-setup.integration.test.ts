/**
 * Integration tests for workspace setup lifecycle + bundle merge behavior.
 *
 * Safety note:
 * - Does not invoke tmux-lite CLI/server APIs.
 * - Uses only temp directories and isolated env vars.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { OnboardingStep, SpacesBundle } from '../../types/bundle';

let testDir: string;
let baseDir: string;
let workspacesDir: string;
let mockProjectConfig: any;
let secretStore: Record<string, string>;
let onboardingQueue: Array<any>;
let capturedOnboardingBatches: OnboardingStep[][];
let oldTmuxSocket: string | undefined;
let oldTmuxSessionDir: string | undefined;
let oldTmuxPidFile: string | undefined;

function setupModuleMocks(): void {
  mock.module('../../core/config', () => ({
    readProjectConfig: () => mockProjectConfig,
    updateProjectConfig: (_projectName: string, updates: Record<string, unknown>) => {
      mockProjectConfig = { ...mockProjectConfig, ...updates };
    },
    getProjectBaseDir: () => baseDir,
    getProjectWorkspacesDir: () => workspacesDir,
    getProjectDir: () => testDir,
    readGlobalConfig: () => ({ currentProject: 'test-project' }),
    updateGlobalConfig: () => {},
  }));

  mock.module('../../core/git', () => ({
    getWorktreeInfo: async (workspacePath: string) => ({
      name: workspacePath.split('/').pop() || 'workspace',
      path: workspacePath,
      branch: `branch-${workspacePath.split('/').pop() || 'workspace'}`,
      ahead: 0,
      behind: 0,
      uncommittedChanges: 0,
      lastCommit: '',
    }),
    removeWorktree: async (_baseDir: string, workspacePath: string) => {
      if (existsSync(workspacePath)) {
        rmSync(workspacePath, { recursive: true, force: true });
      }
    },
    deleteLocalBranch: async () => {},
  }));

  mock.module('../../lib/tmux-lite/cli', () => ({
    isServerRunning: async () => false,
    listSessions: async () => [],
    killSession: async () => {},
  }));

  mock.module('../secrets', () => ({
    setProjectSecret: async (_projectName: string, key: string, value: string) => {
      secretStore[key] = value;
    },
    getProjectSecret: async (_projectName: string, key: string) => {
      return key in secretStore ? secretStore[key] : null;
    },
    getProjectSecrets: async (_projectName: string, keys: string[]) => {
      const out: Record<string, string> = {};
      for (const key of keys) {
        if (key in secretStore) {
          out[key] = secretStore[key];
        }
      }
      return out;
    },
    preloadProjectSecrets: async (_projectName: string, keys: string[]) => {
      const out: Record<string, string> = {};
      for (const key of keys) {
        if (key in secretStore) {
          out[key] = secretStore[key];
        }
      }
      return out;
    },
  }));

  mock.module('../onboarding', () => ({
    KEEP_EXISTING_SECRET: '__KEEP_EXISTING_SECRET__',
    runOnboarding: async (steps: OnboardingStep[]) => {
      capturedOnboardingBatches.push(steps);
      return onboardingQueue.shift() || {
        completed: true,
        inputValues: {},
        secretValues: {},
        confirmResults: {},
      };
    },
  }));

  mock.module('../logger', () => ({
    logger: {
      log: () => {},
      dim: () => {},
      bold: () => {},
      info: () => {},
      success: () => {},
      warning: () => {},
      error: () => {},
      debug: () => {},
    },
  }));
}

async function loadBundleRefreshModule() {
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return import(`../../core/bundle-refresh.ts?cacheBust=${cacheBust}`);
}

async function loadRunWorkspaceScriptsModule() {
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return import(`../run-workspace-scripts.ts?cacheBust=${cacheBust}`);
}

async function loadWorkspaceCoreModule() {
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return import(`../../core/workspace.ts?cacheBust=${cacheBust}`);
}

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
}

function writeBundle(workspacePath: string, bundle: SpacesBundle): void {
  const bundleDir = join(workspacePath, '.gitspace');
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify(bundle, null, 2));
}

function setupWorkspaceScripts(workspacePath: string, outputFile: string): void {
  const preDir = join(workspacePath, '.gitspace', 'scripts', 'pre');
  const setupDir = join(workspacePath, '.gitspace', 'scripts', 'setup');
  const selectDir = join(workspacePath, '.gitspace', 'scripts', 'select');
  mkdirSync(preDir, { recursive: true });
  mkdirSync(setupDir, { recursive: true });
  mkdirSync(selectDir, { recursive: true });

  writeExecutable(
    join(preDir, '01-pre.sh'),
    `#!/bin/bash\necho "pre:${'$'}REGION:${'$'}PULUMI_ACCESS_TOKEN:${'$'}FEATURE_FLAG:${'$'}NPM_TOKEN" >> "${outputFile}"\n`
  );
  writeExecutable(
    join(setupDir, '01-setup.sh'),
    `#!/bin/bash\necho "setup:${'$'}REGION:${'$'}PULUMI_ACCESS_TOKEN:${'$'}FEATURE_FLAG:${'$'}NPM_TOKEN" >> "${outputFile}"\n`
  );
  writeExecutable(
    join(selectDir, '01-select.sh'),
    `#!/bin/bash\necho "select:${'$'}REGION:${'$'}PULUMI_ACCESS_TOKEN:${'$'}FEATURE_FLAG:${'$'}NPM_TOKEN" >> "${outputFile}"\n`
  );
}

function setupRemoveScript(workspacePath: string, outputFile: string): void {
  const removeDir = join(workspacePath, '.gitspace', 'scripts', 'remove');
  mkdirSync(removeDir, { recursive: true });
  writeExecutable(
    join(removeDir, '01-remove.sh'),
    `#!/bin/bash\necho "remove:${'$'}REGION:${'$'}PULUMI_ACCESS_TOKEN:${'$'}FEATURE_FLAG:${'$'}NPM_TOKEN" >> "${outputFile}"\n`
  );
}

describe('workspace setup integration', () => {
  beforeEach(() => {
    testDir = join(tmpdir(), `workspace-setup-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    baseDir = join(testDir, 'base');
    workspacesDir = join(testDir, 'workspaces');
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(workspacesDir, { recursive: true });

    mockProjectConfig = {
      repository: 'owner/repo',
      baseBranch: 'main',
      bundleValues: undefined,
      bundleSecretKeys: undefined,
      bundleWorkspaceState: undefined,
      bundleConfirmHistory: undefined,
    };

    secretStore = {};
    onboardingQueue = [];
    capturedOnboardingBatches = [];

    // Guard rails: isolate tmux-lite env in case a future code path accidentally
    // reaches tmux-lite helpers.
    oldTmuxSocket = process.env.TMUX_LITE_SOCKET;
    oldTmuxSessionDir = process.env.TMUX_LITE_SESSION_DIR;
    oldTmuxPidFile = process.env.TMUX_LITE_PID_FILE;
    process.env.TMUX_LITE_SOCKET = join(testDir, 'tmux-lite-test.sock');
    process.env.TMUX_LITE_SESSION_DIR = join(testDir, 'tmux-lite-sessions');
    process.env.TMUX_LITE_PID_FILE = join(testDir, 'tmux-lite-test.pid');

    setupModuleMocks();
  });

  afterEach(() => {
    process.env.TMUX_LITE_SOCKET = oldTmuxSocket;
    process.env.TMUX_LITE_SESSION_DIR = oldTmuxSessionDir;
    process.env.TMUX_LITE_PID_FILE = oldTmuxPidFile;

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    mock.restore();
  });

  it('runs pre+setup on first open, then select on later opens with bundle env', async () => {
    const { refreshBundle } = await loadBundleRefreshModule();
    const { runWorkspaceScripts } = await loadRunWorkspaceScriptsModule();

    const workspaceName = 'ws-profile';
    const workspacePath = join(workspacesDir, workspaceName);
    mkdirSync(workspacePath, { recursive: true });
    const outputFile = join(testDir, 'phase-order.log');

    writeBundle(workspacePath, {
      version: '1.0',
      name: 'Workspace Bundle',
      onboarding: [
        {
          id: 'check-bun',
          type: 'confirm',
          title: 'Bun CLI',
          description: 'Bun is required',
          checkCommand: 'bun',
        },
        {
          id: 'region',
          type: 'input',
          title: 'Region',
          description: 'Deployment region',
          configKey: 'REGION',
        },
        {
          id: 'pulumi-token',
          type: 'secret',
          title: 'Pulumi Token',
          description: 'Pulumi token',
          configKey: 'PULUMI_ACCESS_TOKEN',
        },
      ],
    });

    setupWorkspaceScripts(workspacePath, outputFile);

    onboardingQueue.push({
      completed: true,
      inputValues: { REGION: 'us-east-1' },
      secretValues: { PULUMI_ACCESS_TOKEN: 'token-1' },
      confirmResults: {
        'check-bun': { status: 'passed', checkCommand: 'bun' },
      },
    });

    const refresh = await refreshBundle('test-project', workspacePath);
    expect(refresh.completed).toBe(true);
    expect(mockProjectConfig.bundleValues).toEqual({ REGION: 'us-east-1' });
    expect(mockProjectConfig.bundleSecretKeys).toEqual(['PULUMI_ACCESS_TOKEN']);
    expect(secretStore.PULUMI_ACCESS_TOKEN).toBe('token-1');
    expect(mockProjectConfig.bundleWorkspaceState[workspaceName].requiredInputKeys).toEqual(['REGION']);
    expect(mockProjectConfig.bundleWorkspaceState[workspaceName].requiredSecretKeys).toEqual([
      'PULUMI_ACCESS_TOKEN',
    ]);

    const firstOpen = await runWorkspaceScripts({
      projectName: 'test-project',
      workspacePath,
      workspaceName,
      repository: 'owner/repo',
      interactive: false,
    });
    expect(firstOpen.success).toBe(true);

    const secondOpen = await runWorkspaceScripts({
      projectName: 'test-project',
      workspacePath,
      workspaceName,
      repository: 'owner/repo',
      interactive: false,
    });
    expect(secondOpen.success).toBe(true);

    const lines = (await Bun.file(outputFile).text()).trim().split('\n');
    expect(lines[0]).toBe('pre:us-east-1:token-1::');
    expect(lines[1]).toBe('setup:us-east-1:token-1::');
    expect(lines[2]).toBe('select:us-east-1:token-1::');
  });

  it('merges workspace-specific keys into shared project storage', async () => {
    const { refreshBundle } = await loadBundleRefreshModule();
    const { runWorkspaceScripts } = await loadRunWorkspaceScriptsModule();

    const wsA = join(workspacesDir, 'ws-a');
    const wsB = join(workspacesDir, 'ws-b');
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });

    writeBundle(wsA, {
      version: '1.0',
      name: 'Bundle A',
      onboarding: [
        {
          id: 'region',
          type: 'input',
          title: 'Region',
          description: 'Region',
          configKey: 'REGION',
        },
        {
          id: 'pulumi-token',
          type: 'secret',
          title: 'Pulumi Token',
          description: 'Pulumi token',
          configKey: 'PULUMI_ACCESS_TOKEN',
        },
      ],
    });

    writeBundle(wsB, {
      version: '1.0',
      name: 'Bundle B',
      onboarding: [
        {
          id: 'feature-flag',
          type: 'input',
          title: 'Feature Flag',
          description: 'Flag value',
          configKey: 'FEATURE_FLAG',
        },
        {
          id: 'npm-token',
          type: 'secret',
          title: 'NPM Token',
          description: 'NPM token',
          configKey: 'NPM_TOKEN',
        },
      ],
    });

    onboardingQueue.push({
      completed: true,
      inputValues: { REGION: 'us-west-2' },
      secretValues: { PULUMI_ACCESS_TOKEN: 'pulumi-a' },
      confirmResults: {},
    });
    onboardingQueue.push({
      completed: true,
      inputValues: { FEATURE_FLAG: 'enabled' },
      secretValues: { NPM_TOKEN: 'npm-b' },
      confirmResults: {},
    });

    const refreshA = await refreshBundle('test-project', wsA);
    expect(refreshA.completed).toBe(true);

    const refreshB = await refreshBundle('test-project', wsB);
    expect(refreshB.completed).toBe(true);

    expect(mockProjectConfig.bundleValues).toEqual({
      REGION: 'us-west-2',
      FEATURE_FLAG: 'enabled',
    });
    expect(mockProjectConfig.bundleSecretKeys).toEqual([
      'NPM_TOKEN',
      'PULUMI_ACCESS_TOKEN',
    ]);

    const outputFile = join(testDir, 'merged-env.log');
    setupWorkspaceScripts(wsB, outputFile);

    const run = await runWorkspaceScripts({
      projectName: 'test-project',
      workspacePath: wsB,
      workspaceName: 'ws-b',
      repository: 'owner/repo',
      interactive: false,
    });
    expect(run.success).toBe(true);

    const firstLine = (await Bun.file(outputFile).text()).trim().split('\n')[0];
    expect(firstLine).toBe('pre:us-west-2:pulumi-a:enabled:npm-b');
  });

  it('re-checks confirm/check steps only when fingerprint changes', async () => {
    const { refreshBundle } = await loadBundleRefreshModule();

    const workspaceName = 'ws-confirm';
    const workspacePath = join(workspacesDir, workspaceName);
    mkdirSync(workspacePath, { recursive: true });

    const bundleV1: SpacesBundle = {
      version: '1.0',
      name: 'Confirm Bundle',
      onboarding: [
        {
          id: 'check-pulumi',
          type: 'confirm',
          title: 'Pulumi CLI',
          description: 'Pulumi required',
          checkCommand: 'pulumi',
        },
      ],
    };
    writeBundle(workspacePath, bundleV1);

    onboardingQueue.push({
      completed: true,
      inputValues: {},
      secretValues: {},
      confirmResults: {
        'check-pulumi': { status: 'passed', checkCommand: 'pulumi' },
      },
    });

    const first = await refreshBundle('test-project', workspacePath);
    expect(first.completed).toBe(true);
    expect(capturedOnboardingBatches[0]).toHaveLength(1);
    expect(capturedOnboardingBatches[0][0].id).toBe('check-pulumi');

    onboardingQueue.push({
      completed: true,
      inputValues: {},
      secretValues: {},
      confirmResults: {},
    });

    const second = await refreshBundle('test-project', workspacePath, { force: true });
    expect(second.completed).toBe(true);
    expect(capturedOnboardingBatches[1]).toEqual([]);

    const bundleV2: SpacesBundle = {
      ...bundleV1,
      onboarding: [
        {
          ...bundleV1.onboarding![0],
          description: 'Pulumi required and must be in PATH',
        },
      ],
    };
    writeBundle(workspacePath, bundleV2);

    onboardingQueue.push({
      completed: true,
      inputValues: {},
      secretValues: {},
      confirmResults: {
        'check-pulumi': { status: 'passed', checkCommand: 'pulumi' },
      },
    });

    const third = await refreshBundle('test-project', workspacePath);
    expect(third.completed).toBe(true);
    expect(capturedOnboardingBatches[2]).toHaveLength(1);
    expect(capturedOnboardingBatches[2][0].id).toBe('check-pulumi');
  });

  it('passes bundle env to remove scripts and prunes workspace bundle state', async () => {
    const { refreshBundle } = await loadBundleRefreshModule();
    const { deleteWorkspaceCore } = await loadWorkspaceCoreModule();

    const wsTargetName = 'ws-remove-target';
    const wsOtherName = 'ws-remove-other';
    const wsTargetPath = join(workspacesDir, wsTargetName);
    const wsOtherPath = join(workspacesDir, wsOtherName);
    mkdirSync(wsTargetPath, { recursive: true });
    mkdirSync(wsOtherPath, { recursive: true });

    const targetBundle: SpacesBundle = {
      version: '1.0',
      name: 'Target Bundle',
      onboarding: [
        {
          id: 'region',
          type: 'input',
          title: 'Region',
          description: 'Region',
          configKey: 'REGION',
        },
        {
          id: 'pulumi-token',
          type: 'secret',
          title: 'Pulumi Token',
          description: 'Pulumi token',
          configKey: 'PULUMI_ACCESS_TOKEN',
        },
      ],
    };

    const otherBundle: SpacesBundle = {
      version: '1.0',
      name: 'Other Bundle',
      onboarding: [
        {
          id: 'feature-flag',
          type: 'input',
          title: 'Feature Flag',
          description: 'Feature flag',
          configKey: 'FEATURE_FLAG',
        },
        {
          id: 'npm-token',
          type: 'secret',
          title: 'NPM Token',
          description: 'NPM token',
          configKey: 'NPM_TOKEN',
        },
      ],
    };

    writeBundle(wsTargetPath, targetBundle);
    writeBundle(wsOtherPath, otherBundle);

    const removeOutput = join(testDir, 'remove-env.log');
    setupRemoveScript(wsTargetPath, removeOutput);

    onboardingQueue.push({
      completed: true,
      inputValues: { REGION: 'eu-west-1' },
      secretValues: { PULUMI_ACCESS_TOKEN: 'pulumi-remove-token' },
      confirmResults: {},
    });
    onboardingQueue.push({
      completed: true,
      inputValues: { FEATURE_FLAG: 'on' },
      secretValues: { NPM_TOKEN: 'npm-remove-token' },
      confirmResults: {},
    });

    const refreshTarget = await refreshBundle('test-project', wsTargetPath);
    const refreshOther = await refreshBundle('test-project', wsOtherPath);
    expect(refreshTarget.completed).toBe(true);
    expect(refreshOther.completed).toBe(true);

    expect(mockProjectConfig.bundleWorkspaceState[wsTargetName]).toBeDefined();
    expect(mockProjectConfig.bundleWorkspaceState[wsOtherName]).toBeDefined();

    const deleted = await deleteWorkspaceCore('test-project', wsTargetName, {
      nonInteractive: true,
      keepBranch: true,
    });

    expect(deleted.success).toBe(true);
    expect(existsSync(wsTargetPath)).toBe(false);

    const removeLine = (await Bun.file(removeOutput).text()).trim();
    expect(removeLine).toBe('remove:eu-west-1:pulumi-remove-token:on:npm-remove-token');

    expect(mockProjectConfig.bundleWorkspaceState[wsTargetName]).toBeUndefined();
    expect(mockProjectConfig.bundleWorkspaceState[wsOtherName]).toBeDefined();
  });
});
