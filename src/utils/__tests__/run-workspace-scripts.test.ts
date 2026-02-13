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

type RunWorkspaceScriptsFn = typeof import('../run-workspace-scripts').runWorkspaceScripts;

function setupModuleMocks(): void {
  const secretStore: Record<string, string> = {};

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
    clearSecretsCache: () => {},
    setProjectSecret: async (_projectName: string, key: string, value: string) => {
      secretStore[key] = value;
    },
    getProjectSecret: async (_projectName: string, key: string) => {
      return key in secretStore ? secretStore[key] : null;
    },
    deleteProjectSecret: async (_projectName: string, key: string) => {
      if (!(key in secretStore)) {
        return false;
      }
      delete secretStore[key];
      return true;
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
    deleteProjectSecrets: async (_projectName: string, keys: string[]) => {
      for (const key of keys) {
        delete secretStore[key];
      }
    },
    deleteAllProjectSecrets: async () => {
      for (const key of Object.keys(secretStore)) {
        delete secretStore[key];
      }
    },
    setSecret: async (key: string, value: string) => {
      secretStore[key] = value;
    },
    getSecret: async (key: string) => {
      return key in secretStore ? secretStore[key] : null;
    },
    deleteSecret: async (key: string) => {
      if (!(key in secretStore)) {
        return false;
      }
      delete secretStore[key];
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

async function loadRunWorkspaceScriptsModule(): Promise<RunWorkspaceScriptsFn> {
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mod = await import(`../run-workspace-scripts.ts?cacheBust=${cacheBust}`);
  return mod.runWorkspaceScripts;
}

describe('runWorkspaceScripts', () => {
  let testDir: string;
  let workspacePath: string;
  let preScriptsDir: string;
  let setupScriptsDir: string;
  let selectScriptsDir: string;
  let runWorkspaceScripts: RunWorkspaceScriptsFn;

  beforeEach(async () => {
    mockProjectConfig = {
      repository: 'owner/repo',
      baseBranch: 'main',
      bundleValues: { testKey: 'testValue' },
      bundleSecretKeys: [],
      bundleConfirmHistory: {},
    };

    setupModuleMocks();
    runWorkspaceScripts = await loadRunWorkspaceScriptsModule();

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
  });
});
