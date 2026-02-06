#!/usr/bin/env bun
/**
 * One-time migration script for secrets consolidation
 *
 * Migrates from old format (one keychain entry per secret) to new format
 * (one keychain entry per project/global containing JSON blob)
 *
 * Usage: bun scripts/migrate-secrets.ts [--delete-old]
 */

import { migrateSecrets } from '../src/utils/secrets.js';
import { getAllProjectNames, readProjectConfig } from '../src/core/config.js';

const deleteOld = process.argv.includes('--delete-old');

console.log('🔐 Secrets Migration Tool');
console.log('========================\n');

if (deleteOld) {
  console.log('⚠️  Will DELETE old keychain entries after migration\n');
} else {
  console.log('ℹ️  Dry run - old entries will be kept (use --delete-old to remove)\n');
}

// Gather project info
const projectNames = getAllProjectNames();
console.log(`Found ${projectNames.length} project(s): ${projectNames.join(', ') || '(none)'}\n`);

// Build map of project -> secret keys
const projects: Record<string, string[]> = {};
for (const projectName of projectNames) {
  try {
    const config = readProjectConfig(projectName);
    if (config.bundleSecretKeys && config.bundleSecretKeys.length > 0) {
      projects[projectName] = config.bundleSecretKeys;
      console.log(`  ${projectName}: ${config.bundleSecretKeys.join(', ')}`);
    } else {
      console.log(`  ${projectName}: (no bundle secrets)`);
    }
  } catch (err) {
    console.log(`  ${projectName}: (error reading config)`);
  }
}

// Known global secret keys
const globalKeys = [
  'GITSPACE_TOKEN',
  'linear-api-key',
  'relay:signingPrivateKey',
  // Add your tunnel tokens here if you have any
  'TUNNEL_TOKEN_bradleat',
];

console.log(`\nGlobal secrets to check: ${globalKeys.join(', ')}\n`);

// Run migration
console.log('Starting migration...\n');

const result = await migrateSecrets(projects, globalKeys, deleteOld);

console.log('Migration complete!');
console.log(`  Project secrets migrated: ${result.projectSecretsMigrated}`);
console.log(`  Global secrets migrated: ${result.globalSecretsMigrated}`);
if (deleteOld) {
  console.log(`  Old entries deleted: ${result.oldEntriesDeleted}`);
}

if (result.errors.length > 0) {
  console.log('\nErrors:');
  for (const err of result.errors) {
    console.log(`  - ${err}`);
  }
}

if (!deleteOld && (result.projectSecretsMigrated > 0 || result.globalSecretsMigrated > 0)) {
  console.log('\n✅ Migration successful! Run with --delete-old to clean up old entries.');
}
