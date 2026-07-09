/** Capability core — URIs, the canonical glob matcher, mint/verify round trips. */
import { describe, expect, it } from 'bun:test';
import { generateSigningKeypair } from '../../lib/tmux-lite/crypto/identity.js';
import {
  AMBIENT_WRITE_SCOPES,
  capAllows,
  formatArtifactUri,
  localScratchRel,
  mintArtifactCap,
  parseArtifactCapUnverified,
  parseArtifactUri,
  parseLocalRef,
  pathInScope,
  sessionScratchId,
  verifyArtifactCap,
} from '../artifact-cap.js';

describe('artifact:// URIs', () => {
  it('round-trips project/workspace/relPath including @base and encoding', () => {
    expect(parseArtifactUri(formatArtifactUri('gitspace.sh', '@base', 'reports/x.report.json')))
      .toEqual({ project: 'gitspace.sh', workspace: '@base', relPath: 'reports/x.report.json' });
    expect(parseArtifactUri('artifact://p/w')).toEqual({ project: 'p', workspace: 'w', relPath: '' });
    expect(parseArtifactUri(formatArtifactUri('my proj', 'w s', 'a/b.md')).project).toBe('my proj');
  });

  it('rejects traversal and malformed URIs', () => {
    expect(() => parseArtifactUri('artifact://p/w/../escape')).toThrow('Unsafe');
    expect(() => parseArtifactUri('artifact://p/w/a//b')).toThrow('Unsafe');
    expect(() => parseArtifactUri('file:///etc/passwd')).toThrow('Not an artifact URI');
  });

  it('rejects encoded-slash traversal in project/workspace segments (bug_002)', () => {
    // %2F survives the [^/]+ capture, then decodes to '..' path segments that
    // join() would resolve into a sibling project. Must be rejected.
    expect(() => parseArtifactUri('artifact://demo/..%2F..%2Fother/reports/x.json')).toThrow('Unsafe');
    expect(() => parseArtifactUri('artifact://..%2Fp/w/a.md')).toThrow('Unsafe');
    expect(() => parseArtifactUri('artifact://p/%2E%2E/a.md')).toThrow('Unsafe');
    // @base and encoded-space names stay valid (no false positives).
    expect(parseArtifactUri('artifact://gitspace.sh/%40base/goal.md').workspace).toBe('@base');
  });
});

describe('local:// session scratch', () => {
  it('recognizes local:// and bare local: forms, returns the inner rel', () => {
    expect(parseLocalRef('local://PLAN.md')).toBe('PLAN.md');
    expect(parseLocalRef('local://notes/draft.md')).toBe('notes/draft.md');
    expect(parseLocalRef('local:PLAN.md')).toBe('PLAN.md');
    expect(parseLocalRef('reports/x.md')).toBeNull();
    expect(parseLocalRef('/abs/path')).toBeNull();
  });

  it('rejects an empty local:// path', () => {
    expect(() => parseLocalRef('local://')).toThrow('needs a path');
  });

  it('maps to a git-excluded .sessions/<sid>/local/ mount path', () => {
    expect(localScratchRel('PLAN.md', 'sess1')).toBe('.sessions/sess1/local/PLAN.md');
    expect(localScratchRel('a/b.md', 'sess1')).toBe('.sessions/sess1/local/a/b.md');
  });

  it('rejects traversal in the scratch rel', () => {
    expect(() => localScratchRel('../escape', 'sess1')).toThrow('Unsafe');
    expect(() => localScratchRel('/abs', 'sess1')).toThrow('Unsafe');
    expect(() => localScratchRel('a/./b', 'sess1')).toThrow('Unsafe');
  });

  it('session id comes from GSSH_SPACE_SESSION, sanitized, else default', () => {
    const prev = process.env.GSSH_SPACE_SESSION;
    try {
      delete process.env.GSSH_SPACE_SESSION;
      expect(sessionScratchId()).toBe('default');
      process.env.GSSH_SPACE_SESSION = 'abc/../123 x';
      expect(sessionScratchId()).toBe('abc----123-x');
    } finally {
      if (prev === undefined) delete process.env.GSSH_SPACE_SESSION;
      else process.env.GSSH_SPACE_SESSION = prev;
    }
  });

  it('a scratch URI stays inside its own read scope (no traversal escape)', () => {
    const rel = localScratchRel('PLAN.md', 'sess1');
    const uri = formatArtifactUri('p', 'w', rel);
    expect(parseArtifactUri(uri)).toEqual({ project: 'p', workspace: 'w', relPath: rel });
    expect(pathInScope(rel, [rel])).toBe(true);
    expect(pathInScope('.sessions/other/local/PLAN.md', [rel])).toBe(false);
  });
});

describe('scope glob matcher', () => {
  it('matches the documented forms', () => {
    expect(pathInScope('data/build.data.json', ['data/**'])).toBe(true);
    expect(pathInScope('data/build.data.json', ['data/'])).toBe(true);
    expect(pathInScope('reports/a.report.json', ['reports/*.report.json'])).toBe(true);
    expect(pathInScope('reports/deep/a.report.json', ['reports/*.report.json'])).toBe(false);
    expect(pathInScope('goal.md', ['goal.md'])).toBe(true);
    expect(pathInScope('notes/x.md', ['data/**', 'reports/**'])).toBe(false);
    expect(pathInScope('a/b/c.txt', ['**'])).toBe(true);
    expect(pathInScope('datax/evil.json', ['data/'])).toBe(false); // prefix is a DIR, not a string prefix
  });

  it('ambient registry entries are valid globs', () => {
    for (const scopes of Object.values(AMBIENT_WRITE_SCOPES)) {
      for (const g of scopes) expect(() => pathInScope('x', [g])).not.toThrow();
    }
  });
});

describe('mint/verify', () => {
  const keys = generateSigningKeypair();

  it('round-trips a signed cap and enforces scope + verbs', () => {
    const token = mintArtifactCap({
      sub: { kind: 'trigger', id: 'nightly-metrics' },
      verbs: ['write'],
      scope: [formatArtifactUri('demo', 'ws1', 'data/**'), formatArtifactUri('demo', 'ws1', 'reports/*.report.json')],
      machineId: 'm1',
      expiresAt: Date.now() + 60_000,
    }, keys.secretKey);

    const cap = verifyArtifactCap(token, { publicKey: keys.publicKey });
    expect(cap.sub).toEqual({ kind: 'trigger', id: 'nightly-metrics' });
    expect(capAllows(cap, 'write', parseArtifactUri('artifact://demo/ws1/data/x.json'))).toBe(true);
    expect(capAllows(cap, 'write', parseArtifactUri('artifact://demo/ws1/notes/x.md'))).toBe(false);
    expect(capAllows(cap, 'write', parseArtifactUri('artifact://demo/OTHER/data/x.json'))).toBe(false);
    expect(capAllows(cap, 'read', parseArtifactUri('artifact://demo/ws1/data/x.json'))).toBe(false); // verb not granted
  });

  it('rejects tampering, wrong keys, and expiry', () => {
    const token = mintArtifactCap({
      sub: { kind: 'link' }, verbs: ['read'],
      scope: [formatArtifactUri('demo', '@base', 'reports/r.report.json')],
      machineId: 'm1', expiresAt: Date.now() + 60_000,
    }, keys.secretKey);

    // tamper: widen the scope inside the token
    const parsed = parseArtifactCapUnverified(token)!;
    const widened = { ...parsed, scope: [formatArtifactUri('demo', '@base', '**')] };
    const forged = `gssh-cap:${Buffer.from(JSON.stringify(widened)).toString('base64url')}`;
    expect(() => verifyArtifactCap(forged, { publicKey: keys.publicKey })).toThrow('signature invalid');

    const otherKeys = generateSigningKeypair();
    expect(() => verifyArtifactCap(token, { publicKey: otherKeys.publicKey })).toThrow('signature invalid');

    const expired = mintArtifactCap({
      sub: { kind: 'link' }, verbs: ['read'], scope: [], machineId: 'm1', expiresAt: Date.now() - 1,
    }, keys.secretKey);
    expect(() => verifyArtifactCap(expired, { publicKey: keys.publicKey })).toThrow('expired');
  });
});
