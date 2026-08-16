/**
 * Ticket #42.4: self-diagnosing transport instrumentation.
 *
 * Proves the three primitives that make an oversize-frame / 1006 disconnect a
 * one-line read: the rolling frame ledger (bounded, tracks last-each-way), the
 * send-side oversize guard (fires strictly above MAX_FRAME_SIZE, names the
 * producer, routes to the sink), and the close-summary shape (code/reason/last
 * frames/ledger, ledger only on abnormal close).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  FrameLedger,
  guardOversizeSend,
  isAbnormalClose,
  MAX_FRAME_SIZE_BYTES,
  peekFrameType,
  setTransportDiagnosticSink,
  summarizeClose,
  type TransportDiagnostic,
} from '../transport-diagnostics.js';

afterEach(() => setTransportDiagnosticSink(null));

/** Capture diagnostics + suppress the helpers' console lines during a call. */
function capture(fn: (log: (m: string) => void) => void): TransportDiagnostic[] {
  const out: TransportDiagnostic[] = [];
  setTransportDiagnosticSink((d) => out.push(d));
  try {
    fn(() => {});
  } finally {
    setTransportDiagnosticSink(null);
  }
  return out;
}

describe('FrameLedger', () => {
  test('rolls and caps at N (oldest dropped)', () => {
    const ledger = new FrameLedger(20);
    for (let i = 0; i < 25; i += 1) {
      ledger.record('send', i, `t${i}`);
    }
    const snap = ledger.snapshot();
    expect(snap.length).toBe(20);
    // Oldest 5 dropped: first retained is t5, last is t24.
    expect(snap[0]?.type).toBe('t5');
    expect(snap[snap.length - 1]?.type).toBe('t24');
  });

  test('tracks last frame in each direction independently', () => {
    const ledger = new FrameLedger();
    ledger.record('send', 10, 'pty');
    ledger.record('recv', 20, 'data');
    ledger.record('send', 30, 'machine_snapshot');
    expect(ledger.lastSent).toMatchObject({ dir: 'send', size: 30, type: 'machine_snapshot' });
    expect(ledger.lastRecv).toMatchObject({ dir: 'recv', size: 20, type: 'data' });
  });

  test('reset clears entries and last pointers', () => {
    const ledger = new FrameLedger();
    ledger.record('send', 1, 'a');
    ledger.reset();
    expect(ledger.snapshot()).toEqual([]);
    expect(ledger.lastSent).toBeNull();
    expect(ledger.lastRecv).toBeNull();
  });
});

describe('guardOversizeSend', () => {
  test('does NOT fire at or below MAX_FRAME_SIZE', () => {
    const atCap = capture((log) =>
      guardOversizeSend({ socket: 's', role: 'client', size: MAX_FRAME_SIZE_BYTES, type: 'pty', log }),
    );
    const below = capture((log) =>
      guardOversizeSend({ socket: 's', role: 'client', size: 1024, type: 'pty', log }),
    );
    expect(atCap).toEqual([]);
    expect(below).toEqual([]);
  });

  test('fires above MAX_FRAME_SIZE and names the producer', () => {
    let fired = false;
    const diags = capture((log) => {
      fired = guardOversizeSend({
        socket: 'conn-1',
        role: 'machine',
        size: MAX_FRAME_SIZE_BYTES + 1,
        type: 'machine_snapshot',
        log,
      });
    });
    expect(fired).toBe(true);
    expect(diags.length).toBe(1);
    expect(diags[0]).toMatchObject({
      kind: 'transport-oversize-send',
      socket: 'conn-1',
      role: 'machine',
      type: 'machine_snapshot',
      size: MAX_FRAME_SIZE_BYTES + 1,
      maxFrameSize: MAX_FRAME_SIZE_BYTES,
      willChunk: true,
    });
  });
});

describe('isAbnormalClose', () => {
  test('1000/1001/undefined are normal; 1006 and others abnormal', () => {
    expect(isAbnormalClose(1000)).toBe(false);
    expect(isAbnormalClose(1001)).toBe(false);
    expect(isAbnormalClose(undefined)).toBe(false);
    expect(isAbnormalClose(1006)).toBe(true);
    expect(isAbnormalClose(1011)).toBe(true);
  });
});

describe('summarizeClose', () => {
  test('normal close: shape carries last frames, omits ledger', () => {
    const ledger = new FrameLedger();
    ledger.record('send', 100, 'pty');
    ledger.record('recv', 200, 'data');
    const diags = capture((log) =>
      summarizeClose({
        role: 'client',
        socket: 'machine-x',
        code: 1000,
        reason: 'bye',
        ledger,
        startedAtMs: Date.now() - 5000,
        log,
      }),
    );
    expect(diags.length).toBe(1);
    const d = diags[0] as Extract<TransportDiagnostic, { kind: 'transport-close' }>;
    expect(d).toMatchObject({ kind: 'transport-close', role: 'client', socket: 'machine-x', code: 1000, abnormal: false });
    expect(d.lastSent).toMatchObject({ size: 100, type: 'pty' });
    expect(d.lastRecv).toMatchObject({ size: 200, type: 'data' });
    expect(d.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(d.ledger).toEqual([]); // normal close → no ledger dump
  });

  test('abnormal close (1006): includes the full ledger', () => {
    const ledger = new FrameLedger();
    ledger.record('send', 6_680_000, 'data');
    ledger.record('recv', 42, 'data');
    const diags = capture((log) =>
      summarizeClose({ role: 'machine', socket: 'conn-9', code: 1006, reason: 'Received too big message', ledger, startedAtMs: Date.now(), log }),
    );
    const d = diags[0] as Extract<TransportDiagnostic, { kind: 'transport-close' }>;
    expect(d.abnormal).toBe(true);
    expect(d.code).toBe(1006);
    expect(d.reason).toBe('Received too big message');
    expect(d.ledger.length).toBe(2);
    expect(d.ledger[0]).toMatchObject({ dir: 'send', size: 6_680_000, type: 'data' });
  });
});

describe('server sink → trace ring (machine-side report path, ticket #42.4)', () => {
  test('installServerTransportDiagnostics routes diagnostics into getTraceRing', async () => {
    // Keep the on-disk JSONL append inside the scratchpad (best-effort; the
    // in-memory ring is what report.server.traceRing carries).
    process.env.GITSPACE_TRACE_FILE = `${process.env.TMPDIR ?? '/tmp'}/gssh-transport-diag-test-${process.pid}.jsonl`;
    const { installServerTransportDiagnostics } = await import('../transport-diagnostics-server.js');
    const { getTraceRing } = await import('../../../utils/trace-log.js');
    installServerTransportDiagnostics();
    guardOversizeSend({
      socket: 'conn-42',
      role: 'machine',
      size: MAX_FRAME_SIZE_BYTES + 1,
      type: 'machine_snapshot',
      log: () => {},
    });
    const ring = getTraceRing();
    const entry = ring.find((e) => e.event === 'transport-oversize-send');
    expect(entry).toBeDefined();
    expect(entry?.details).toMatchObject({ type: 'machine_snapshot', socket: 'conn-42' });
  });
});

describe('peekFrameType', () => {
  test('reads JSON type field; falls back for non-JSON (encrypted) bytes', () => {
    expect(peekFrameType(JSON.stringify({ type: 'ping' }))).toBe('ping');
    expect(peekFrameType(new Uint8Array([0x00, 0x01, 0x02, 0xff]))).toBe('data');
    expect(peekFrameType('not json', 'fallbk')).toBe('fallbk');
  });
});
