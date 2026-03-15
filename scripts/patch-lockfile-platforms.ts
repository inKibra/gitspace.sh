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
import { execFileSync } from 'child_process';
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

function sleep(ms: number): void {
  execFileSync('sleep', [`${ms / 1000}`], { timeout: ms + 5_000 });
}

const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 2_000;

function fetchIntegrity(name: string, version: string): string {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = INITIAL_DELAY_MS * 2 ** (attempt - 1);
      console.log(`  ↻ Retry ${attempt}/${MAX_RETRIES - 1} for ${name}@${version} in ${delay / 1000}s…`);
      sleep(delay);
    }
    try {
      const result = execFileSync(
        'npm',
        ['view', `${name}@${version}`, 'dist.integrity'],
        { encoding: 'utf-8', timeout: 30_000 },
      ).trim();
      if (result.length > 0) return result;
      lastError = new Error('npm returned empty integrity');
    } catch (e) {
      lastError = e;
    }
  }
  console.error(`✗ Failed to fetch integrity for ${name}@${version} after ${MAX_RETRIES} attempts`);
  console.error(lastError);
  process.exit(1);
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
    console.error(`✗ No platform metadata for ${name} — add it to PLATFORM_META in this script`);
    process.exit(1);
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
  let packagesEndIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('"packages"')) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;

    // Detect the closing brace of the packages object
    if (/^\s*\}/.test(lines[i])) {
      packagesEndIndex = i;
      break;
    }

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
      }
    }
  }

  if (!replaced) {
    // Fall back to appending before the closing brace of packages
    if (insertIndex === -1) {
      if (packagesEndIndex !== -1) {
        insertIndex = packagesEndIndex;
      } else {
        console.error(`✗ Could not find insertion point in bun.lock for ${name}`);
        process.exit(1);
      }
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
