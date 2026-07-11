/**
 * Worker→daemon routing of agent-originated reports, protocol level.
 *
 * Covers: extraction of the SDK's report_tool_issue invocation from the
 * session event stream, the WorkerNotification wire shape, and the
 * daemon-side dispatch of an 'agent-report' push to the onAgentReport sink.
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
  const seen: Record<string, unknown[]> = { event: [], dialog: [], ui: [], term: [], report: [] };
  const sinks: SessionHostSinks = {
    onEvent: (e) => seen.event!.push(e),
    onDialogRequest: (r) => seen.dialog!.push(r),
    onUiEvent: (e) => seen.ui!.push(e),
    onTerminalOutput: (d) => seen.term!.push(d),
    onAgentReport: (p) => seen.report!.push(p),
  };
  return { sinks, seen };
}

describe('extractAgentReportInput', () => {
  test('extracts tool + report from a report_tool_issue tool_execution_end event', () => {
    const extracted = extractAgentReportInput({
      type: 'tool_execution_end',
      toolName: 'report_tool_issue',
      toolCallId: 'call_9',
      input: { tool: 'bash', report: 'exit code swallowed' },
    });
    expect(extracted).toEqual({ toolCallId: 'call_9', tool: 'bash', report: 'exit code swallowed' });
  });

  test('accepts snake_case event field names (tool_name / tool_call_id)', () => {
    const extracted = extractAgentReportInput({
      type: 'tool_result',
      tool_name: 'report_tool_issue',
      tool_call_id: 'call_10',
      input: { tool: 'read', report: 'offset ignored' },
    });
    expect(extracted).toEqual({ toolCallId: 'call_10', tool: 'read', report: 'offset ignored' });
  });

  test('ignores other tools', () => {
    expect(
      extractAgentReportInput({ toolName: 'bash', toolCallId: 'c', input: { tool: 'bash', report: 'x' } }),
    ).toBeNull();
  });

  test('ignores empty/missing report text and malformed input', () => {
    expect(extractAgentReportInput({ toolName: 'report_tool_issue', input: { tool: 'bash', report: '  ' } })).toBeNull();
    expect(extractAgentReportInput({ toolName: 'report_tool_issue', input: 'nope' })).toBeNull();
    expect(extractAgentReportInput({ toolName: 'report_tool_issue' })).toBeNull();
  });

  test('falls back to tool "unknown" when the tool param is absent', () => {
    const extracted = extractAgentReportInput({
      toolName: 'report_tool_issue',
      toolCallId: 'c1',
      input: { report: 'something odd' },
    });
    expect(extracted?.tool).toBe('unknown');
  });
});

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
    expect(seen.term).toEqual([]);
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
