import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getProcessesConfigPath,
  loadProcessesConfig,
  loadProcessesConfigWithDiagnostics,
} from '../config.js';

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gssh-process-config-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.gitspace'), { recursive: true });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('loadProcessesConfigWithDiagnostics', () => {
  it('parses JSONC comments and trailing commas', () => {
    const workspace = makeWorkspace();
    const path = getProcessesConfigPath(workspace);
    writeFileSync(path, [
      '{',
      '  // One process',
      '  "processes": [',
      '    {',
      '      "name": "web",',
      '      "command": "bun",',
      '      "args": ["run", "dev",],',
      '    },',
      '  ],',
      '}',
      '',
    ].join('\n'));

    const result = loadProcessesConfigWithDiagnostics(workspace);
    expect(result.error).toBeNull();
    expect(result.config.processes).toHaveLength(1);
    expect(result.config.processes[0]?.name).toBe('web');
  });

  it('returns parse diagnostics for malformed JSONC', () => {
    const workspace = makeWorkspace();
    const path = getProcessesConfigPath(workspace);
    writeFileSync(path, '{\n  "processes": [\n    {\n');

    const result = loadProcessesConfigWithDiagnostics(workspace);
    expect(result.config.processes).toEqual([]);
    expect(result.error).toContain('Failed to parse .gitspace/processes.json');
  });

  it('returns validation diagnostics for invalid config', () => {
    const workspace = makeWorkspace();
    const path = getProcessesConfigPath(workspace);
    writeFileSync(path, '{"processes":[{"name":"web"}]}');

    const result = loadProcessesConfigWithDiagnostics(workspace);
    expect(result.error).toContain('Invalid .gitspace/processes.json');
    expect(result.error).toContain('missing command');
  });

  it('loadProcessesConfig stays backward-compatible', () => {
    const workspace = makeWorkspace();
    const path = getProcessesConfigPath(workspace);
    writeFileSync(path, '{"processes":[{"name":"api","command":"bun"}]}');

    const config = loadProcessesConfig(workspace);
    expect(config.processes).toHaveLength(1);
    expect(config.processes[0]?.name).toBe('api');
  });
});
