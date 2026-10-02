import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deploymentStatusFixture } from './App.js';
import { OmpSettingsEditor, requestedSettingsSection, SourceSettings, type OmpSettingView } from './SettingsPage.js';

describe('requestedSettingsSection', () => {
  it('opens account sections without exposing the removed provider editor', () => {
    expect(requestedSettingsSection('?section=git')).toEqual({ section: 'git' });
    expect(requestedSettingsSection('?section=omp')).toEqual({ section: 'omp' });
    expect(requestedSettingsSection('?section=omp-providers')).not.toEqual({ section: 'omp-providers' });
    expect(requestedSettingsSection('?section=source')).toEqual({ section: 'source' });
  });
});

it('keeps inference-owned runtime controls out of shared Advanced', () => {
  const item = (path: string, label: string): OmpSettingView => ({ path, label, tab: 'runtime', description: null, kind: 'boolean', valueJson: 'true', options: [], credential: false });
  const html = renderToStaticMarkup(<OmpSettingsEditor sections={['Advanced']} ompGeneration={1} saving={false} onSetOmpSetting={async () => undefined} ompSettings={[item('agents.enabled', 'Profile agent control'), item('task.agentFoo', 'Profile task control'), item('providers.custom', 'Profile provider control'), item('modelTags', 'Profile model tags'), item('terminal.enabled', 'Shared terminal control')]} />);
  expect(html).toContain('Shared terminal control');
  expect(html).not.toContain('Profile agent control');
  expect(html).not.toContain('Profile task control');
  expect(html).not.toContain('Profile provider control');
  expect(html).not.toContain('Profile model tags');
});

describe('SourceSettings', () => {
  const noop = async () => undefined;


  it('allows reset while any independently selected target remains', () => {
    const channel = { ...deploymentStatusFixture, desired: { worker: null, machine: null, omp: null, frontend: null, updatedAt: deploymentStatusFixture.desired.updatedAt } };
    const html = renderToStaticMarkup(<SourceSettings deployment={channel} onRevertDeployment={noop} saving={false} />);
    expect(html).toMatch(/<button[^>]*\sdisabled=""/u);
    const ompOnly = { ...channel, desired: { ...channel.desired, omp: deploymentStatusFixture.desired.omp } };
    const active = renderToStaticMarkup(<SourceSettings deployment={ompOnly} onRevertDeployment={noop} saving={false} />);
    expect(active).not.toMatch(/<button[^>]*\sdisabled=""/u);
  });

});
