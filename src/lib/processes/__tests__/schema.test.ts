/**
 * Process schema validation tests
 */

import { describe, expect, it } from 'bun:test';
import { validateProcessesConfig, describeProcess } from '../schema.js';
import type { ProcessesConfig, ProcessDefinition } from '../../../types/processes.js';

// ============================================================================
// validateProcessesConfig
// ============================================================================

describe('validateProcessesConfig', () => {
  it('should pass for valid config with one process', () => {
    const config: ProcessesConfig = {
      processes: [{ name: 'web', command: 'npm start' }],
    };
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should pass for valid config with multiple processes', () => {
    const config: ProcessesConfig = {
      processes: [
        { name: 'web', command: 'npm start' },
        { name: 'worker', command: 'npm run worker' },
      ],
    };
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(true);
  });

  it('should pass for empty processes array', () => {
    const config: ProcessesConfig = { processes: [] };
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(true);
  });

  it('should fail when processes is not an array', () => {
    const config = { processes: 'not-an-array' } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('processes must be an array');
  });

  it('should fail when process has no name', () => {
    const config = {
      processes: [{ command: 'npm start' }],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('process is missing name');
  });

  it('should fail for duplicate process names', () => {
    const config: ProcessesConfig = {
      processes: [
        { name: 'web', command: 'npm start' },
        { name: 'web', command: 'npm run dev' },
      ],
    };
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('duplicate process name: web');
  });

  it('should fail when process has no command', () => {
    const config = {
      processes: [{ name: 'web' }],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('process web missing command');
  });

  it('should fail when keepRawOutput is not boolean', () => {
    const config = {
      processes: [
        { name: 'web', command: 'npm start', events: { keepRawOutput: 'yes' } },
      ],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('keepRawOutput must be a boolean');
  });

  it('should pass when keepRawOutput is boolean', () => {
    const config: ProcessesConfig = {
      processes: [
        { name: 'web', command: 'npm start', events: { keepRawOutput: true } },
      ],
    };
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(true);
  });

  it('should fail when ports is not an array', () => {
    const config = {
      processes: [{ name: 'web', command: 'npm start', ports: 'not-array' }],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('ports must be an array');
  });

  it('should fail for port out of range', () => {
    const config: ProcessesConfig = {
      processes: [
        { name: 'web', command: 'npm start', ports: [{ port: 0 }] },
      ],
    };
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('port must be a number between 1 and 65535');
  });

  it('should fail for port over 65535', () => {
    const config: ProcessesConfig = {
      processes: [
        { name: 'web', command: 'npm start', ports: [{ port: 70000 }] },
      ],
    };
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
  });

  it('should pass for valid port config', () => {
    const config: ProcessesConfig = {
      processes: [
        { name: 'web', command: 'npm start', ports: [{ port: 3000, name: 'http', protocol: 'http' }] },
      ],
    };
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(true);
  });

  it('should fail for invalid port protocol', () => {
    const config = {
      processes: [
        { name: 'web', command: 'npm start', ports: [{ port: 3000, protocol: 'udp' }] },
      ],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('protocol must be http or tcp');
  });

  it('should accumulate multiple errors', () => {
    const config = {
      processes: [
        { name: 'web', command: 'npm start' },
        { name: 'web', command: 'npm run dev' },  // duplicate
        { command: 'npm test' },                    // missing name
      ],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// describeProcess
// ============================================================================

describe('describeProcess', () => {
  it('should describe process with command only', () => {
    const process: ProcessDefinition = { name: 'web', command: 'npm start' };
    expect(describeProcess(process)).toBe('web: npm start');
  });

  it('should describe process with args', () => {
    const process: ProcessDefinition = { name: 'api', command: 'node', args: ['server.js', '--port', '3000'] };
    expect(describeProcess(process)).toBe('api: node server.js --port 3000');
  });

  it('should describe process with empty args', () => {
    const process: ProcessDefinition = { name: 'worker', command: 'python', args: [] };
    expect(describeProcess(process)).toBe('worker: python');
  });
});
