/**
 * Tests for bundle refresh detection and execution
 *
 * Note: These tests use isolated imports to avoid mock interference
 * with other test files.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('bundle-refresh', () => {
  let testDir: string;
  let testProjectDir: string;
  let testBaseDir: string;
  let mockProjectConfig: any;
  let mockOnboardingResult: any;

  beforeEach(() => {
    testDir = join(tmpdir(), `bundle-refresh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    testProjectDir = testDir;
    testBaseDir = join(testDir, 'base');

    mkdirSync(testBaseDir, { recursive: true });

    // Reset mock config
    mockProjectConfig = {
      repository: 'owner/repo',
      baseBranch: 'main',
      bundleValues: {},
      bundleSecretKeys: [],
      appliedBundle: undefined,
    };

    // Reset mock onboarding result
    mockOnboardingResult = {
      completed: true,
      configValues: {},
    };

    // Setup mocks before each test
    mock.module('../config', () => ({
      readProjectConfig: () => mockProjectConfig,
      updateProjectConfig: (projectName: string, updates: any) => {
        mockProjectConfig = { ...mockProjectConfig, ...updates };
      },
      getProjectBaseDir: () => testBaseDir,
      getProjectWorkspacesDir: () => join(testProjectDir, 'workspaces'),
    }));

    mock.module('../../utils/secrets', () => ({
      setProjectSecret: async () => {},
      getProjectSecret: async () => 'mock-secret-value',
      getProjectSecrets: async () => ({}),
    }));

    mock.module('../../utils/onboarding', () => ({
      runOnboarding: async () => mockOnboardingResult,
      KEEP_EXISTING_SECRET: '__KEEP_EXISTING_SECRET__',
    }));
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mock.restore();
  });

  describe('detectBundleChanges', () => {
    it('should return hasBundle: false when no bundle exists', async () => {
      const { detectBundleChanges } = await import('../bundle-refresh');
      const result = detectBundleChanges('test-project');

      expect(result.hasBundle).toBe(false);
      expect(result.hasChanged).toBe(false);
    });

    it('should detect bundle in base directory', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });

      const bundle = {
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [],
      };
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify(bundle));

      const { detectBundleChanges } = await import('../bundle-refresh');
      const result = detectBundleChanges('test-project');

      expect(result.hasBundle).toBe(true);
      expect(result.currentBundle).toEqual(bundle);
      expect(result.currentHash).toBeDefined();
      expect(result.bundlePath).toBe(bundleDir);
    });

    it('should detect bundle in workspace directory (preferred over base)', async () => {
      // Create bundle in base
      const baseBundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(baseBundleDir, { recursive: true });
      writeFileSync(join(baseBundleDir, 'bundle.json'), JSON.stringify({
        version: '1.0' as const,
        name: 'Base Bundle',
        onboarding: [],
      }));

      // Create bundle in workspace
      const workspacePath = join(testDir, 'workspaces', 'my-workspace');
      const workspaceBundleDir = join(workspacePath, '.gitspace');
      mkdirSync(workspaceBundleDir, { recursive: true });

      const workspaceBundle = {
        version: '1.0' as const,
        name: 'Workspace Bundle',
        onboarding: [],
      };
      writeFileSync(join(workspaceBundleDir, 'bundle.json'), JSON.stringify(workspaceBundle));

      const { detectBundleChanges } = await import('../bundle-refresh');
      const result = detectBundleChanges('test-project', workspacePath);

      expect(result.hasBundle).toBe(true);
      expect(result.currentBundle?.name).toBe('Workspace Bundle');
      expect(result.bundlePath).toBe(workspaceBundleDir);
    });

    it('should detect changes when no previous bundle was applied', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify({
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [],
      }));

      const { detectBundleChanges } = await import('../bundle-refresh');
      const result = detectBundleChanges('test-project');

      expect(result.hasBundle).toBe(true);
      expect(result.hasChanged).toBe(true);
    });

    it('should detect no changes when hash matches', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });

      const bundle = {
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [],
      };
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify(bundle));

      const { detectBundleChanges } = await import('../bundle-refresh');

      // First call to get the hash
      const firstResult = detectBundleChanges('test-project');

      // Update mock config with the hash
      mockProjectConfig.appliedBundle = {
        name: 'Test Bundle',
        version: '1.0' as const,
        source: bundleDir,
        appliedAt: new Date().toISOString(),
      };
      mockProjectConfig.appliedBundleHash = firstResult.currentHash;

      // Second call should show no changes
      const result = detectBundleChanges('test-project');

      expect(result.hasBundle).toBe(true);
      expect(result.hasChanged).toBe(false);
    });

    it('should detect changes when bundle content changes', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });

      // Initial bundle
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify({
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [],
      }));

      const { detectBundleChanges } = await import('../bundle-refresh');
      const firstResult = detectBundleChanges('test-project');

      // Set up as if bundle was applied
      mockProjectConfig.appliedBundle = {
        name: 'Test Bundle',
        version: '1.0' as const,
        source: bundleDir,
        appliedAt: new Date().toISOString(),
      };
      mockProjectConfig.appliedBundleHash = firstResult.currentHash;

      // Change the bundle (add onboarding step)
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify({
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [
          { id: 'new-step', type: 'info', title: 'New Step', description: 'A new step' },
        ],
      }));

      const result = detectBundleChanges('test-project');

      expect(result.hasBundle).toBe(true);
      expect(result.hasChanged).toBe(true);
    });
  });

  describe('refreshBundle', () => {
    it('should return error when no bundle exists', async () => {
      const { refreshBundle } = await import('../bundle-refresh');
      const result = await refreshBundle('test-project');

      expect(result.refreshed).toBe(false);
      expect(result.error).toBe('No bundle found');
    });

    it('should skip refresh when no changes detected', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });

      const bundle = {
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [],
      };
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify(bundle));

      const { detectBundleChanges, refreshBundle } = await import('../bundle-refresh');

      // Get hash and set up as already applied
      const changes = detectBundleChanges('test-project');
      mockProjectConfig.appliedBundle = {
        name: 'Test Bundle',
        version: '1.0' as const,
        source: bundleDir,
        appliedAt: new Date().toISOString(),
      };
      mockProjectConfig.appliedBundleHash = changes.currentHash;

      const result = await refreshBundle('test-project');

      expect(result.refreshed).toBe(false);
      expect(result.completed).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should force refresh even when no changes detected', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });

      const bundle = {
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [
          { id: 'step1', type: 'input', title: 'Name', description: 'Enter name', configKey: 'name' },
        ],
      };
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify(bundle));

      const { detectBundleChanges, refreshBundle } = await import('../bundle-refresh');

      // Set up as already applied
      const changes = detectBundleChanges('test-project');
      mockProjectConfig.appliedBundle = {
        name: 'Test Bundle',
        version: '1.0' as const,
        source: bundleDir,
        appliedAt: new Date().toISOString(),
      };
      mockProjectConfig.appliedBundleHash = changes.currentHash;

      // Mock onboarding to return a value
      mockOnboardingResult = {
        completed: true,
        configValues: { name: 'Test Name' },
      };

      const result = await refreshBundle('test-project', undefined, { force: true });

      expect(result.refreshed).toBe(true);
      expect(result.completed).toBe(true);
    });

    it('should skip in non-interactive mode when changes detected', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });

      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify({
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [
          { id: 'step1', type: 'input', title: 'Name', description: 'Enter name', configKey: 'name' },
        ],
      }));

      const { refreshBundle } = await import('../bundle-refresh');
      const result = await refreshBundle('test-project', undefined, { nonInteractive: true });

      expect(result.refreshed).toBe(false);
      expect(result.completed).toBe(false);
    });

    it('should succeed with empty onboarding steps', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });

      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify({
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [],
      }));

      const { refreshBundle } = await import('../bundle-refresh');
      const result = await refreshBundle('test-project');

      expect(result.refreshed).toBe(false);
      expect(result.completed).toBe(true);
    });

    it('should handle cancelled onboarding', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });

      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify({
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [
          { id: 'step1', type: 'input', title: 'Name', description: 'Enter name', configKey: 'name' },
        ],
      }));

      // Mock cancelled onboarding
      mockOnboardingResult = {
        completed: false,
        configValues: {},
        cancelledAt: 'step1',
      };

      const { refreshBundle } = await import('../bundle-refresh');
      const result = await refreshBundle('test-project');

      expect(result.refreshed).toBe(false);
      expect(result.completed).toBe(false);
      expect(result.error).toBe('Onboarding cancelled');
    });
  });
});
