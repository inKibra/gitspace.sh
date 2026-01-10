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

// We need to mock the config and secrets modules before importing the function
const mockProjectConfig = {
  repository: 'owner/repo',
  baseBranch: 'main',
  bundleValues: { testKey: 'testValue' },
  bundleSecretKeys: [],
};

mock.module('../../core/config', () => ({
  readProjectConfig: () => mockProjectConfig,
  getScriptsPhaseDir: (projectName: string, phase: string) => {
    // Return the test scripts directory based on phase
    return join(globalTestDir, 'scripts', phase);
  },
}));

mock.module('./secrets', () => ({
  getProjectSecrets: async () => ({}),
}));

// Track the test directory globally so the mock can access it
let globalTestDir: string;

// Import after mocking
import { runWorkspaceScripts } from '../run-workspace-scripts';
import { hasSetupBeenRun, markSetupComplete, clearSetupMarker } from '../workspace-state';

describe('runWorkspaceScripts', () => {
  let testDir: string;
  let workspacePath: string;
  let preScriptsDir: string;
  let setupScriptsDir: string;
  let selectScriptsDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `workspace-scripts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    globalTestDir = testDir;
    workspacePath = join(testDir, 'workspace');
    preScriptsDir = join(testDir, 'scripts', 'pre');
    setupScriptsDir = join(testDir, 'scripts', 'setup');
    selectScriptsDir = join(testDir, 'scripts', 'select');

    mkdirSync(preScriptsDir, { recursive: true });
    mkdirSync(setupScriptsDir, { recursive: true });
    mkdirSync(selectScriptsDir, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('first-time workspace (pre + setup)', () => {
    it('should run pre and setup scripts successfully', async () => {
      const outputFile = join(testDir, 'output.txt');

      // Create pre script
      const preScript = join(preScriptsDir, '01-pre.sh');
      writeFileSync(preScript, `#!/bin/bash\necho "pre" >> "${outputFile}"`);
      chmodSync(preScript, 0o755);

      // Create setup script
      const setupScript = join(setupScriptsDir, '01-setup.sh');
      writeFileSync(setupScript, `#!/bin/bash\necho "setup" >> "${outputFile}"`);
      chmodSync(setupScript, 0o755);

      const result = await runWorkspaceScripts({
        projectName: 'test-project',
        workspacePath,
        workspaceName: 'test-workspace',
        repository: 'owner/repo',
      });

      expect(result.success).toBe(true);

      // Verify both scripts ran in order
      const output = await Bun.file(outputFile).text();
      expect(output.trim().split('\n')).toEqual(['pre', 'setup']);

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
});
