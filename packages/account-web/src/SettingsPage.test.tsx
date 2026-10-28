import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deploymentStatusFixture } from './App.js';
import { parseRoleModel, RuntimeSettingsEditor, requestedSettingsSection, SourceSettings, type RuntimeSettingView } from './SettingsPage.js';

describe('requestedSettingsSection', () => {
  it('opens account sections without exposing the removed provider editor', () => {
    expect(requestedSettingsSection('?section=git')).toEqual({ section: 'git' });
    expect(requestedSettingsSection('?section=runtime')).toEqual({ section: 'runtime' });
    expect(requestedSettingsSection('?section=runtime-providers')).not.toEqual({ section: 'runtime-providers' });
    expect(requestedSettingsSection('?section=source')).toEqual({ section: 'source' });
    expect(requestedSettingsSection('?section=github&github=installed')).toEqual({ section: 'github' });
  });
});

it('recognizes Bedrock model revisions and separates only supported effort suffixes', () => {
  const model = { provider: 'amazon-bedrock', id: 'anthropic.claude-v1:0', name: 'Claude', contextWindow: 200000, images: true };
  const selector = `${model.provider}/${model.id}`;
  expect(parseRoleModel(selector, [model])).toEqual({ modelKey: selector, thinking: 'auto', known: true });
  expect(parseRoleModel(`${selector}:medium`, [model])).toEqual({ modelKey: selector, thinking: 'medium', known: true });
  expect(parseRoleModel(`${selector}:unknown`, [model])).toEqual({ modelKey: `${selector}:unknown`, thinking: 'auto', known: false });
});

it('keeps inference-owned runtime controls out of shared Advanced', () => {
  const item = (path: string, label: string): RuntimeSettingView => ({ path, label, tab: 'runtime', description: null, kind: 'boolean', valueJson: 'true', options: [], credential: false });
  const html = renderToStaticMarkup(<RuntimeSettingsEditor sections={['Advanced']} tab="Advanced" runtimeGeneration={1} saving={false} onSetRuntimeSetting={async () => undefined} runtimeSettings={[item('modelRoles', 'Profile model roles'), item('enabledModels', 'Profile enabled models'), item('providers.custom', 'Profile provider control'), item('compaction.enabled', 'Automatic compaction')]} />);
  expect(html).toContain('Automatic compaction');
  expect(html).not.toContain('Profile model roles');
  expect(html).not.toContain('Profile enabled models');
  expect(html).not.toContain('Profile provider control');
});

describe('SourceSettings', () => {
  const noop = async () => undefined;

  it('distinguishes the answering Worker from a different platform record', () => {
    const deployment = { ...deploymentStatusFixture, current: {
      ...deploymentStatusFixture.current,
      worker: { sha: 'answering-worker', version: 'answering-worker' },
      platformWorker: { sha: 'platform-record', version: 'platform-record' },
    } };
    const html = renderToStaticMarkup(<SourceSettings deployment={deployment} onRevertDeployment={noop} onCheckCanonical={noop} saving={false} />);
    expect(html).toContain('answering-worker');
    expect(html).toContain('Platform record');
    expect(html).toContain('platform-record');
  });


  it('allows reset while any independently selected target remains', () => {
    const channel = { ...deploymentStatusFixture, desired: { worker: null, machine: null, frontend: null, updatedAt: deploymentStatusFixture.desired.updatedAt } };
    const html = renderToStaticMarkup(<SourceSettings deployment={channel} onRevertDeployment={noop} onCheckCanonical={noop} saving={false} />);
    expect(html).toMatch(/<button[^>]*\sdisabled=""/u);
    const frontendOnly = { ...channel, desired: { ...channel.desired, frontend: 'frontend-release' } };
    const active = renderToStaticMarkup(<SourceSettings deployment={frontendOnly} onRevertDeployment={noop} onCheckCanonical={noop} saving={false} />);
    expect(active).not.toMatch(/<button[^>]*\sdisabled=""/u);
  });

  it('holds Back to stable while the account runs one, and shows its failure until the selections change', () => {
    const revert = { revertId: 'revert-1', error: null, startedAt: '2026-08-30T10:06:00.000Z', updatedAt: '2026-08-30T10:06:30.000Z' };
    const running = renderToStaticMarkup(<SourceSettings deployment={{ ...deploymentStatusFixture, revert: { ...revert, status: 'running' } }} onRevertDeployment={noop} onCheckCanonical={noop} saving={false} />);
    expect(running).toContain('Going back to stable');
    expect(running).toMatch(/<button[^>]*\sdisabled=""/u);
    const failed = { ...deploymentStatusFixture, revert: { ...revert, status: 'failed' as const, error: 'Platform reported channel:1 unhealthy' } };
    const shown = renderToStaticMarkup(<SourceSettings deployment={failed} onRevertDeployment={noop} onCheckCanonical={noop} saving={false} />);
    expect(shown).toContain('Back to stable failed: Platform reported channel:1 unhealthy');
    expect(shown).not.toMatch(/<button[^>]*\sdisabled=""/u);
    const relaunched = renderToStaticMarkup(<SourceSettings deployment={{ ...failed, desired: { ...failed.desired, updatedAt: '2026-08-30T10:07:00.000Z' } }} onRevertDeployment={noop} onCheckCanonical={noop} saving={false} />);
    expect(relaunched).not.toContain('Back to stable failed');
  });

});
