/**
 * Tests for bundle refresh detection and execution.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('bundle-refresh', () => {
  let testDir: string;
  let testBaseDir: string;
  let mockProjectConfig: any;
  let mockOnboardingResult: any;
  let capturedOnboardingSteps: any[];
  let savedSecrets: Record<string, string>;
  let commandAvailability: Record<string, boolean>;

  beforeEach(() => {
    testDir = join(tmpdir(), `bundle-refresh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    testBaseDir = join(testDir, 'base');
    mkdirSync(testBaseDir, { recursive: true });

    mockProjectConfig = {
      repository: 'owner/repo',
      baseBranch: 'main',
      bundleValues: {},
      bundleSecretKeys: [],
      bundleWorkspaceState: undefined,
      bundleConfirmHistory: undefined,
    };

    mockOnboardingResult = {
      completed: true,
      inputValues: {},
      secretValues: {},
      confirmResults: {},
    };

    capturedOnboardingSteps = [];
    savedSecrets = {};
    commandAvailability = { bun: true };

    mock.module('../config', () => ({
      readProjectConfig: () => mockProjectConfig,
      updateProjectConfig: (_projectName: string, updates: any) => {
        mockProjectConfig = { ...mockProjectConfig, ...updates };
      },
      getProjectBaseDir: () => testBaseDir,
      getProjectWorkspacesDir: () => join(testDir, 'workspaces'),
      getProjectDir: () => testDir,
      readGlobalConfig: () => ({ currentProject: null }),
      updateGlobalConfig: () => {},
    }));

    mock.module('../../utils/secrets', () => ({
      setProjectSecret: async (_projectName: string, key: string, value: string) => {
        savedSecrets[key] = value;
      },
      getProjectSecret: async (_projectName: string, key: string) => {
        return savedSecrets[key] ?? null;
      },
      getProjectSecrets: async (_projectName: string, keys: string[]) => {
        const result: Record<string, string> = {};
        for (const key of keys) {
          if (savedSecrets[key] !== undefined) {
            result[key] = savedSecrets[key];
          }
        }
        return result;
      },
    }));

    mock.module('../../utils/deps', () => ({
      checkCommandExists: async (command: string) => commandAvailability[command] ?? false,
    }));

    mock.module('../../utils/onboarding', () => ({
      runOnboarding: async (steps: any[]) => {
        capturedOnboardingSteps = steps;
        return mockOnboardingResult;
      },
      KEEP_EXISTING_SECRET: '__KEEP_EXISTING_SECRET__',
    }));

    mock.module('../../utils/logger', () => ({
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
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mock.restore();
  });

  describe('detectBundleChanges', () => {
    it('returns hasBundle false when no bundle exists', async () => {
      const { detectBundleChanges } = await import('../bundle-refresh');
      const result = detectBundleChanges('test-project');

      expect(result.hasBundle).toBe(false);
      expect(result.hasChanged).toBe(false);
    });

    it('falls back to base scope hash for new workspaces', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify({
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [],
      }));

      const { detectBundleChanges, syncBundleWorkspaceState } = await import('../bundle-refresh');

      // Seed base scope from project creation flow.
      syncBundleWorkspaceState('test-project', testBaseDir);

      const workspacePath = join(testDir, 'workspaces', 'feature-a');
      mkdirSync(workspacePath, { recursive: true });

      // Workspace has same bundle (falls back to base bundle in this test setup).
      const result = detectBundleChanges('test-project', workspacePath);
      expect(result.hasBundle).toBe(true);
      expect(result.hasChanged).toBe(false);
      expect(result.previousHash).toBeDefined();
      expect(result.scope).toBe('feature-a');
      expect(result.bundleSource).toBe('base');
      expect(result.baselineSource).toBe('base');
    });

    it('treats untracked workspace scope as unchanged when hash matches existing scope state', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });
      const bundle = {
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [
          {
            id: 'pulumi-access-token',
            type: 'secret' as const,
            title: 'Pulumi Access Token',
            description: 'Pulumi token',
            configKey: 'PULUMI_ACCESS_TOKEN',
          },
        ],
      };
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify(bundle));

      const { detectBundleChanges, hashBundle } = await import('../bundle-refresh');
      const currentHash = hashBundle(bundle);

      mockProjectConfig.bundleWorkspaceState = {
        'tracked-workspace': {
          scope: 'tracked-workspace',
          bundleHash: currentHash,
          requiredInputKeys: [],
          requiredSecretKeys: ['PULUMI_ACCESS_TOKEN'],
          confirmFingerprints: [],
          updatedAt: new Date().toISOString(),
        },
      };

      const workspacePath = join(testDir, 'workspaces', 'new-workspace');
      mkdirSync(workspacePath, { recursive: true });

      const result = detectBundleChanges('test-project', workspacePath);
      expect(result.hasBundle).toBe(true);
      expect(result.hasChanged).toBe(false);
      expect(result.previousHash).toBe(currentHash);
      expect(result.baselineSource).toBe('inferred');
      expect(result.scope).toBe('new-workspace');
    });

    it('seeds base scope state when syncing from base bundle fallback', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify({
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [
          {
            id: 'region',
            type: 'input' as const,
            title: 'Region',
            description: 'Cloud region',
            configKey: 'REGION',
          },
        ],
      }));

      const workspacePath = join(testDir, 'workspaces', 'feature-b');
      mkdirSync(workspacePath, { recursive: true });

      const { syncBundleWorkspaceState } = await import('../bundle-refresh');
      const syncResult = syncBundleWorkspaceState('test-project', workspacePath);

      expect(syncResult.hasBundle).toBe(true);
      expect(syncResult.bundleSource).toBe('base');
      expect(mockProjectConfig.bundleWorkspaceState.__base__).toBeDefined();
      expect(mockProjectConfig.bundleWorkspaceState['feature-b']).toBeDefined();
      expect(mockProjectConfig.bundleWorkspaceState.__base__.bundleHash)
        .toBe(mockProjectConfig.bundleWorkspaceState['feature-b'].bundleHash);
    });

    it('includes useful summary for first-time scope differences', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify({
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [
          {
            id: 'region',
            type: 'input' as const,
            title: 'Region',
            description: 'Cloud region',
            configKey: 'REGION',
          },
        ],
      }));

      const workspacePath = join(testDir, 'workspaces', 'brand-new');
      mkdirSync(workspacePath, { recursive: true });

      const { detectBundleChanges, formatBundleChangeDetails } = await import('../bundle-refresh');
      const result = detectBundleChanges('test-project', workspacePath);
      const details = formatBundleChangeDetails(result);

      expect(result.hasChanged).toBe(true);
      expect(result.baselineSource).toBe('none');
      expect(details).toContain('Bundle source: project base bundle');
      expect(details).toContain('No previously recorded bundle state for scope "brand-new"');
    });
  });

  describe('refreshBundle', () => {
    it('stores input values in config and secrets in keychain', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify({
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [
          {
            id: 'region',
            type: 'input',
            title: 'Region',
            description: 'Cloud region',
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
      }));

      mockOnboardingResult = {
        completed: true,
        inputValues: { REGION: 'us-east-1' },
        secretValues: { PULUMI_ACCESS_TOKEN: 'pulumi-token-value' },
        confirmResults: {},
      };

      const { refreshBundle } = await import('../bundle-refresh');
      const result = await refreshBundle('test-project');

      expect(result.refreshed).toBe(true);
      expect(result.completed).toBe(true);
      expect(mockProjectConfig.bundleValues).toEqual({ REGION: 'us-east-1' });
      expect(mockProjectConfig.bundleSecretKeys).toContain('PULUMI_ACCESS_TOKEN');
      expect(savedSecrets.PULUMI_ACCESS_TOKEN).toBe('pulumi-token-value');
      expect(mockProjectConfig.bundleWorkspaceState.__base__.requiredSecretKeys).toEqual([
        'PULUMI_ACCESS_TOKEN',
      ]);
      expect(mockProjectConfig.bundleWorkspaceState.__base__.requiredInputKeys).toEqual(['REGION']);
    });

    it('re-checks confirm steps only when fingerprint changes', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });
      const bundle = {
        version: '1.0' as const,
        name: 'Test Bundle',
        onboarding: [
          {
            id: 'check-pulumi',
            type: 'confirm' as const,
            title: 'Pulumi CLI',
            description: 'Pulumi must be installed',
            checkCommand: 'pulumi',
          },
        ],
      };
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify(bundle));

      const { getConfirmStepFingerprint, hashBundle, refreshBundle } = await import('../bundle-refresh');
      const fingerprint = getConfirmStepFingerprint(bundle.onboarding[0]);

      mockProjectConfig.bundleConfirmHistory = {
        [fingerprint]: {
          fingerprint,
          stepId: 'check-pulumi',
          checkCommand: 'pulumi',
          status: 'passed',
          scope: '__base__',
          bundleHash: hashBundle(bundle),
          checkedAt: new Date().toISOString(),
        },
      };

      mockOnboardingResult = {
        completed: true,
        inputValues: {},
        secretValues: {},
        confirmResults: {},
      };

      const refreshResult = await refreshBundle('test-project');
      expect(refreshResult.completed).toBe(true);
      expect(capturedOnboardingSteps).toEqual([]);

      // Now change the confirm step so fingerprint changes.
      const changedBundle = {
        ...bundle,
        onboarding: [
          {
            ...bundle.onboarding[0],
            description: 'Pulumi CLI must be installed and in PATH',
          },
        ],
      };
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify(changedBundle));

      mockOnboardingResult = {
        completed: true,
        inputValues: {},
        secretValues: {},
        confirmResults: {
          'check-pulumi': {
            status: 'passed',
            checkCommand: 'pulumi',
          },
        },
      };

      const secondResult = await refreshBundle('test-project');
      expect(secondResult.completed).toBe(true);
      expect(capturedOnboardingSteps).toHaveLength(1);
      expect(capturedOnboardingSteps[0].id).toBe('check-pulumi');
    });
  });

  describe('bundle refresh plan/apply', () => {
    it('builds changed-only plan and auto-passes installed confirm checks', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });
      const bundle = {
        version: '1.0' as const,
        name: 'Plan Bundle',
        onboarding: [
          {
            id: 'region',
            type: 'input' as const,
            title: 'Region',
            description: 'Cloud region',
            configKey: 'REGION',
          },
          {
            id: 'token',
            type: 'secret' as const,
            title: 'API token',
            description: 'Secret token',
            configKey: 'API_TOKEN',
          },
          {
            id: 'check-bun',
            type: 'confirm' as const,
            title: 'Bun installed',
            description: 'Need bun in PATH',
            checkCommand: 'bun',
          },
        ],
      };
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify(bundle));

      const workspacePath = join(testDir, 'workspaces', 'feature-plan');
      mkdirSync(workspacePath, { recursive: true });

      mockProjectConfig.bundleWorkspaceState = {
        __base__: {
          scope: '__base__',
          bundleHash: 'oldhash',
          requiredInputKeys: [],
          requiredSecretKeys: [],
          confirmFingerprints: [],
          updatedAt: new Date().toISOString(),
        },
      };

      const { getBundleRefreshPlan } = await import('../bundle-refresh');
      const plan = await getBundleRefreshPlan('test-project', workspacePath, 'test-project:feature-plan');

      expect(plan.hasBundle).toBe(true);
      expect(plan.hasChanged).toBe(true);
      expect(plan.steps.map((step) => step.id)).toContain('region');
      expect(plan.steps.map((step) => step.id)).toContain('token');
      expect(plan.steps.map((step) => step.id)).not.toContain('check-bun');
      expect(plan.autoConfirmResults['check-bun']).toEqual({
        status: 'passed',
        checkCommand: 'bun',
      });
    });

    it('applies bundle submission and persists values, secrets, and confirm history', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });
      const bundle = {
        version: '1.0' as const,
        name: 'Apply Bundle',
        onboarding: [
          {
            id: 'region',
            type: 'input' as const,
            title: 'Region',
            description: 'Cloud region',
            configKey: 'REGION',
          },
          {
            id: 'token',
            type: 'secret' as const,
            title: 'API token',
            description: 'Secret token',
            configKey: 'API_TOKEN',
          },
          {
            id: 'check-tool',
            type: 'confirm' as const,
            title: 'Tool installed',
            description: 'Install tool',
            checkCommand: 'toolx',
          },
        ],
      };
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify(bundle));

      const workspacePath = join(testDir, 'workspaces', 'feature-apply');
      mkdirSync(workspacePath, { recursive: true });

      const { applyBundleRefreshSubmission } = await import('../bundle-refresh');
      await applyBundleRefreshSubmission('test-project', workspacePath, {
        inputValues: { REGION: 'us-east-2' },
        secretValues: { API_TOKEN: 'super-secret' },
        confirmResults: {
          'check-tool': {
            status: 'passed',
            checkCommand: 'toolx',
          },
        },
      });

      expect(mockProjectConfig.bundleValues).toEqual({ REGION: 'us-east-2' });
      expect(mockProjectConfig.bundleSecretKeys).toContain('API_TOKEN');
      expect(savedSecrets.API_TOKEN).toBe('super-secret');
      expect(mockProjectConfig.bundleWorkspaceState['feature-apply']).toBeDefined();
      expect(mockProjectConfig.bundleConfirmHistory).toBeDefined();
      expect(Object.keys(mockProjectConfig.bundleConfirmHistory || {}).length).toBe(1);
    });

    it('does not persist KEEP_EXISTING_SECRET sentinel values', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });
      const bundle = {
        version: '1.0' as const,
        name: 'Sentinel Bundle',
        onboarding: [
          {
            id: 'token',
            type: 'secret' as const,
            title: 'API token',
            description: 'Secret token',
            configKey: 'API_TOKEN',
          },
        ],
      };
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify(bundle));

      const workspacePath = join(testDir, 'workspaces', 'feature-sentinel');
      mkdirSync(workspacePath, { recursive: true });

      savedSecrets.API_TOKEN = 'existing-secret';

      const { applyBundleRefreshSubmission } = await import('../bundle-refresh');
      await applyBundleRefreshSubmission('test-project', workspacePath, {
        inputValues: {},
        secretValues: { API_TOKEN: '__KEEP_EXISTING_SECRET__' },
        confirmResults: {},
      });

      expect(savedSecrets.API_TOKEN).toBe('existing-secret');
      expect(mockProjectConfig.bundleSecretKeys).toContain('API_TOKEN');
    });

    it('includes missing required secrets even when bundle hash is unchanged', async () => {
      const bundleDir = join(testBaseDir, '.gitspace');
      mkdirSync(bundleDir, { recursive: true });
      const bundle = {
        version: '1.0' as const,
        name: 'Missing Secret Bundle',
        onboarding: [
          {
            id: 'pulumi-token',
            type: 'secret' as const,
            title: 'Pulumi Access Token',
            description: 'Required for Pulumi login',
            configKey: 'PULUMI_ACCESS_TOKEN',
            required: true,
          },
        ],
      };
      writeFileSync(join(bundleDir, 'bundle.json'), JSON.stringify(bundle));

      const workspacePath = join(testDir, 'workspaces', 'feature-missing-secret');
      mkdirSync(workspacePath, { recursive: true });

      const { detectBundleChanges, getBundleRefreshPlan } = await import('../bundle-refresh');
      const firstDetect = detectBundleChanges('test-project', workspacePath);
      expect(firstDetect.currentHash).toBeDefined();

      mockProjectConfig.bundleWorkspaceState = {
        __base__: {
          scope: '__base__',
          bundleHash: firstDetect.currentHash,
          requiredInputKeys: [],
          requiredSecretKeys: ['PULUMI_ACCESS_TOKEN'],
          confirmFingerprints: [],
          updatedAt: new Date().toISOString(),
        },
      };

      const plan = await getBundleRefreshPlan(
        'test-project',
        workspacePath,
        'test-project:feature-missing-secret'
      );

      expect(plan.hasChanged).toBe(false);
      expect(plan.steps.map((step) => step.id)).toContain('pulumi-token');
      expect(plan.details).toContain('Missing required secrets: PULUMI_ACCESS_TOKEN.');
    });
  });
});
