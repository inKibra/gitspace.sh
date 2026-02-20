import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getProcessesConfigPath,
  loadProcessesConfig,
  loadProcessesConfigWithDiagnostics,
} from '../config.js';

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gssh-process-config-'));
  mkdirSync(join(dir, '.gitspace'), { recursive: true });
  return dir;
}

function withWorkspace<T>(run: (workspace: string) => T): T {
  const workspace = makeWorkspace();
  try {
    return run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe('loadProcessesConfigWithDiagnostics', () => {
  it('parses JSONC comments and trailing commas', () => {
    withWorkspace((workspace) => {
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
  });

  it('returns parse diagnostics for malformed JSONC', () => {
    withWorkspace((workspace) => {
      const path = getProcessesConfigPath(workspace);
      writeFileSync(path, '{\n  "processes": [\n    {\n');

      const result = loadProcessesConfigWithDiagnostics(workspace);
      expect(result.config.processes).toEqual([]);
      expect(result.error).toContain('Failed to parse .gitspace/processes.json');
    });
  });

  it('returns validation diagnostics for invalid config', () => {
    withWorkspace((workspace) => {
      const path = getProcessesConfigPath(workspace);
      writeFileSync(path, '{"processes":[{"name":"web"}]}');

      const result = loadProcessesConfigWithDiagnostics(workspace);
      expect(result.error).toContain('Invalid .gitspace/processes.json');
      expect(result.error).toContain('missing command');
    });
  });

  it('loadProcessesConfig stays backward-compatible', () => {
    withWorkspace((workspace) => {
      const path = getProcessesConfigPath(workspace);
      writeFileSync(path, '{"processes":[{"name":"api","command":"bun"}]}');

      const config = loadProcessesConfig(workspace);
      expect(config.processes).toHaveLength(1);
      expect(config.processes[0]?.name).toBe('api');
    });
  });
});
