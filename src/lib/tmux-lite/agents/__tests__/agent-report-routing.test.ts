/**
 * Worker→daemon routing of agent-originated reports, protocol level.
 *
 * Covers the WorkerNotification wire shape and the daemon-side dispatch of an
 * 'agent-report' push to the onAgentReport sink. Extraction of the report from
 * the session event stream lives in agent-report-extract.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import {
  extractAgentReportInput,
  type AgentReportPayload,
  type SessionHostSinks,
} from '../session-host.js';
import { isWorkerNotification, type WorkerNotification } from '../worker/protocol.js';
import { routeWorkerSinkNotification } from '../worker/worker-session-host.js';

const PAYLOAD: AgentReportPayload = {
  sessionId: 'ses_1',
  workspaceId: 'proj/ws',
  workspaceName: 'ws',
  projectName: 'proj',
  sessionTitle: 'Title',
  model: 'anthropic/claude-test-1',
  tool: 'bash',
  report: 'unexpected exit-code behavior',
};

function spySinks() {
  const seen: Record<string, unknown[]> = { event: [], dialog: [], ui: [], report: [] };
  const sinks: SessionHostSinks = {
    onEvent: (e) => seen.event!.push(e),
    onDialogRequest: (r) => seen.dialog!.push(r),
    onUiEvent: (e) => seen.ui!.push(e),
    onAgentReport: (p) => seen.report!.push(p),
  };
  return { sinks, seen };
}

describe('agent-report over the worker IPC protocol', () => {
  test('wire shape passes the notification guard', () => {
    const msg: WorkerNotification = { t: 'agent-report', payload: PAYLOAD };
    // Simulate the IPC boundary: structured-clone JSON both ways.
    const wire = JSON.parse(JSON.stringify(msg));
    expect(isWorkerNotification(wire)).toBe(true);
  });

  test('daemon dispatch routes agent-report to onAgentReport only', () => {
    const { sinks, seen } = spySinks();
    const handled = routeWorkerSinkNotification({ t: 'agent-report', payload: PAYLOAD }, sinks);
    expect(handled).toBe(true);
    expect(seen.report).toEqual([PAYLOAD]);
    expect(seen.event).toEqual([]);
    expect(seen.dialog).toEqual([]);
    expect(seen.ui).toEqual([]);
  });

  test('other sink pushes still route; boot/RPC messages are not sink traffic', () => {
    const { sinks, seen } = spySinks();
    expect(
      routeWorkerSinkNotification(
        { t: 'event', event: { type: 'error', sessionId: 's', error: 'boom' } } as WorkerNotification,
        sinks,
      ),
    ).toBe(true);
    expect(seen.event!.length).toBe(1);
    expect(seen.report).toEqual([]);

    expect(routeWorkerSinkNotification({ t: 'ready', sessionId: 's' }, sinks)).toBe(false);
    expect(routeWorkerSinkNotification({ t: 'rpc-result', id: 1, ok: true, result: null }, sinks)).toBe(false);
  });
});
