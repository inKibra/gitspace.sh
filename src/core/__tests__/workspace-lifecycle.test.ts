import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

let detectResult: any
let planResult: any
let syncParseError: string | undefined
let syncCalls = 0
let runCalls = 0
let skipSecretDependentScripts = false

mock.module('../bundle-refresh', () => ({
  checkAndRefreshBundle: async () => true,
  detectBundleChanges: () => detectResult,
  getBundleRefreshPlan: async () => planResult,
  formatBundleChangeDetails: () => 'Bundle details',
  syncBundleWorkspaceState: () => {
    syncCalls += 1
    if (syncParseError) {
      return { hasBundle: false, parseError: syncParseError }
    }
    return { hasBundle: true }
  },
}))

mock.module('../config', () => ({
  readProjectConfig: () => ({
    repository: 'owner/repo',
    bundleSecretKeys: [],
  }),
}))

mock.module('../../utils/secrets', () => ({
  preloadProjectSecrets: async () => {},
}))

mock.module('../secret-runtime', () => ({
  shouldSkipSecretDependentScripts: () => skipSecretDependentScripts,
}))

mock.module('../../utils/run-workspace-scripts', () => ({
  runWorkspaceScripts: async () => {
    runCalls += 1
    // Real shape is a ScriptLifecycleOutcome ({kind, ...}), which
    // outcomeToPrepareResult maps — the old {success:true} yielded undefined.
    return { kind: 'ran', phasesRun: ['setup'] }
  },
}))

mock.module('../../utils/logger', () => ({
  logger: {
    info: () => {},
    warning: () => {},
  },
}))

import { prepareWorkspaceForSession } from '../workspace-lifecycle.js'

describe('prepareWorkspaceForSession bundle checks', () => {
  beforeEach(() => {
    syncCalls = 0
    runCalls = 0
    syncParseError = undefined
    skipSecretDependentScripts = false
    detectResult = {
      hasBundle: true,
      hasChanged: false,
      parseError: undefined,
    }
    planResult = {
      hasBundle: true,
      hasChanged: false,
      details: 'No changes',
      steps: [],
    }
  })

  afterEach(() => {
    mock.restore()
  })

  it('returns refresh-required without syncing state when bundle changed', async () => {
    detectResult = {
      hasBundle: true,
      hasChanged: true,
      parseError: undefined,
    }

    const result = await prepareWorkspaceForSession({
      projectName: 'test-project',
      workspacePath: '/tmp/test-workspace',
      workspaceName: 'test-workspace',
      repository: 'owner/repo',
      bundleMode: 'error-if-changed',
    })

    expect(result.success).toBe(false)
    expect('bundleNeedsRefresh' in result && result.bundleNeedsRefresh).toBe(true)
    expect(syncCalls).toBe(0)
    expect(runCalls).toBe(0)
  })

  it('syncs state and runs scripts when bundle is unchanged', async () => {
    const result = await prepareWorkspaceForSession({
      projectName: 'test-project',
      workspacePath: '/tmp/test-workspace',
      workspaceName: 'test-workspace',
      repository: 'owner/repo',
      bundleMode: 'error-if-changed',
    })

    expect(result.success).toBe(true)
    expect(syncCalls).toBe(1)
    expect(runCalls).toBe(1)
  })

  it('returns refresh-required when unchanged bundle is missing required onboarding', async () => {
    planResult = {
      hasBundle: true,
      hasChanged: false,
      details: 'Missing required secrets: PULUMI_ACCESS_TOKEN.',
      steps: [
        {
          id: 'pulumi-token',
          type: 'secret',
          title: 'Pulumi access token',
          description: 'Token',
          configKey: 'PULUMI_ACCESS_TOKEN',
          required: true,
        },
      ],
    }

    const result = await prepareWorkspaceForSession({
      projectName: 'test-project',
      workspacePath: '/tmp/test-workspace',
      workspaceName: 'test-workspace',
      repository: 'owner/repo',
      bundleMode: 'error-if-changed',
    })

    expect(result.success).toBe(false)
    expect('bundleNeedsRefresh' in result && result.bundleNeedsRefresh).toBe(true)
    expect(syncCalls).toBe(0)
    expect(runCalls).toBe(0)
  })

  it('syncs bundle state and skips scripts when secret loading is disabled', async () => {
    skipSecretDependentScripts = true

    const result = await prepareWorkspaceForSession({
      projectName: 'test-project',
      workspacePath: '/tmp/test-workspace',
      workspaceName: 'test-workspace',
      repository: 'owner/repo',
      bundleMode: 'error-if-changed',
    })

    expect(result.success).toBe(true)
    expect(syncCalls).toBe(1)
    expect(runCalls).toBe(0)
  })
})
