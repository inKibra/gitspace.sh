import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deploymentStatusFixture } from './App.js';
import { RuntimeSettingsEditor, requestedSettingsSection, SourceSettings, type RuntimeSettingView } from './SettingsPage.js';

describe('requestedSettingsSection', () => {
  it('opens account sections without exposing the removed provider editor', () => {
    expect(requestedSettingsSection('?section=git')).toEqual({ section: 'git' });
    expect(requestedSettingsSection('?section=runtime')).toEqual({ section: 'runtime' });
    expect(requestedSettingsSection('?section=runtime-providers')).not.toEqual({ section: 'runtime-providers' });
    expect(requestedSettingsSection('?section=source')).toEqual({ section: 'source' });
  });
});

it('keeps inference-owned runtime controls out of shared Advanced', () => {
  const item = (path: string, label: string): RuntimeSettingView => ({ path, label, tab: 'runtime', description: null, kind: 'boolean', valueJson: 'true', options: [], credential: false });
  const html = renderToStaticMarkup(<RuntimeSettingsEditor sections={['Advanced']} runtimeGeneration={1} saving={false} onSetRuntimeSetting={async () => undefined} runtimeSettings={[item('agents.enabled', 'Profile agent control'), item('task.agentFoo', 'Profile task control'), item('providers.custom', 'Profile provider control'), item('modelTags', 'Profile model tags'), item('compaction.enabled', 'Automatic compaction')]} />);
  expect(html).toContain('Automatic compaction');
  expect(html).not.toContain('Profile agent control');
  expect(html).not.toContain('Profile task control');
  expect(html).not.toContain('Profile provider control');
  expect(html).not.toContain('Profile model tags');
});

describe('SourceSettings', () => {
  const noop = async () => undefined;


  it('allows reset while any independently selected target remains', () => {
    const channel = { ...deploymentStatusFixture, desired: { worker: null, machine: null, frontend: null, updatedAt: deploymentStatusFixture.desired.updatedAt } };
    const html = renderToStaticMarkup(<SourceSettings deployment={channel} onRevertDeployment={noop} saving={false} />);
    expect(html).toMatch(/<button[^>]*\sdisabled=""/u);
    const frontendOnly = { ...channel, desired: { ...channel.desired, frontend: 'frontend-release' } };
    const active = renderToStaticMarkup(<SourceSettings deployment={frontendOnly} onRevertDeployment={noop} saving={false} />);
    expect(active).not.toMatch(/<button[^>]*\sdisabled=""/u);
  });

});
