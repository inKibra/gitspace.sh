import { describe, expect, test } from 'bun:test';
import { redactText, redactDeep } from '../redact.js';

describe('redactText', () => {
  test('GitHub tokens', () => {
    expect(redactText('token ghp_' + 'a'.repeat(36))).not.toContain('ghp_a');
    expect(redactText('github_pat_' + 'A1b2'.repeat(10))).toBe('[REDACTED]');
    expect(redactText('gho_' + 'x'.repeat(36))).toBe('[REDACTED]');
  });

  test('bearer / basic / token auth headers keep the scheme, drop the secret', () => {
    expect(redactText('Authorization: Bearer abcDEF123456789xyz')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactText('basic dXNlcjpwYXNz')).toBe('basic [REDACTED]');
  });

  test('JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcDEF_secret-sig';
    expect(redactText(`session=${jwt}`)).toBe('session=[REDACTED]');
  });

  test('git-over-https credential and slack/aws keys', () => {
    expect(redactText('https://x-access-token:ghp_secret@github.com/o/r')).toContain('x-access-token:[REDACTED]@');
    expect(redactText('xoxb-123456789012-abcdef')).toBe('[REDACTED]');
    expect(redactText('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED]');
  });

  test('home paths are collapsed to ~ (username stripped)', () => {
    expect(redactText('at /home/bradleat/gitspace/x.ts:12')).toBe('at ~/gitspace/x.ts:12');
    expect(redactText('/Users/jane/secret/thing')).toBe('~/secret/thing');
  });

  test('sensitive flag values in free text', () => {
    expect(redactText('spawned: gssh machine enroll --enrollment-token abc123def')).toContain('--enrollment-token [REDACTED]');
    expect(redactText('--unlock-token=SECRETVALUE here')).toContain('--unlock-token=[REDACTED]');
  });

  test('leaves benign text untouched', () => {
    expect(redactText('Failed to load transcript: connection reset')).toBe('Failed to load transcript: connection reset');
    expect(redactText('')).toBe('');
  });
});

describe('redactDeep', () => {
  test('walks arrays and objects', () => {
    const bundle = {
      version: '0.2.0',
      errors: ['ok', 'token ghp_' + 'z'.repeat(36)],
      nested: { path: '/home/bob/x', note: 'fine' },
    };
    const r = redactDeep(bundle);
    expect(r.version).toBe('0.2.0');
    expect(r.errors[1]).not.toContain('ghp_z');
    expect(r.nested.path).toBe('~/x');
    expect(r.nested.note).toBe('fine');
  });
});
