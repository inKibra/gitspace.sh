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

  it('should allow instances set to 0 (disabled process)', () => {
    const config: ProcessesConfig = {
      processes: [{ name: 'worker', command: 'npm run worker', instances: 0 }],
    };
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(true);
  });

  it('should fail when instances is negative', () => {
    const config = {
      processes: [{ name: 'worker', command: 'npm run worker', instances: -1 }],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('process worker instances must be a non-negative integer');
  });

  it('should fail when instances is not an integer', () => {
    const config = {
      processes: [{ name: 'worker', command: 'npm run worker', instances: 1.5 }],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('process worker instances must be a non-negative integer');
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

  it('should fail when port name is missing', () => {
    const config: ProcessesConfig = {
      processes: [
        { name: 'web', command: 'npm start', ports: [{ name: '' }] },
      ],
    };
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('port name must be a non-empty string');
  });

  it('should fail for duplicate port names', () => {
    const config: ProcessesConfig = {
      processes: [
        {
          name: 'web',
          command: 'npm start',
          ports: [{ name: 'http' }, { name: 'http', protocol: 'tcp' }],
        },
      ],
    };
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('port names must be unique');
  });

  it('should pass for valid port config', () => {
    const config: ProcessesConfig = {
      processes: [
        { name: 'web', command: 'npm start', ports: [{ name: 'http', protocol: 'http' }] },
      ],
    };
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(true);
  });

  it('should fail for invalid port protocol', () => {
    const config = {
      processes: [
        { name: 'web', command: 'npm start', ports: [{ name: 'http', protocol: 'udp' }] },
      ],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('protocol must be http or tcp');
  });

  it('should fail when restart is a bare policy string (the silent-no-restart trap)', () => {
    const config = {
      processes: [{ name: 'web', command: 'npm start', restart: 'on-failure' }],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('restart must be an object like {"policy": "on-failure"}');
    expect(result.errors[0]).toContain('write {"policy": "on-failure"}');
  });

  it('should fail when restart is an array', () => {
    const config = {
      processes: [{ name: 'web', command: 'npm start', restart: [] }],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('got an array');
  });

  it('should fail for an unknown restart policy', () => {
    const config = {
      processes: [{ name: 'web', command: 'npm start', restart: { policy: 'sometimes' } }],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('restart.policy must be one of never | on-failure | always');
  });

  it('should fail for a negative restart backoff', () => {
    const config = {
      processes: [{ name: 'web', command: 'npm start', restart: { policy: 'always', backoffMs: -1 } }],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('restart.backoffMs must be a non-negative integer');
  });

  it('should pass for a well-formed restart object', () => {
    const config: ProcessesConfig = {
      processes: [
        {
          name: 'web',
          command: 'npm start',
          restart: { policy: 'on-failure', maxAttempts: 5, backoffMs: 2000, maxBackoffMs: 30000 },
        },
      ],
    };
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(true);
  });

  it('should fail when args is not an array of strings', () => {
    const config = {
      processes: [{ name: 'web', command: 'npm', args: ['run', 3] }],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('args must be an array of strings');
  });

  it('should fail when env holds a non-string value', () => {
    const config = {
      processes: [{ name: 'web', command: 'npm start', env: { PORT: 3000 } }],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('env values must be strings');
  });

  it('should fail when autostart is not boolean', () => {
    const config = {
      processes: [{ name: 'web', command: 'npm start', autostart: 'yes' }],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('autostart must be a boolean');
  });

  it('should fail when cwd is not a string', () => {
    const config = {
      processes: [{ name: 'web', command: 'npm start', cwd: 42 }],
    } as unknown as ProcessesConfig;
    const result = validateProcessesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('cwd must be a string');
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
