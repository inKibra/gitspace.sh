/**
 * Integration tests for run-workspace-scripts.ts
 *
 * Tests the consolidated workspace script execution with phase tracking.
 * Uses real temporary directories and scripts to verify behavior.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { hasSetupBeenRun, markSetupComplete, clearSetupMarker } from '../workspace-state';

let mockProjectConfig: {
  repository: string;
  baseBranch: string;
  bundleValues: Record<string, string>;
  bundleSecretKeys: string[];
  bundleConfirmHistory: Record<string, unknown>;
};

let mockSecretStore: Record<string, string>;
let mockClearSecretsCacheCalls: number;
let mockRequireClearBeforeSecretRead: boolean;

type RunWorkspaceScriptsFn = typeof import('../run-workspace-scripts').runWorkspaceScripts;
type RerunWorkspaceBundleScriptsFn = typeof import('../run-workspace-scripts').rerunWorkspaceBundleScripts;

function setupModuleMocks(): void {
  mockSecretStore = {};
  mockClearSecretsCacheCalls = 0;
  mockRequireClearBeforeSecretRead = false;
  mock.module('../../core/config', () => ({
    readProjectConfig: () => mockProjectConfig,
    updateProjectConfig: () => {},
    getProjectBaseDir: () => '/tmp',
    getProjectWorkspacesDir: () => '/tmp',
    getProjectDir: () => '/tmp',
    readGlobalConfig: () => ({ currentProject: null }),
    updateGlobalConfig: () => {},
  }));

  mock.module('../secrets', () => ({
    clearSecretsCache: () => {
      mockClearSecretsCacheCalls += 1;
    },
    setProjectSecret: async (_projectName: string, key: string, value: string) => {
      mockSecretStore[key] = value;
    },
    getProjectSecret: async (_projectName: string, key: string) => {
      return key in mockSecretStore ? mockSecretStore[key] : null;
    },
    deleteProjectSecret: async (_projectName: string, key: string) => {
      if (!(key in mockSecretStore)) {
        return false;
      }
      delete mockSecretStore[key];
      return true;
    },
    getProjectSecrets: async (_projectName: string, keys: string[]) => {
      const out: Record<string, string> = {};
      if (mockRequireClearBeforeSecretRead && mockClearSecretsCacheCalls === 0) {
        return {};
      }
      for (const key of keys) {
        if (key in mockSecretStore) {
          out[key] = mockSecretStore[key];
        }
      }
      return out;
    },
    preloadProjectSecrets: async (_projectName: string, keys: string[]) => {
      const out: Record<string, string> = {};
      for (const key of keys) {
        if (key in mockSecretStore) {
          out[key] = mockSecretStore[key];
        }
      }
      return out;
    },
    deleteProjectSecrets: async (_projectName: string, keys: string[]) => {
      for (const key of keys) {
        delete mockSecretStore[key];
      }
    },
    deleteAllProjectSecrets: async () => {
      for (const key of Object.keys(mockSecretStore)) {
        delete mockSecretStore[key];
      }
    },
    setSecret: async (key: string, value: string) => {
      mockSecretStore[key] = value;
    },
    getSecret: async (key: string) => {
      return key in mockSecretStore ? mockSecretStore[key] : null;
    },
    deleteSecret: async (key: string) => {
      if (!(key in mockSecretStore)) {
        return false;
      }
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

async function loadRunWorkspaceScriptsModule(): Promise<{
  runWorkspaceScripts: RunWorkspaceScriptsFn;
  rerunWorkspaceBundleScripts: RerunWorkspaceBundleScriptsFn;
}> {
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mod = await import(`../run-workspace-scripts.ts?cacheBust=${cacheBust}`);
  return {
    runWorkspaceScripts: mod.runWorkspaceScripts,
    rerunWorkspaceBundleScripts: mod.rerunWorkspaceBundleScripts,
  };
}

describe('runWorkspaceScripts', () => {
  let testDir: string;
  let workspacePath: string;
  let preScriptsDir: string;
  let setupScriptsDir: string;
  let selectScriptsDir: string;
  let runWorkspaceScripts: RunWorkspaceScriptsFn;
  let rerunWorkspaceBundleScripts: RerunWorkspaceBundleScriptsFn;

  beforeEach(async () => {
    mockProjectConfig = {
      repository: 'owner/repo',
      baseBranch: 'main',
      bundleValues: { testKey: 'testValue' },
      bundleSecretKeys: [],
      bundleConfirmHistory: {},
    };

    setupModuleMocks();
    ({ runWorkspaceScripts, rerunWorkspaceBundleScripts } = await loadRunWorkspaceScriptsModule());

    testDir = join(tmpdir(), `workspace-scripts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workspacePath = join(testDir, 'workspace');
    // Scripts are in workspace/.gitspace/scripts/<phase>/
    preScriptsDir = join(workspacePath, '.gitspace', 'scripts', 'pre');
    setupScriptsDir = join(workspacePath, '.gitspace', 'scripts', 'setup');
    selectScriptsDir = join(workspacePath, '.gitspace', 'scripts', 'select');

    mkdirSync(preScriptsDir, { recursive: true });
    mkdirSync(setupScriptsDir, { recursive: true });
    mkdirSync(selectScriptsDir, { recursive: true });
  });

  afterEach(() => {
    mock.restore();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns success without running pre/setup/select when scriptPolicy is skip', async () => {
    const outputFile = join(testDir, 'skip-output.txt');

    const preScript = join(preScriptsDir, '01-pre.sh');
    writeFileSync(preScript, `#!/bin/bash\necho "pre" >> "${outputFile}"`);
    chmodSync(preScript, 0o755);

    const setupScript = join(setupScriptsDir, '01-setup.sh');
    writeFileSync(setupScript, `#!/bin/bash\necho "setup" >> "${outputFile}"`);
    chmodSync(setupScript, 0o755);

    const selectScript = join(selectScriptsDir, '01-select.sh');
    writeFileSync(selectScript, `#!/bin/bash\necho "select" >> "${outputFile}"`);
    chmodSync(selectScript, 0o755);

    const result = await runWorkspaceScripts({
      projectName: 'test-project',
      workspacePath,
      workspaceName: 'test-workspace',
      repository: 'owner/repo',
      scriptPolicy: 'skip',
    });

    expect(result.success).toBe(true);
    expect(existsSync(outputFile)).toBe(false);
  });


  describe('first-time workspace (pre + setup + select)', () => {
    it('should run pre, setup, and select scripts successfully', async () => {
      const outputFile = join(testDir, 'output.txt');

      // Create pre script
      const preScript = join(preScriptsDir, '01-pre.sh');
      writeFileSync(preScript, `#!/bin/bash\necho "pre" >> "${outputFile}"`);
      chmodSync(preScript, 0o755);

      // Create setup script
      const setupScript = join(setupScriptsDir, '01-setup.sh');
      writeFileSync(setupScript, `#!/bin/bash\necho "setup" >> "${outputFile}"`);
      chmodSync(setupScript, 0o755);

      // Create select script
      const selectScript = join(selectScriptsDir, '01-select.sh');
      writeFileSync(selectScript, `#!/bin/bash\necho "select" >> "${outputFile}"`);
      chmodSync(selectScript, 0o755);

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
      });

      expect(result.success).toBe(true);

      // Verify all scripts ran in order
      const output = await Bun.file(outputFile).text();
      expect(output.trim().split('\n')).toEqual(['pre', 'setup', 'select']);

      // Verify setup was marked complete
      expect(hasSetupBeenRun(workspacePath)).toBe(true);
    });

    it('reports pre, setup, and select phases in order on first run', async () => {
      const phases: string[] = [];
      const chunks: string[] = [];

      const preScript = join(preScriptsDir, '01-pre.sh');
      writeFileSync(preScript, '#!/bin/bash\necho "pre-phase"');
      chmodSync(preScript, 0o755);

      const setupScript = join(setupScriptsDir, '01-setup.sh');
      writeFileSync(setupScript, '#!/bin/bash\necho "setup-phase"');
      chmodSync(setupScript, 0o755);

      const selectScript = join(selectScriptsDir, '01-select.sh');
      writeFileSync(selectScript, '#!/bin/bash\necho "select-phase"');
      chmodSync(selectScript, 0o755);

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
        onPhaseStart: (phase) => {
          phases.push(phase);
        },
        onOutput: (data) => {
          chunks.push(data.toString());
        },
      });

      expect(result.success).toBe(true);
      expect(phases).toEqual(['pre', 'setup', 'select']);
      expect(chunks.join('')).toContain('pre-phase');
      expect(chunks.join('')).toContain('setup-phase');
      expect(chunks.join('')).toContain('select-phase');
    });

    it('should return pre phase error when pre script fails', async () => {
      // Create failing pre script
      const preScript = join(preScriptsDir, '01-fail.sh');
      writeFileSync(preScript, `#!/bin/bash\necho "failing"; exit 1`);
      chmodSync(preScript, 0o755);

      // Create setup script (should never run)
      const setupScript = join(setupScriptsDir, '01-setup.sh');
      writeFileSync(setupScript, `#!/bin/bash\necho "setup"`);
      chmodSync(setupScript, 0o755);

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.phase).toBe('pre');
        expect(result.error).toContain('exit code 1');
      }

      // Verify setup was NOT marked complete
      expect(hasSetupBeenRun(workspacePath)).toBe(false);
    });

    it('should return setup phase error when setup script fails', async () => {
      const outputFile = join(testDir, 'output.txt');

      // Create passing pre script
      const preScript = join(preScriptsDir, '01-pre.sh');
      writeFileSync(preScript, `#!/bin/bash\necho "pre" >> "${outputFile}"`);
      chmodSync(preScript, 0o755);

      // Create failing setup script
      const setupScript = join(setupScriptsDir, '01-setup.sh');
      writeFileSync(setupScript, `#!/bin/bash\necho "setup" >> "${outputFile}"; exit 1`);
      chmodSync(setupScript, 0o755);

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.phase).toBe('setup');
        expect(result.error).toContain('exit code 1');
      }

      // Verify pre script ran but setup wasn't marked complete
      const output = await Bun.file(outputFile).text();
      expect(output.trim().split('\n')).toContain('pre');
      expect(hasSetupBeenRun(workspacePath)).toBe(false);
    });

    it('should return select phase error when select fails after successful setup', async () => {
      const outputFile = join(testDir, 'output.txt');

      const preScript = join(preScriptsDir, '01-pre.sh');
      writeFileSync(preScript, `#!/bin/bash\necho "pre" >> "${outputFile}"`);
      chmodSync(preScript, 0o755);

      const setupScript = join(setupScriptsDir, '01-setup.sh');
      writeFileSync(setupScript, `#!/bin/bash\necho "setup" >> "${outputFile}"`);
      chmodSync(setupScript, 0o755);

      const selectScript = join(selectScriptsDir, '01-select.sh');
      writeFileSync(selectScript, `#!/bin/bash\necho "select" >> "${outputFile}"; exit 1`);
      chmodSync(selectScript, 0o755);

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.phase).toBe('select');
      }

      // Setup still succeeded, so setup should remain complete.
      expect(hasSetupBeenRun(workspacePath)).toBe(true);
    });
  });

  describe('existing workspace (select only)', () => {
    beforeEach(() => {
      // Mark setup as already complete
      markSetupComplete(workspacePath);
    });

    afterEach(() => {
      clearSetupMarker(workspacePath);
    });

    it('should run only select scripts for existing workspace', async () => {
      const outputFile = join(testDir, 'output.txt');

      // Create pre script (should NOT run)
      const preScript = join(preScriptsDir, '01-pre.sh');
      writeFileSync(preScript, `#!/bin/bash\necho "pre" >> "${outputFile}"`);
      chmodSync(preScript, 0o755);

      // Create setup script (should NOT run)
      const setupScript = join(setupScriptsDir, '01-setup.sh');
      writeFileSync(setupScript, `#!/bin/bash\necho "setup" >> "${outputFile}"`);
      chmodSync(setupScript, 0o755);

      // Create select script (should run)
      const selectScript = join(selectScriptsDir, '01-select.sh');
      writeFileSync(selectScript, `#!/bin/bash\necho "select" >> "${outputFile}"`);
      chmodSync(selectScript, 0o755);

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
      });

      expect(result.success).toBe(true);

      // Verify only select script ran
      const output = await Bun.file(outputFile).text();
      expect(output.trim()).toBe('select');
    });

    it('reports only the select phase for an existing workspace', async () => {
      const phases: string[] = [];

      const selectScript = join(selectScriptsDir, '01-select.sh');
      writeFileSync(selectScript, '#!/bin/bash\necho "select-only"');
      chmodSync(selectScript, 0o755);

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
        onPhaseStart: (phase) => {
          phases.push(phase);
        },
      });

      expect(result.success).toBe(true);
      expect(phases).toEqual(['select']);
    });

    it('should return select phase error when select script fails', async () => {
      // Create failing select script
      const selectScript = join(selectScriptsDir, '01-fail.sh');
      writeFileSync(selectScript, `#!/bin/bash\necho "failing select"; exit 1`);
      chmodSync(selectScript, 0o755);

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.phase).toBe('select');
        expect(result.error).toContain('exit code 1');
      }
    });
  });

  describe('bundle script secrets', () => {
    it('refreshes secrets before constructing setup script environment', async () => {
      mockProjectConfig.bundleSecretKeys = ['secureDelegateApiKey'];
      mockSecretStore.secureDelegateApiKey = 'fresh-secret';
      mockRequireClearBeforeSecretRead = true;

      const outputFile = join(testDir, 'secret-output.txt');
      const setupScript = join(setupScriptsDir, '01-secret.sh');
      writeFileSync(setupScript, `#!/bin/bash\necho "$SECURE_DELEGATE_API_KEY" > "${outputFile}"`);
      chmodSync(setupScript, 0o755);

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
      });

      expect(result.success).toBe(true);
      expect(mockClearSecretsCacheCalls).toBeGreaterThan(0);
      expect((await Bun.file(outputFile).text()).trim()).toBe('fresh-secret');
    });

    it('refreshes secrets before rerun workspace scripts', async () => {
      mockProjectConfig.bundleSecretKeys = ['secureDelegateApiKey'];
      mockSecretStore.secureDelegateApiKey = 'fresh-rerun-secret';
      mockRequireClearBeforeSecretRead = true;

      const outputFile = join(testDir, 'rerun-secret-output.txt');
      const setupScript = join(setupScriptsDir, '01-secret.sh');
      writeFileSync(setupScript, `#!/bin/bash\necho "$SECURE_DELEGATE_API_KEY" > "${outputFile}"`);
      chmodSync(setupScript, 0o755);

      const result = await rerunWorkspaceBundleScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
        selection: 'setup',
      });

      expect(result.success).toBe(true);
      expect(mockClearSecretsCacheCalls).toBeGreaterThan(0);
      expect((await Bun.file(outputFile).text()).trim()).toBe('fresh-rerun-secret');
    });
  });

  describe('no scripts', () => {
    it('should succeed when no scripts exist for first-time workspace', async () => {
      // Empty script directories (created in beforeEach but with no scripts)

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
      });

      expect(result.success).toBe(true);
      expect(hasSetupBeenRun(workspacePath)).toBe(true);
    });

    it('should succeed when no select scripts exist for existing workspace', async () => {
      markSetupComplete(workspacePath);

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
      });

      expect(result.success).toBe(true);

      clearSetupMarker(workspacePath);
    });
  });

  describe('script policy skip', () => {
    it('should skip setup/select when scriptPolicy is skip', async () => {
      const outputFile = join(testDir, 'output.txt');

      const setupScript = join(setupScriptsDir, '01-setup.sh');
      writeFileSync(setupScript, `#!/bin/bash\necho "setup" >> "${outputFile}"`);
      chmodSync(setupScript, 0o755);

      const selectScript = join(selectScriptsDir, '01-select.sh');
      writeFileSync(selectScript, `#!/bin/bash\necho "select" >> "${outputFile}"`);
      chmodSync(selectScript, 0o755);

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
        scriptPolicy: 'skip',
      });

      expect(result.success).toBe(true);
      expect(existsSync(outputFile)).toBe(false);
    });

    it('does not report any phases when scriptPolicy is skip', async () => {
      const phases: string[] = [];

      const setupScript = join(setupScriptsDir, '01-setup.sh');
      writeFileSync(setupScript, '#!/bin/bash\necho "setup"');
      chmodSync(setupScript, 0o755);

      const selectScript = join(selectScriptsDir, '01-select.sh');
      writeFileSync(selectScript, '#!/bin/bash\necho "select"');
      chmodSync(selectScript, 0o755);

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
        scriptPolicy: 'skip',
        onPhaseStart: (phase) => {
          phases.push(phase);
        },
      });

      expect(result.success).toBe(true);
      expect(phases).toEqual([]);
    });
  });
});
