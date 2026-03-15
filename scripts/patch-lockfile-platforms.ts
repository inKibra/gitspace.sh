/**
 * Patches bun.lock to include all @gitspace/* platform packages.
 *
 * `bun install --lockfile-only` skips optional dependencies whose os/cpu
 * don't match the current machine (e.g. linux-arm64 is dropped on an
 * x64 runner).  This script detects missing entries, fetches the
 * integrity hash from the npm registry, and inserts them back so the
 * committed lockfile works for every platform.
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Platform metadata – must match what scripts/build.ts writes to each
// platform package.json
// ---------------------------------------------------------------------------

const PLATFORM_META: Record<string, { os: string; cpu: string; binName: string }> = {
  '@gitspace/darwin-arm64': { os: 'darwin', cpu: 'arm64', binName: 'gssh-darwin-arm64' },
  '@gitspace/darwin-x64': { os: 'darwin', cpu: 'x64', binName: 'gssh-darwin-x64' },
  '@gitspace/linux-x64': { os: 'linux', cpu: 'x64', binName: 'gssh-linux-x64' },
  '@gitspace/linux-arm64': { os: 'linux', cpu: 'arm64', binName: 'gssh-linux-arm64' },
};

// ---------------------------------------------------------------------------

type PackageJson = {
  version: string;
  optionalDependencies?: Record<string, string>;
};

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function fetchIntegrity(name: string, version: string): string {
  try {
    return execSync(`npm view ${name}@${version} dist.integrity`, {
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();
  } catch {
    console.error(`✗ Failed to fetch integrity for ${name}@${version} from npm`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------

const pkg = readJsonFile<PackageJson>(join(ROOT, 'package.json'));
const lockPath = join(ROOT, 'bun.lock');
let lockContent = readFileSync(lockPath, 'utf-8');

const optionalDeps = pkg.optionalDependencies ?? {};
let patchCount = 0;

for (const [name, version] of Object.entries(optionalDeps)) {
  if (!name.startsWith('@gitspace/')) continue;

  const meta = PLATFORM_META[name];
  if (!meta) {
    console.log(`⚠ No known platform metadata for ${name}, skipping`);
    continue;
  }

  // Quick check: does the correct descriptor already exist?
  const escapedDescriptor = `${name}@${version}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`"${escapedDescriptor}"`).test(lockContent)) {
    console.log(`✓ ${name}@${version} present in bun.lock`);
    continue;
  }

  // Entry is missing or has wrong version – fetch integrity and patch
  console.log(`⚠ ${name}@${version} missing from bun.lock, patching…`);
  const integrity = fetchIntegrity(name, version);
  const newEntry = `    "${name}": ["${name}@${version}", "", { "os": "${meta.os}", "cpu": "${meta.cpu}", "bin": { "${meta.binName}": "bin/gssh" } }, "${integrity}"],`;

  const lines = lockContent.split('\n');
  let replaced = false;
  let insertIndex = -1;
  let inPackages = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('"packages"')) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;

    const lineMatch = lines[i].match(/^\s+"([^"]+)":\s*\[/);
    if (lineMatch) {
      const entryName = lineMatch[1];
      if (entryName === name) {
        // Replace existing entry (wrong version)
        lines[i] = newEntry;
        replaced = true;
        break;
      }
      if (entryName > name && insertIndex === -1) {
        insertIndex = i;
        // Don't break – the exact entry might appear later (shouldn't, but safe)
      }
    }
  }

  if (!replaced) {
    if (insertIndex === -1) {
      console.error(`✗ Could not find insertion point in bun.lock for ${name}`);
      process.exit(1);
    }
    // Insert the entry followed by a blank line (matches bun.lock formatting)
    lines.splice(insertIndex, 0, newEntry, '');
  }

  lockContent = lines.join('\n');
  patchCount++;
}

if (patchCount > 0) {
  writeFileSync(lockPath, lockContent);
  console.log(`\n✓ Patched ${patchCount} missing platform package(s) into bun.lock`);
} else {
  console.log('\n✓ All platform packages already present in bun.lock');
}
