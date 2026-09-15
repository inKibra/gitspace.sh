import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { launchTrackFixture } from './App.js';
import { LaunchSheet, launchSteps, readLaunchedMark, LAUNCHED_STORAGE_KEY } from './LaunchSheet.js';
import type { LaunchTrack } from './release.js';

const states = (track: LaunchTrack): string[] => launchSteps(track).map((step) => `${step.label}:${step.state}`);

describe('launchSteps', () => {
  it('follows the interleaved build/upload log per target', () => {
    const steps = launchSteps(launchTrackFixture);
    expect(states(launchTrackFixture)).toEqual(['Install:done', 'Build:active', 'Upload:pending', 'Stage:pending', 'Launch:pending', 'Restart this machine:pending', 'Reload:pending']);
    expect(steps[1]!.sub).toEqual([{ label: 'Worker', state: 'done' }, { label: 'Machine', state: 'active' }, { label: 'OMP', state: 'pending' }, { label: 'Frontend', state: 'pending' }]);
  });

  it('keeps Build active through a later upload until every target built', () => {
    const uploading: LaunchTrack = { ...launchTrackFixture, log: [...launchTrackFixture.log, { phase: 'upload', message: 'uploading releases/b7/machine.js', at: '2026-08-30T10:06:00.000Z' }] };
    expect(states(uploading).slice(0, 3)).toEqual(['Install:done', 'Build:active', 'Upload:active']);
    const staged: LaunchTrack = { ...uploading, log: [...uploading.log, { phase: 'build', message: 'building hermetic OMP runtime', at: '' }, { phase: 'upload', message: 'uploading releases/b7/omp.js', at: '' }, { phase: 'build', message: 'building frontend', at: '' }, { phase: 'upload', message: 'uploading 3 frontend files', at: '' }, { phase: 'stage', message: 'staging release', at: '' }] };
    expect(states(staged).slice(0, 4)).toEqual(['Install:done', 'Build:done', 'Upload:done', 'Stage:active']);
  });

  it('waits on the machine swap after launched, then the browser phases', () => {
    const launched: LaunchTrack = { ...launchTrackFixture, status: 'succeeded', log: [...launchTrackFixture.log, { phase: 'launched', message: 'worker=applied frontend=pending', at: '' }] };
    expect(states(launched)).toEqual(['Install:done', 'Build:done', 'Upload:done', 'Stage:done', 'Launch:done', 'Restart this machine:active', 'Reload:pending']);
    expect(launchSteps(launched)[5]!.detail).toBe('Waiting for the machine to swap');
    const reloading: LaunchTrack = { ...launched, log: [...launched.log, { phase: 'restart', message: 'Waiting for the new generation to answer', at: '' }, { phase: 'reload', message: 'Reloading this page', at: '' }] };
    expect(states(reloading).slice(5)).toEqual(['Restart this machine:done', 'Reload:active']);
    const noSwap: LaunchTrack = { ...launched, targets: ['worker', 'frontend'] };
    expect(states(noSwap)).toEqual(['Install:done', 'Build:done', 'Upload:done', 'Stage:done', 'Launch:done']);
  });

  it('takes the furthest phase when a status poll lands before the event it overtook', () => {
    // The 3s poll delivered `launched`; the event stream then appended the older `launch` line behind it.
    const overtaken: LaunchTrack = { ...launchTrackFixture, status: 'succeeded', log: [...launchTrackFixture.log, { phase: 'launched', message: 'worker=skipped machine=pending omp=pending frontend=applied', at: '' }, { phase: 'launch', message: 'launching into worker, machine, omp, frontend', at: '' }] };
    expect(states(overtaken).slice(4)).toEqual(['Launch:done', 'Restart this machine:active', 'Reload:pending']);
  });
});

describe('LaunchSheet', () => {
  it('renders the phases with one failed phase, the error, and retry', () => {
    const failed: LaunchTrack = { ...launchTrackFixture, status: 'failed', error: 'bun build failed: machine.ts(3,1): syntax error', log: [...launchTrackFixture.log, { phase: 'failed', message: 'bun build failed: machine.ts(3,1): syntax error', at: '2026-08-30T10:05:40.000Z' }] };
    const html = renderToStaticMarkup(<LaunchSheet launch={failed} open onOpenChange={() => undefined} onRetry={() => undefined} />);
    expect(html).toContain('Launch failed');
    expect(html).toContain('b7c8d9e0f1 · worker, machine, omp, frontend');
    expect(html.match(/<li data-state="done"/gu)).toHaveLength(1);
    expect(html.match(/<li data-state="failed"/gu)).toHaveLength(1);
    expect(html.match(/<li data-state="pending"/gu)).toHaveLength(5);
    expect(html).toMatch(/<span data-state="failed"[^>]*><span[^>]*><\/span>Machine<\/span>/u);
    expect(html).toContain('role="alert"');
    expect(html).toContain('>Retry</span>');
    expect(html).toContain('Reload');
  });

  it('renders nothing when closed and no retry while running', () => {
    expect(renderToStaticMarkup(<LaunchSheet launch={launchTrackFixture} open={false} onOpenChange={() => undefined} onRetry={() => undefined} />)).toBe('');
    const html = renderToStaticMarkup(<LaunchSheet launch={launchTrackFixture} open onOpenChange={() => undefined} onRetry={() => undefined} />);
    expect(html).toContain('Launching GitSpace');
    expect(html).not.toContain('>Retry</span>');
  });
});

describe('readLaunchedMark', () => {
  it('returns a fresh mark and drops stale or malformed ones', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, removeItem: (key: string) => { store.delete(key); } };
    const now = 1_000_000;
    store.set(LAUNCHED_STORAGE_KEY, JSON.stringify({ sha: 'abc', label: 'relay @ abc', at: now - 5_000 }));
    expect(readLaunchedMark(storage, now)).toEqual({ sha: 'abc', label: 'relay @ abc', at: now - 5_000 });
    expect(store.has(LAUNCHED_STORAGE_KEY)).toBe(true);
    store.set(LAUNCHED_STORAGE_KEY, JSON.stringify({ sha: 'abc', label: 'relay @ abc', at: now - 61_000 }));
    expect(readLaunchedMark(storage, now)).toBeNull();
    expect(store.has(LAUNCHED_STORAGE_KEY)).toBe(false);
    store.set(LAUNCHED_STORAGE_KEY, '{not json');
    expect(readLaunchedMark(storage, now)).toBeNull();
    expect(store.has(LAUNCHED_STORAGE_KEY)).toBe(false);
  });
});
