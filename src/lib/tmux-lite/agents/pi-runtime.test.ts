import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let gitspaceDir = '';
const execSyncMock = mock((_command: string, options?: { cwd?: string }) => {
  const agentDir = options?.cwd ?? join(gitspaceDir, '.pi');
  const binDir = join(agentDir, 'node_modules', '.bin');
  const packageDir = join(agentDir, 'node_modules', '@oh-my-pi', 'pi-coding-agent');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(binDir, 'omp'), '#!/bin/sh\n');
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ version: '13.14.2' }));
});

const realChildProcess = await import('node:child_process');

mock.module('node:child_process', () => ({
  ...realChildProcess,
  execSync: execSyncMock,
}));

mock.module('../../../core/config.js', () => ({
  getGitspaceDir: () => gitspaceDir,
}));

async function loadPiRuntimeModule() {
  return import(`./pi-runtime.js?test=${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('pi-runtime managed package versioning', () => {
  beforeEach(() => {
    gitspaceDir = mkdtempSync(join(tmpdir(), 'gitspace-pi-runtime-'));
    execSyncMock.mockClear();
  });

  afterEach(() => {
    if (gitspaceDir) {
      rmSync(gitspaceDir, { recursive: true, force: true });
    }
    gitspaceDir = '';
  });

  test('ensureOmpInstalled writes the repo-pinned package spec', async () => {
    const { ensureOmpInstalled } = await loadPiRuntimeModule();

    await ensureOmpInstalled();

    expect(execSyncMock).toHaveBeenCalledTimes(1);
    const managedPackageJson = JSON.parse(
      readFileSync(join(gitspaceDir, '.pi', 'package.json'), 'utf-8'),
    ) as { dependencies?: Record<string, string> };
    expect(managedPackageJson.dependencies?.['@oh-my-pi/pi-coding-agent']).toBe('^13.14.2');
  });

  test('updateOmp rewrites the managed package spec to the repo pin', async () => {
    const agentDir = join(gitspaceDir, '.pi');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'package.json'),
      JSON.stringify({
        name: 'gitspace-pi-agent',
        private: true,
        dependencies: {
          '@oh-my-pi/pi-coding-agent': 'latest',
        },
      }),
    );

    const { updateOmp } = await loadPiRuntimeModule();

    await updateOmp();

    expect(execSyncMock).toHaveBeenCalledTimes(1);
    const managedPackageJson = JSON.parse(
      readFileSync(join(agentDir, 'package.json'), 'utf-8'),
    ) as { dependencies?: Record<string, string> };
    expect(managedPackageJson.dependencies?.['@oh-my-pi/pi-coding-agent']).toBe('^13.14.2');
  });
});
