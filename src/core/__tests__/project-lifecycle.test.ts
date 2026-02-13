import { describe, expect, it } from 'bun:test';
import { applyProjectBundleState } from '../project-lifecycle';

describe('project-lifecycle', () => {
  it('persists input values, secret keys, and confirm history', async () => {
    let config: any = {
      repository: 'owner/repo',
      bundleValues: {},
      bundleSecretKeys: [],
      bundleWorkspaceState: undefined,
      bundleConfirmHistory: undefined,
    };

    const setSecretCalls: Array<{ projectName: string; key: string; value: string }> = [];

    await applyProjectBundleState(
      {
        projectName: 'test-project',
        bundle: {
          version: '1.0',
          name: 'Test Bundle',
          onboarding: [
            {
              id: 'check-bun',
              type: 'confirm',
              title: 'Bun CLI',
              description: 'Bun required',
              checkCommand: 'bun',
            },
          ],
        },
        inputValues: { REGION: 'us-west-2' },
        secretValues: { PULUMI_ACCESS_TOKEN: 'token-123' },
        confirmResults: {
          'check-bun': {
            status: 'passed',
            checkCommand: 'bun',
          },
        },
      },
      {
        getProjectBaseDir: () => '/tmp/project/base',
        readProjectConfig: () => config,
        updateProjectConfig: (_projectName, updates) => {
          config = { ...config, ...updates };
          return config;
        },
        syncBundleWorkspaceState: () => ({
          hasBundle: true,
          scope: '__base__',
          bundleHash: 'hash123',
        }),
        hashBundle: () => 'bundle-hash',
        getConfirmStepFingerprint: () => 'fp-check-bun',
        setProjectSecret: async (projectName, key, value) => {
          setSecretCalls.push({ projectName, key, value });
        },
      }
    );

    expect(setSecretCalls).toEqual([
      {
        projectName: 'test-project',
        key: 'PULUMI_ACCESS_TOKEN',
        value: 'token-123',
      },
    ]);
    expect(config.bundleValues).toEqual({ REGION: 'us-west-2' });
    expect(config.bundleSecretKeys).toEqual(['PULUMI_ACCESS_TOKEN']);
    expect(config.bundleConfirmHistory['fp-check-bun']).toMatchObject({
      stepId: 'check-bun',
      status: 'passed',
      bundleHash: 'hash123',
      scope: '__base__',
    });
  });

  it('seeds base scope metadata when sync has no bundle', async () => {
    let config: any = {
      repository: 'owner/repo',
      bundleValues: {},
      bundleSecretKeys: [],
      bundleWorkspaceState: undefined,
      bundleConfirmHistory: undefined,
    };

    await applyProjectBundleState(
      {
        projectName: 'test-project',
        bundle: {
          version: '1.0',
          name: 'Test Bundle',
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
              description: 'Token',
              configKey: 'PULUMI_ACCESS_TOKEN',
            },
          ],
        },
      },
      {
        getProjectBaseDir: () => '/tmp/project/base',
        readProjectConfig: () => config,
        updateProjectConfig: (_projectName, updates) => {
          config = { ...config, ...updates };
          return config;
        },
        syncBundleWorkspaceState: () => ({
          hasBundle: false,
          scope: undefined,
          bundleHash: undefined,
        }),
        hashBundle: () => 'bundle-hash',
        getConfirmStepFingerprint: () => 'fp-check-bun',
        setProjectSecret: async () => {},
      }
    );

    expect(config.bundleWorkspaceState).toBeDefined();
    expect(config.bundleWorkspaceState.__base__).toBeDefined();
    expect(config.bundleWorkspaceState.__base__.requiredInputKeys).toEqual(['REGION']);
    expect(config.bundleWorkspaceState.__base__.requiredSecretKeys).toEqual([
      'PULUMI_ACCESS_TOKEN',
    ]);
    expect(config.bundleSecretKeys).toEqual(['PULUMI_ACCESS_TOKEN']);
  });
});
