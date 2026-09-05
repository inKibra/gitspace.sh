import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deploymentStatusFixture } from './App.js';
import { requestedSettingsSection, SourceSettings } from './SettingsPage.js';

describe('requestedSettingsSection', () => {
  it('opens the requested section, lands provider links on the OMP Providers tab, and falls back to profile', () => {
    expect(requestedSettingsSection('?section=git')).toEqual({ section: 'git', ompTab: 'Models' });
    expect(requestedSettingsSection('?section=omp')).toEqual({ section: 'omp', ompTab: 'Models' });
    expect(requestedSettingsSection('?section=omp-providers')).toEqual({ section: 'omp', ompTab: 'Providers' });
    expect(requestedSettingsSection('?section=source')).toEqual({ section: 'source', ompTab: 'Models' });
    expect(requestedSettingsSection('?section=nope')).toEqual({ section: 'profile', ompTab: 'Models' });
    expect(requestedSettingsSection('')).toEqual({ section: 'profile', ompTab: 'Models' });
  });
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
