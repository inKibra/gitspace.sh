import { describe, expect, it } from 'bun:test';

import { buildCatalog, hasBlock, listBlockTypes, validateBlock } from '../index.js';

describe('block registry', () => {
  it('registers the initial vocabulary across tiers', () => {
    const types = listBlockTypes();
    expect(types).toContain('markdown');
    expect(types).toContain('diff');
    expect(types).toContain('message');
    expect(hasBlock('tool-call')).toBe(true);
    expect(hasBlock('nope')).toBe(false);
  });

  it('validates a well-formed block', () => {
    const r = validateBlock({ id: 'b1', type: 'message', data: { role: 'assistant', text: 'hi' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.block.type).toBe('message');
  });

  it('rejects invalid data with field-level issues (loud, not silent)', () => {
    const r = validateBlock({ id: 'b1', type: 'message', data: { role: 'robot', text: 'hi' } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('invalid-data');
      expect(r.issues.length).toBeGreaterThan(0);
      expect(r.issues[0]).toContain('role');
    }
  });

  it('rejects unknown block types', () => {
    const r = validateBlock({ id: 'b1', type: 'totally-made-up', data: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unknown-type');
      expect(r.type).toBe('totally-made-up');
    }
  });

  it('rejects a malformed envelope', () => {
    const r = validateBlock({ type: 'message' }); // missing id
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed-envelope');
  });

  it('composes: a tool-call nests content blocks, each validated recursively', () => {
    const toolCall = {
      id: 't1',
      type: 'tool-call',
      data: {
        tool: 'edit',
        target: 'src/a.ts',
        status: 'done',
        result: [
          { id: 'd1', type: 'diff', data: { file: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b' } },
        ],
      },
    };
    const outer = validateBlock(toolCall);
    expect(outer.ok).toBe(true);
    if (outer.ok) {
      const result = (outer.block.data as { result: unknown[] }).result;
      const inner = validateBlock(result[0]);
      expect(inner.ok).toBe(true);
      if (inner.ok) expect(inner.block.type).toBe('diff');
    }
  });

  it('catches a bad nested block when the child is validated', () => {
    const child = { id: 'd1', type: 'diff', data: { file: 'src/a.ts' } }; // missing required `patch`
    const r = validateBlock(child);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid-data');
  });

  it('builds a catalog with type, tier, description, and JSON Schema per block', () => {
    const cat = buildCatalog();
    const msg = cat.find((e) => e.type === 'message');
    expect(msg).toBeDefined();
    expect(msg!.tier).toBe('transcript');
    expect(msg!.description.length).toBeGreaterThan(0);
    // JSON Schema for { role: enum, text: string }
    expect(msg!.schema).toMatchObject({ type: 'object' });
  });
});
