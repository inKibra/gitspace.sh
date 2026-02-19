/**
 * matchFilter tests - pure event filter matching from collector
 */

import { describe, expect, it } from 'bun:test';
import { matchFilter } from '../collector.js';
import type { WideEvent, WideEventFilter } from '../../../types/events.js';

function makeEvent(overrides: Partial<WideEvent> = {}): WideEvent {
  return {
    eventId: 'evt-1',
    eventName: 'http_request',
    level: 'info',
    timestamp: '2025-01-01T00:00:00.000Z',
    timestampMs: 1735689600000,
    message: 'GET /api/users 200',
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    projectName: 'proj-1',
    raw: {},
    ...overrides,
  };
}

// ============================================================================
// matchFilter
// ============================================================================

describe('matchFilter', () => {
  it('should match when filter is empty', () => {
    expect(matchFilter(makeEvent(), {})).toBe(true);
  });

  it('should match on eventName', () => {
    expect(matchFilter(makeEvent(), { eventName: 'http_request' })).toBe(true);
  });

  it('should reject on eventName mismatch', () => {
    expect(matchFilter(makeEvent(), { eventName: 'db_query' })).toBe(false);
  });

  it('should match on eventId', () => {
    expect(matchFilter(makeEvent(), { eventId: 'evt-1' })).toBe(true);
  });

  it('should reject on eventId mismatch', () => {
    expect(matchFilter(makeEvent(), { eventId: 'evt-2' })).toBe(false);
  });

  it('should match on level', () => {
    expect(matchFilter(makeEvent({ level: 'error' }), { level: 'error' })).toBe(true);
  });

  it('should reject on level mismatch', () => {
    expect(matchFilter(makeEvent({ level: 'info' }), { level: 'error' })).toBe(false);
  });

  it('should match on message substring', () => {
    expect(matchFilter(makeEvent(), { message: '/api/users' })).toBe(true);
  });

  it('should reject on message substring mismatch', () => {
    expect(matchFilter(makeEvent(), { message: '/api/posts' })).toBe(false);
  });

  it('should match on processName', () => {
    const event = makeEvent({ processName: 'web' });
    expect(matchFilter(event, { processName: 'web' })).toBe(true);
  });

  it('should reject on processName mismatch', () => {
    const event = makeEvent({ processName: 'worker' });
    expect(matchFilter(event, { processName: 'web' })).toBe(false);
  });

  it('should match on kind', () => {
    const event = makeEvent({ kind: 'wide' });
    expect(matchFilter(event, { kind: 'wide' })).toBe(true);
  });

  it('should reject on kind mismatch', () => {
    const event = makeEvent({ kind: 'source' });
    expect(matchFilter(event, { kind: 'wide' })).toBe(false);
  });

  it('should match on correlationId', () => {
    const event = makeEvent({ correlationId: 'corr-1' });
    expect(matchFilter(event, { correlationId: 'corr-1' })).toBe(true);
  });

  it('should reject on correlationId mismatch', () => {
    const event = makeEvent({ correlationId: 'corr-2' });
    expect(matchFilter(event, { correlationId: 'corr-1' })).toBe(false);
  });

  it('should match with multiple filter fields (AND logic)', () => {
    const event = makeEvent({ eventName: 'http_request', level: 'error' });
    expect(matchFilter(event, { eventName: 'http_request', level: 'error' })).toBe(true);
  });

  it('should reject when any filter field mismatches', () => {
    const event = makeEvent({ eventName: 'http_request', level: 'info' });
    expect(matchFilter(event, { eventName: 'http_request', level: 'error' })).toBe(false);
  });
});
