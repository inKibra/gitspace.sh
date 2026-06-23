import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const scopedUnifiedKey = 'com.gitspace:secrets';

function readUnifiedBlob(filePath: string): any {
  const store = JSON.parse(readFileSync(filePath, 'utf-8')) as { entries?: Record<string, string> };
  return JSON.parse(store.entries?.[scopedUnifiedKey] ?? '{"global":{},"projects":{},"metadata":{"schemaVersion":2}}');
}

function writeUnifiedBlob(filePath: string, blob: any): void {
  const store = existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, 'utf-8')) as { entries?: Record<string, string> }
    : { entries: {} };
  store.entries = store.entries ?? {};
  store.entries[scopedUnifiedKey] = JSON.stringify(blob);
  writeFileSync(filePath, JSON.stringify(store, null, 2));
}

describe('secrets cross-process cache refresh', () => {
  let dir: string;
  let filePath: string;
  let previousRuntime: string | undefined;
  let previousBackend: string | undefined;
  let previousFile: string | undefined;

  beforeEach(() => {
    dir = join(tmpdir(), `gitspace-secrets-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    filePath = join(dir, 'secrets.json');
    previousRuntime = process.env.GSSH_TEST_RUNTIME;
    previousBackend = process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND;
    previousFile = process.env.GSSH_TEST_SECRETS_FILE;
    process.env.GSSH_TEST_RUNTIME = '1';
    process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND = '1';
    process.env.GSSH_TEST_SECRETS_FILE = filePath;
  });

  afterEach(() => {
    if (previousRuntime === undefined) delete process.env.GSSH_TEST_RUNTIME;
    else process.env.GSSH_TEST_RUNTIME = previousRuntime;
    if (previousBackend === undefined) delete process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND;
    else process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND = previousBackend;
    if (previousFile === undefined) delete process.env.GSSH_TEST_SECRETS_FILE;
    else process.env.GSSH_TEST_SECRETS_FILE = previousFile;
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves externally written project secrets when setting another secret from a stale module cache', async () => {
    const secrets = await import(`../secrets.ts?fresh-write-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    await secrets.setProjectSecret('demo', 'FIRST', 'one');

    const externalBlob = readUnifiedBlob(filePath);
    externalBlob.projects.demo.SECOND = 'two';
    writeUnifiedBlob(filePath, externalBlob);

    await secrets.setProjectSecret('demo', 'THIRD', 'three');

    expect(await secrets.getProjectSecrets('demo', ['FIRST', 'SECOND', 'THIRD'])).toEqual({
      FIRST: 'one',
      SECOND: 'two',
      THIRD: 'three',
    });
  });

  it('preserves externally written global secrets when setting another global secret from a stale module cache', async () => {
    const secrets = await import(`../secrets.ts?fresh-global-write-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    await secrets.setSecret('FIRST_GLOBAL', 'one');

    const externalBlob = readUnifiedBlob(filePath);
    externalBlob.global.SECOND_GLOBAL = 'two';
    writeUnifiedBlob(filePath, externalBlob);

    await secrets.setSecret('THIRD_GLOBAL', 'three');

    expect(await secrets.getSecret('FIRST_GLOBAL')).toBe('one');
    expect(await secrets.getSecret('SECOND_GLOBAL')).toBe('two');
    expect(await secrets.getSecret('THIRD_GLOBAL')).toBe('three');
  });
});

describe('test secrets path validation', () => {
  let previousRuntime: string | undefined;
  let previousBackend: string | undefined;
  let previousFile: string | undefined;
  let previousCwd: string;
  const devSecretsDir = resolve('.gitspace', 'dev', `secrets-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  beforeEach(() => {
    previousRuntime = process.env.GSSH_TEST_RUNTIME;
    previousBackend = process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND;
    previousFile = process.env.GSSH_TEST_SECRETS_FILE;
    previousCwd = process.cwd();
    mkdirSync(devSecretsDir, { recursive: true });
    process.env.GSSH_TEST_RUNTIME = '1';
    process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND = '1';
    process.env.GSSH_TEST_SECRETS_FILE = join(devSecretsDir, 'secrets.json');
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousRuntime === undefined) delete process.env.GSSH_TEST_RUNTIME;
    else process.env.GSSH_TEST_RUNTIME = previousRuntime;
    if (previousBackend === undefined) delete process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND;
    else process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND = previousBackend;
    if (previousFile === undefined) delete process.env.GSSH_TEST_SECRETS_FILE;
    else process.env.GSSH_TEST_SECRETS_FILE = previousFile;
    rmSync(devSecretsDir, { recursive: true, force: true });
  });

  it('accepts inherited repo-local dev secrets when command cwd is another workspace', async () => {
    const otherWorkspace = join(tmpdir(), `gitspace-other-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(otherWorkspace, { recursive: true });
    try {
      process.chdir(otherWorkspace);
      const secrets = await import(`../secrets.ts?repo-local-dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await secrets.setProjectSecret('demo', 'TOKEN', 'value');
      expect(await secrets.getProjectSecret('demo', 'TOKEN')).toBe('value');
    } finally {
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });
});
