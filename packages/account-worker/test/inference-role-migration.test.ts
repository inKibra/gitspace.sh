import { expect, it } from 'vitest';
import { migratedRoleSettings } from '../src/inference-role-migration.js';

it('moves the custom image role to the Images service and removes the role', () => {
  expect(migratedRoleSettings({ modelRoles: { default: 'anthropic/claude-opus-5-5', image: 'openrouter/black-forest-labs/flux.2-klein-4b' } }))
    .toEqual({ modelRoles: { default: 'anthropic/claude-opus-5-5' }, images: 'openrouter/black-forest-labs/flux.2-klein-4b' });
  // A dotted role goes too; an Images service already chosen stays.
  expect(migratedRoleSettings({ 'modelRoles.default': 'anthropic/claude-opus-5-5', 'modelRoles.image': 'openrouter/black-forest-labs/flux.2-klein-4b', images: 'cloudflare/flux-2-dev' }))
    .toEqual({ 'modelRoles.default': 'anthropic/claude-opus-5-5', images: 'cloudflare/flux-2-dev' });
  // Migrated settings migrate to themselves, so the vault rewrites a profile once.
  const migrated = migratedRoleSettings({ modelRoles: { image: 'openrouter/black-forest-labs/flux.2-klein-4b' } });
  expect(migratedRoleSettings(migrated)).toEqual(migrated);
});
