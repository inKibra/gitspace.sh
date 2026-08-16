/**
 * Managed Pi config defaults.
 *
 * These are seeds, not policy. The invariant that matters is that a start
 * never overwrites a value the user chose — the settings panel writes this
 * same file, so an enforcing seeder would silently undo every change on the
 * next daemon start.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YAML } from 'bun';
import { ensureManagedPiConfigDefaults } from '../pi-runtime.js';

const seedDir = (initial?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gs-pi-cfg-'));
  if (initial !== undefined) writeFileSync(join(dir, 'config.yml'), initial);
  return dir;
};

const readConfig = (dir: string): Record<string, unknown> =>
  YAML.parse(readFileSync(join(dir, 'config.yml'), 'utf8')) as Record<string, unknown>;

describe('ensureManagedPiConfigDefaults', () => {
  it('writes every default into a fresh install', () => {
    const dir = seedDir();
    ensureManagedPiConfigDefaults(dir);
    const cfg = readConfig(dir);
    expect(cfg.ttsr).toEqual({ repeatMode: 'after-gap' });
    expect(cfg.compaction).toEqual({ strategy: 'context-full' });
    expect(cfg.display).toEqual({ shimmer: 'disabled' });
    expect(cfg.astGrep).toEqual({ enabled: true });
    expect(cfg.generate_image).toEqual({ enabled: true });
    expect(cfg.checkpoint).toEqual({ enabled: true });
    expect(cfg.github).toEqual({ enabled: true });
    expect(cfg.todo).toEqual({ remindersMax: 1 });
    expect(cfg.task).toEqual({ isolation: { commits: 'ai' } });
    expect(cfg.memory).toEqual({ backend: 'mnemopi' });
    expect(cfg.cycleOrder).toEqual(['default', 'smol', 'slow']);
  });

  it('never overwrites a value the user already chose', () => {
    // The whole point: the settings panel writes this file too.
    const dir = seedDir(YAML.stringify({
      compaction: { strategy: 'snapcompact' },
      github: { enabled: false },
      todo: { remindersMax: 5 },
      memory: { backend: 'off' },
      task: { isolation: { commits: 'generic' } },
    }));
    ensureManagedPiConfigDefaults(dir);
    const cfg = readConfig(dir);
    expect(cfg.compaction).toEqual({ strategy: 'snapcompact' });
    expect(cfg.github).toEqual({ enabled: false });
    expect(cfg.todo).toEqual({ remindersMax: 5 });
    expect(cfg.memory).toEqual({ backend: 'off' });
    expect(cfg.task).toEqual({ isolation: { commits: 'generic' } });
  });

  it('seeds a missing sibling without disturbing the set one', () => {
    // Partial nesting is the common case: the user touched one key in a group.
    const dir = seedDir(YAML.stringify({ dev: { autoqaConsent: 'granted' } }));
    ensureManagedPiConfigDefaults(dir);
    expect(readConfig(dir).dev).toEqual({ autoqaConsent: 'granted', autoqa: true });
  });

  it('keeps false and 0 — falsy is set, not unset', () => {
    // A shape check rather than a truthiness check is what makes this hold.
    const dir = seedDir(YAML.stringify({ astGrep: { enabled: false }, todo: { remindersMax: 0 } }));
    ensureManagedPiConfigDefaults(dir);
    const cfg = readConfig(dir);
    expect(cfg.astGrep).toEqual({ enabled: false });
    expect(cfg.todo).toEqual({ remindersMax: 0 });
  });

  it('repairs a value of the wrong type', () => {
    const dir = seedDir(YAML.stringify({ cycleOrder: 'default', github: { enabled: 'yes' } }));
    ensureManagedPiConfigDefaults(dir);
    const cfg = readConfig(dir);
    expect(cfg.cycleOrder).toEqual(['default', 'smol', 'slow']);
    expect(cfg.github).toEqual({ enabled: true });
  });

  it('rewrites nothing once every default is present', () => {
    const dir = seedDir();
    ensureManagedPiConfigDefaults(dir);
    const first = readFileSync(join(dir, 'config.yml'), 'utf8');
    ensureManagedPiConfigDefaults(dir);
    expect(readFileSync(join(dir, 'config.yml'), 'utf8')).toBe(first);
  });

  it('leaves a malformed config alone rather than clobbering it', () => {
    // Losing a user's settings to a parse error would be the worst outcome.
    const dir = seedDir('just a string, not a mapping');
    ensureManagedPiConfigDefaults(dir);
    expect(readFileSync(join(dir, 'config.yml'), 'utf8')).toBe('just a string, not a mapping');
  });
});
