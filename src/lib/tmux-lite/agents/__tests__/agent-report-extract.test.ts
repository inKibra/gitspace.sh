/**
 * Agent reports must reach GitSpace's report pipeline.
 *
 * They stopped doing so silently: OMP 16 had a `report_tool_issue` tool, OMP 17
 * turned it into the `xd://report_issue` device dispatched from inside `write`.
 * The extractor still matched the old tool name, so it returned null forever —
 * and because OMP's own recording no-ops without consent (which GitSpace keeps
 * denied on purpose), a filed report simply evaporated. Nothing failed.
 *
 * These drive 17.x-shaped events, and the last one pins our matching against
 * OMP's own predicate so the next rename fails here instead of going quiet.
 */
import { describe, expect, it } from 'bun:test';
import { isReportIssueToolCall } from '@oh-my-pi/pi-coding-agent/tools/report-tool-issue';
import { extractAgentReportInput } from '../session-host.js';

const writeEvent = (content: string, path = 'xd://report_issue'): Record<string, unknown> => ({
  toolName: 'write',
  toolCallId: 'call-1',
  input: { path, content },
});

describe('extractAgentReportInput', () => {
  it('extracts a `<tool>: <description>` write to the device', () => {
    expect(extractAgentReportInput(writeEvent('grep: returned no matches for a pattern that exists')))
      .toEqual({ toolCallId: 'call-1', tool: 'grep', report: 'returned no matches for a pattern that exists' });
  });

  it('extracts the two-line form, tool on the first line', () => {
    expect(extractAgentReportInput(writeEvent('edit\nrewrote a range I did not select')))
      .toEqual({ toolCallId: 'call-1', tool: 'edit', report: 'rewrote a range I did not select' });
  });

  it('prefers the newline split when the body also contains a colon', () => {
    // OMP splits on the newline first; a colon in the prose must not win, or the
    // tool name becomes a sentence fragment.
    const out = extractAgentReportInput(writeEvent('bash\nfailed: exit 127 with no output'));
    expect(out?.tool).toBe('bash');
    expect(out?.report).toBe('failed: exit 127 with no output');
  });

  it('accepts the trailing-slash spelling of the device path', () => {
    expect(extractAgentReportInput(writeEvent('grep: flaky', 'xd://report_issue/'))?.tool).toBe('grep');
  });

  it('reads file_path as well as path', () => {
    expect(extractAgentReportInput({
      toolName: 'write',
      toolCallId: 'c',
      input: { file_path: 'xd://report_issue', content: 'glob: missed a directory' },
    })?.tool).toBe('glob');
  });

  it('ignores ordinary file writes', () => {
    expect(extractAgentReportInput(writeEvent('grep: whatever', 'src/index.ts'))).toBeNull();
  });

  it('ignores other tools', () => {
    expect(extractAgentReportInput({ toolName: 'bash', toolCallId: 'c', input: { command: 'ls' } })).toBeNull();
  });

  it('returns null for an unparseable or empty body', () => {
    expect(extractAgentReportInput(writeEvent('   '))).toBeNull();
    expect(extractAgentReportInput(writeEvent('no separator at all'))).toBeNull();
    // A colon at position 0 leaves no tool name.
    expect(extractAgentReportInput(writeEvent(':orphaned'))).toBeNull();
  });

  it('carries snake_case ids from the alternate event shape', () => {
    expect(extractAgentReportInput({
      tool_name: 'write',
      tool_call_id: 'snake-1',
      input: { path: 'xd://report_issue', content: 'read: truncated silently' },
    })?.toolCallId).toBe('snake-1');
  });

  it('agrees with OMP about what counts as a report write', () => {
    // The rename guard: our literal device path vs the SDK's own predicate.
    const cases = [
      { name: 'write', arguments: { path: 'xd://report_issue', content: 'grep: x' }, expected: true },
      { name: 'write', arguments: { file_path: 'xd://report_issue', content: 'grep: x' }, expected: true },
      { name: 'write', arguments: { path: 'src/index.ts', content: 'grep: x' }, expected: false },
      { name: 'bash', arguments: { path: 'xd://report_issue', content: 'grep: x' }, expected: false },
    ];
    for (const c of cases) {
      expect(isReportIssueToolCall(c)).toBe(c.expected);
      const ours = extractAgentReportInput({ toolName: c.name, toolCallId: 'c', input: c.arguments }) !== null;
      expect(ours).toBe(c.expected);
    }
  });
});
