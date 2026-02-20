/**
 * Process session naming tests
 */

import { describe, expect, it } from 'bun:test';
import {
  buildProcessSessionName,
  encodeProcessNameForPath,
  parseProcessSessionName,
  PROCESS_SESSION_PREFIX,
  PROCESS_SESSION_MAX_NAME,
} from '../names.js';

// ============================================================================
// buildProcessSessionName
// ============================================================================

describe('buildProcessSessionName', () => {
  it('should build name with correct format', () => {
    const name = buildProcessSessionName('my-workspace', 'web', 1);
    expect(name).toBe('proc:my-workspace:web:1');
  });

  it('should use the PROCESS_SESSION_PREFIX', () => {
    const name = buildProcessSessionName('ws', 'api', 2);
    expect(name.startsWith(`${PROCESS_SESSION_PREFIX}:`)).toBe(true);
  });

  it('should truncate names exceeding max length', () => {
    const longWorkspace = 'a'.repeat(80);
    const name = buildProcessSessionName(longWorkspace, 'web', 1);
    expect(name.length).toBeLessThanOrEqual(PROCESS_SESSION_MAX_NAME);
    expect(parseProcessSessionName(name)).not.toBeNull();
  });

  it('should not truncate short names', () => {
    const name = buildProcessSessionName('ws', 'api', 1);
    expect(name).toBe('proc:ws:api:1');
    expect(name.length).toBeLessThan(PROCESS_SESSION_MAX_NAME);
  });

  it('should handle instance numbers > 1', () => {
    const name = buildProcessSessionName('ws', 'worker', 5);
    expect(name).toBe('proc:ws:worker:5');
  });
});

// ============================================================================
// parseProcessSessionName
// ============================================================================

describe('parseProcessSessionName', () => {
  it('should parse a valid process session name', () => {
    const result = parseProcessSessionName('proc:my-workspace:web:1');
    expect(result).toEqual({
      workspaceId: 'my-workspace',
      processName: 'web',
      instance: 1,
    });
  });

  it('should return null for non-process names', () => {
    expect(parseProcessSessionName('alpha:ws:1')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseProcessSessionName('')).toBeNull();
  });

  it('should return null for wrong prefix', () => {
    expect(parseProcessSessionName('session:ws:web:1')).toBeNull();
  });

  it('should return null for too few parts', () => {
    expect(parseProcessSessionName('proc:ws')).toBeNull();
    expect(parseProcessSessionName('proc:ws:web')).toBeNull();
  });

  it('should return null for non-numeric instance', () => {
    expect(parseProcessSessionName('proc:ws:web:abc')).toBeNull();
  });

  it('should handle instance 0', () => {
    const result = parseProcessSessionName('proc:ws:web:0');
    expect(result).toEqual({
      workspaceId: 'ws',
      processName: 'web',
      instance: 0,
    });
  });
});

// ============================================================================
// Round-trip
// ============================================================================

describe('buildProcessSessionName / parseProcessSessionName round-trip', () => {
  it('should round-trip standard names', () => {
    const name = buildProcessSessionName('workspace', 'dev-server', 1);
    const parsed = parseProcessSessionName(name);
    expect(parsed).toEqual({
      workspaceId: 'workspace',
      processName: 'dev-server',
      instance: 1,
    });
  });

  it('should round-trip multi-instance', () => {
    for (let i = 1; i <= 5; i++) {
      const name = buildProcessSessionName('ws', 'worker', i);
      const parsed = parseProcessSessionName(name);
      expect(parsed?.instance).toBe(i);
    }
  });
});

describe('encodeProcessNameForPath', () => {
  it('encodes path separators and dot segments safely', () => {
    expect(encodeProcessNameForPath('../api/server')).toBe('..%2Fapi%2Fserver');
  });

  it('keeps simple names readable', () => {
    expect(encodeProcessNameForPath('web-server')).toBe('web-server');
  });
});
