import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProcessDefinition, ProcessesConfig } from '../../../types/processes.js';

const busyPorts = new Set<number>();

mock.module('../ports.js', () => ({
  inspectListeningProcess: mock((port: number) => (busyPorts.has(port)
    ? [{ pid: 4242, command: 'node', user: 'test' }]
    : [])),
  normalizeProcessPortProtocol: mock((protocol?: 'http' | 'tcp') => protocol === 'tcp' ? 'tcp' : 'http'),
  resolveManagedSession: mock(async () => null),
}));

const {
  getProcessPortAllocationPath,
  reconcileProcessPortAllocations,
  resolveProcessRuntimePorts,
} = await import('../allocations.js');

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'gssh-port-alloc-'));
  mkdirSync(join(workspace, '.gitspace'), { recursive: true });
  return workspace;
}

function readAllocations(workspacePath: string) {
  return JSON.parse(readFileSync(getProcessPortAllocationPath(workspacePath), 'utf-8')) as {
    allocations: Record<string, { port: number; protocol: 'http' | 'tcp'; updatedAt: number }>;
  };
}

describe('process port allocations', () => {
  beforeEach(() => {
    busyPorts.clear();
  });

  it('allocates stable per-instance ports and persists them', async () => {
    const workspace = makeWorkspace();
    try {
      const definition: ProcessDefinition = {
        name: 'web',
        command: 'bun',
        ports: [{ name: 'app', protocol: 'http' }],
      };

      const first = await resolveProcessRuntimePorts(workspace, { name: 'web', instance: 1, definition });
      const second = await resolveProcessRuntimePorts(workspace, { name: 'web', instance: 1, definition });
      const otherInstance = await resolveProcessRuntimePorts(workspace, { name: 'web', instance: 2, definition });

      expect(first[0]?.name).toBe('app');
      expect(first[0]?.instance).toBe(1);
      expect(first[0]?.port).toBe(second[0]?.port);
      expect(otherInstance[0]?.port).not.toBe(first[0]?.port);
      expect(readAllocations(workspace).allocations).toHaveProperty('web:1:app');
      expect(readAllocations(workspace).allocations).toHaveProperty('web:2:app');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reallocates when a persisted port is now busy', async () => {
    const workspace = makeWorkspace();
    try {
      const definition: ProcessDefinition = {
        name: 'web',
        command: 'bun',
        ports: [{ name: 'app', protocol: 'http' }],
      };

      const first = await resolveProcessRuntimePorts(workspace, { name: 'web', instance: 1, definition });
      busyPorts.add(first[0]!.port);

      const next = await resolveProcessRuntimePorts(workspace, { name: 'web', instance: 1, definition });
      expect(next[0]?.port).not.toBe(first[0]?.port);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('prunes allocations for removed processes and instances', async () => {
    const workspace = makeWorkspace();
    try {
      const definition: ProcessDefinition = {
        name: 'web',
        command: 'bun',
        instances: 2,
        ports: [{ name: 'app', protocol: 'http' }],
      };

      await resolveProcessRuntimePorts(workspace, { name: 'web', instance: 1, definition });
      await resolveProcessRuntimePorts(workspace, { name: 'web', instance: 2, definition });

      const nextConfig: ProcessesConfig = {
        processes: [{ name: 'web', command: 'bun', instances: 1, ports: [{ name: 'app', protocol: 'http' }] }],
      };
      reconcileProcessPortAllocations(workspace, nextConfig);

      expect(readAllocations(workspace).allocations).toHaveProperty('web:1:app');
      expect(readAllocations(workspace).allocations).not.toHaveProperty('web:2:app');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
