import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { readAllocatedProcessPorts } from './allocations.js';
import type { ProcessInstanceSpec } from '../../types/processes.js';

function writePortsJson(workspacePath: string, allocations: Record<string, { port: number; protocol: string; updatedAt: number }>) {
  const dir = join(workspacePath, '.gitspace', '.processes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ports.json'), JSON.stringify({ version: 1, allocations }, null, 2));
  return join(dir, 'ports.json');
}

const SPEC: ProcessInstanceSpec = {
  name: 'web',
  instance: 1,
  definition: {
    name: 'web',
    command: 'bun',
    ports: [
      { name: 'web', protocol: 'http' },
      { name: 'api', protocol: 'http' }, // intentionally has no allocation
    ],
  },
};

describe('readAllocatedProcessPorts', () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'gs-alloc-'));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('returns the persisted allocation and omits ports with no allocation', () => {
    writePortsJson(ws, { 'web:1:web': { port: 27011, protocol: 'http', updatedAt: 123 } });

    const ports = readAllocatedProcessPorts(ws, SPEC);

    expect(ports).toEqual([{ instance: 1, name: 'web', protocol: 'http', port: 27011 }]);
  });

  it('never writes to ports.json (a report must not move a running port)', () => {
    const file = writePortsJson(ws, { 'web:1:web': { port: 27011, protocol: 'http', updatedAt: 123 } });
    const before = readFileSync(file, 'utf-8');
    const beforeMtime = statSync(file).mtimeMs;

    readAllocatedProcessPorts(ws, SPEC);
    readAllocatedProcessPorts(ws, SPEC);

    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(statSync(file).mtimeMs).toBe(beforeMtime);
  });

  it('returns nothing when no allocation state exists (never started)', () => {
    expect(readAllocatedProcessPorts(ws, SPEC)).toEqual([]);
  });
});
