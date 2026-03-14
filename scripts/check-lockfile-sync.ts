import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

type PackageJson = {
  version: string;
  optionalDependencies?: Record<string, string>;
};

type BunLock = {
  workspaces?: Record<string, { optionalDependencies?: Record<string, string> }>;
  packages?: Record<string, [string, ...unknown[]]>;
};

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function readBunLockFile(path: string): BunLock {
  const raw = readFileSync(path, 'utf-8');
  const normalized = raw.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(normalized) as BunLock;
}

function fail(message: string): never {
  console.error(`x ${message}`);
  process.exit(1);
}

const pkg = readJsonFile<PackageJson>(join(ROOT, 'package.json'));
const lock = readBunLockFile(join(ROOT, 'bun.lock'));

const optionalDeps = pkg.optionalDependencies ?? {};
const gitspaceOptionalDeps = Object.entries(optionalDeps).filter(([name]) =>
  name.startsWith('@gitspace/')
);

if (gitspaceOptionalDeps.length === 0) {
  fail('No @gitspace optionalDependencies found in package.json.');
}

const workspaceOptionalDeps = lock.workspaces?.['']?.optionalDependencies ?? {};

for (const [name, version] of gitspaceOptionalDeps) {
  if (version !== pkg.version) {
    fail(`${name} in package.json should match package version ${pkg.version}, found ${version}.`);
  }

  const workspaceVersion = workspaceOptionalDeps[name];
  if (workspaceVersion !== version) {
    fail(`${name} in bun.lock workspace optionalDependencies should be ${version}, found ${workspaceVersion ?? 'missing'}.`);
  }

  const packageEntry = lock.packages?.[name];
  const packageDescriptor = packageEntry?.[0];
  const expectedDescriptor = `${name}@${version}`;
  if (packageDescriptor !== expectedDescriptor) {
    fail(`${name} in bun.lock packages should be ${expectedDescriptor}, found ${packageDescriptor ?? 'missing'}.`);
  }
}

console.log(`✓ bun.lock @gitspace optionalDependencies match package.json version ${pkg.version}`);
