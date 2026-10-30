import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeploymentStatusView, LaunchProgressView } from '@gitspace/protocol';
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
  /** Whether the Back to default button is disabled, read from its own opening tag. */
  const backToDefaultDisabled = (html: string): boolean => {
    const start = html.lastIndexOf('<button', html.indexOf('Back to default<'));
    return html.slice(start, html.indexOf('>', start)).includes('disabled=""');
  };

  it('distinguishes the answering Worker from a different platform record', () => {
    const deployment = { ...deploymentStatusFixture, current: {
      ...deploymentStatusFixture.current,
      worker: { sha: 'answering-worker', version: 'answering-worker' },
      platformWorker: { sha: 'platform-record', version: 'platform-record' },
    } };
    const html = renderToStaticMarkup(<SourceSettings deployment={deployment} onBackToDefault={noop} onCheckCanonical={noop} saving={false} />);
    expect(html).toContain('answering-worker');
    expect(html).toContain('Platform record');
    expect(html).toContain('platform-record');
  });

  it('offers Back to default only while a target runs something other than the default release', () => {
    const defaultRelease = deploymentStatusFixture.defaultRelease;
    const following = { ...deploymentStatusFixture, desired: { worker: null, machine: null, frontend: null, updatedAt: deploymentStatusFixture.desired.updatedAt } };
    expect(backToDefaultDisabled(renderToStaticMarkup(<SourceSettings deployment={following} onBackToDefault={noop} onCheckCanonical={noop} saving={false} />))).toBe(true);
    const selectedDefault = { ...following, desired: { ...following.desired, worker: defaultRelease, frontend: defaultRelease } };
    expect(backToDefaultDisabled(renderToStaticMarkup(<SourceSettings deployment={selectedDefault} onBackToDefault={noop} onCheckCanonical={noop} saving={false} />))).toBe(true);
    const frontendTrial = { ...following, desired: { ...following.desired, frontend: 'frontend-release' } };
    expect(backToDefaultDisabled(renderToStaticMarkup(<SourceSettings deployment={frontendTrial} onBackToDefault={noop} onCheckCanonical={noop} saving={false} />))).toBe(false);
  });

  it('follows Back to default as the launch of the default release, and shows its failure until the selections change', () => {
    const defaultRelease = deploymentStatusFixture.defaultRelease ?? '';
    const launch: LaunchProgressView = { launchId: 'launch-default', source: { kind: 'release', sha: defaultRelease }, targets: ['worker', 'machine', 'frontend'], sha: defaultRelease, phase: 'launch', message: 'launching', status: 'running', error: null, startedAt: '2026-08-30T10:06:00.000Z', updatedAt: '2026-08-30T10:06:30.000Z' };
    const running = renderToStaticMarkup(<SourceSettings deployment={{ ...deploymentStatusFixture, launch }} onBackToDefault={noop} onCheckCanonical={noop} saving={false} />);
    expect(running).toContain('Going back to default');
    expect(backToDefaultDisabled(running)).toBe(true);
    const failed: DeploymentStatusView = { ...deploymentStatusFixture, launch: { ...launch, status: 'failed', error: 'Platform reported c0ffee unhealthy' } };
    const shown = renderToStaticMarkup(<SourceSettings deployment={failed} onBackToDefault={noop} onCheckCanonical={noop} saving={false} />);
    expect(shown).toContain('Back to default failed: Platform reported c0ffee unhealthy');
    expect(backToDefaultDisabled(shown)).toBe(false);
    const relaunched = renderToStaticMarkup(<SourceSettings deployment={{ ...failed, desired: { ...failed.desired, updatedAt: '2026-08-30T10:07:00.000Z' } }} onBackToDefault={noop} onCheckCanonical={noop} saving={false} />);
    expect(relaunched).not.toContain('Back to default failed');
  });

});
