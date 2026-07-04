/**
 * Graceful ingestion tests: the collector accepts plain strings, JSON, and
 * JSON-with-correlation, defaulting missing fields instead of dropping lines.
 * Capture gate (mode) decides which lines are candidates; fidelity is per line.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WideEventCollector } from '../collector.js';
import { DEFAULT_EVENTS_CONFIG, type EventsIngestionMode } from '../../../types/config.js';
import type { WideEvent } from '../../../types/events.js';

let dir: string;

function collect(mode: EventsIngestionMode, lines: string[]): WideEvent[] {
  const c = new WideEventCollector({
    config: { ...DEFAULT_EVENTS_CONFIG, mode },
    sessionId: '',
    workspacePath: dir,
    workspaceId: 'ws',
    projectName: 'proj',
    processName: 'web',
  });
  const out: WideEvent[] = [];
  for (const line of lines) out.push(...c.handleChunk(Buffer.from(`${line}\n`)));
  return out.filter((e) => e.kind === 'source');
}

describe('collector graceful ingestion', () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'evt-fidelity-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("all mode: a plain string becomes a string-fidelity event with defaults", () => {
    const [e] = collect('all', ['Server listening on :5173']);
    expect(e.fidelity).toBe('string');
    expect(e.message).toBe('Server listening on :5173');
    expect(e.level).toBe('info');
    expect(e.eventName).toBe('log');
    expect(e.eventId).toBeTruthy(); // auto-generated
    expect(e.timestampMs).toBeGreaterThan(0);
  });

  it('all mode: infers level from a leading token', () => {
    const [e] = collect('all', ['ERROR database connection refused']);
    expect(e.fidelity).toBe('string');
    expect(e.level).toBe('error');
  });

  it('all mode: partial JSON is kept (missing fields defaulted), fidelity json', () => {
    const [e] = collect('all', ['{"message":"hi","port":5173}']);
    expect(e.fidelity).toBe('json');
    expect(e.message).toBe('hi');
    expect(e.level).toBe('info');
    expect(e.eventName).toBe('log');
    expect((e.raw as { port?: number }).port).toBe(5173);
  });

  it('json+correlation: correlation id is extracted', () => {
    const [e] = collect('all', ['{"event":"process.ready","requestId":"abc-1","message":"up"}']);
    expect(e.fidelity).toBe('json+correlation');
    expect(e.correlationId).toBe('abc-1');
    expect(e.eventName).toBe('process.ready');
  });

  it('json mode: bare JSON is captured, plain strings are ignored', () => {
    const events = collect('json', ['just a log line', '{"message":"structured"}']);
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toBe('structured');
  });

  it('prefix mode: only @event lines are captured (strings ignored)', () => {
    const events = collect('prefix', ['plain line', '@event {"message":"marked"}']);
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toBe('marked');
    expect(events[0]!.fidelity).toBe('json');
  });

  it('prefix mode: a marked line with a non-JSON payload is a string event', () => {
    const [e] = collect('prefix', ['@event hello world']);
    expect(e.fidelity).toBe('string');
    expect(e.message).toBe('hello world');
  });
});
