/**
 * selectFilesForQuery tests - pure index pruning logic
 */

import { describe, expect, it } from 'bun:test';
import { selectFilesForQuery } from '../store.js';
import type { WideEventIndex } from '../../../types/events.js';

function makeIndex(overrides: Partial<WideEventIndex> = {}): WideEventIndex {
  return {
    file: 'events-2025-01-01T00-00.ndjson',
    minTs: 1000,
    maxTs: 2000,
    levels: ['info', 'error'],
    eventNames: ['http_request', 'db_query'],
    count: 10,
    ...overrides,
  };
}

// ============================================================================
// selectFilesForQuery
// ============================================================================

describe('selectFilesForQuery', () => {
  it('should return all indexes when no filter or time range', () => {
    const indexes = [makeIndex(), makeIndex({ file: 'events-2.ndjson' })];
    const result = selectFilesForQuery(indexes, { filter: {} });
    expect(result.length).toBe(2);
  });

  it('should exclude indexes before sinceMs', () => {
    const indexes = [
      makeIndex({ minTs: 1000, maxTs: 2000 }),
      makeIndex({ file: 'events-2.ndjson', minTs: 3000, maxTs: 4000 }),
    ];
    const result = selectFilesForQuery(indexes, { filter: {}, sinceMs: 2500 });
    expect(result.length).toBe(1);
    expect(result[0].file).toBe('events-2.ndjson');
  });

  it('should include index that overlaps sinceMs', () => {
    const indexes = [makeIndex({ minTs: 1000, maxTs: 3000 })];
    const result = selectFilesForQuery(indexes, { filter: {}, sinceMs: 2000 });
    expect(result.length).toBe(1);
  });

  it('should exclude indexes after untilMs', () => {
    const indexes = [
      makeIndex({ minTs: 1000, maxTs: 2000 }),
      makeIndex({ file: 'events-2.ndjson', minTs: 5000, maxTs: 6000 }),
    ];
    const result = selectFilesForQuery(indexes, { filter: {}, untilMs: 3000 });
    expect(result.length).toBe(1);
    expect(result[0].minTs).toBe(1000);
  });

  it('should filter by level', () => {
    const indexes = [
      makeIndex({ levels: ['info'] }),
      makeIndex({ file: 'events-2.ndjson', levels: ['error', 'warn'] }),
    ];
    const result = selectFilesForQuery(indexes, { filter: { level: 'error' } });
    expect(result.length).toBe(1);
    expect(result[0].file).toBe('events-2.ndjson');
  });

  it('should filter by eventName', () => {
    const indexes = [
      makeIndex({ eventNames: ['http_request'] }),
      makeIndex({ file: 'events-2.ndjson', eventNames: ['db_query'] }),
    ];
    const result = selectFilesForQuery(indexes, { filter: { eventName: 'db_query' } });
    expect(result.length).toBe(1);
    expect(result[0].file).toBe('events-2.ndjson');
  });

  it('should combine time range and filter', () => {
    const indexes = [
      makeIndex({ minTs: 1000, maxTs: 2000, levels: ['info'] }),
      makeIndex({ file: 'events-2.ndjson', minTs: 3000, maxTs: 4000, levels: ['error'] }),
      makeIndex({ file: 'events-3.ndjson', minTs: 5000, maxTs: 6000, levels: ['error'] }),
    ];
    const result = selectFilesForQuery(indexes, {
      filter: { level: 'error' },
      sinceMs: 2500,
      untilMs: 4500,
    });
    expect(result.length).toBe(1);
    expect(result[0].file).toBe('events-2.ndjson');
  });

  it('should return empty when no indexes match', () => {
    const indexes = [makeIndex({ levels: ['info'] })];
    const result = selectFilesForQuery(indexes, { filter: { level: 'fatal' } });
    expect(result.length).toBe(0);
  });

  it('should return empty for empty input', () => {
    const result = selectFilesForQuery([], { filter: {} });
    expect(result.length).toBe(0);
  });
});
