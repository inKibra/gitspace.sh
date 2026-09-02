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

  it('lists what runs, the desired release, and every release with per-target status', () => {
    const html = renderToStaticMarkup(<SourceSettings deployment={deploymentStatusFixture} onRevertDeployment={noop} saving={false} />);
    // Running: this machine on stable with its generation, the worker by version, the other machine on the release.
    expect(html).toContain('This machine');
    expect(html).toContain('stable · gen-0f3a');
    expect(html).toContain('Worker');
    expect(html).toContain('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
    expect(html).toContain('studio');
    expect(html).toContain('a1b2c3d4e5 · gen-77ab');
    // Desired: the release by label, targets, and a live revert.
    expect(html).toContain('agent-blame @ a1b2c3d');
    expect(html).toContain('Worker, Machine, Frontend');
    expect(html).toContain('Back to stable');
    expect(html).not.toContain('Channel build');
    // Releases: per-target badges and the machine roll-up.
    expect(html).toContain('Worker · applied');
    expect(html).toContain('Frontend · applied');
    expect(html).toContain('Machines · 1 applied');
    expect(html).toContain('Desired');
  });

  it('names the channel build when nothing is desired and disables revert', () => {
    const channel = { ...deploymentStatusFixture, desired: { sha: null, targets: [], updatedAt: deploymentStatusFixture.desired.updatedAt } };
    const html = renderToStaticMarkup(<SourceSettings deployment={channel} onRevertDeployment={noop} saving={false} />);
    expect(html).toContain('Channel build');
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>).)*Back to stable/u);
  });

  it('shows a loading state until the home machine answers', () => {
    const html = renderToStaticMarkup(<SourceSettings deployment={null} onRevertDeployment={noop} saving={false} />);
    expect(html).toContain('Loading source status…');
  });
});
