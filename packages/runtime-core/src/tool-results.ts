import { boundOutput, utf8ByteLength, type OutputLimits } from '@earendil-works/chord/output';
import type { ToolExecutionResult } from '@earendil-works/pi-durable';
import { TOOL_RESULT_MAX_BYTES, type RuntimeFullOutput } from '@gitspace/protocol-runtime';

/** A call of one of the workspace's conversations. */
export type ToolResultKey = { conversationId: string; callId: string };
/** Tool output kept whole past what the transcript keeps, in the workspace object's own storage, which no turn's context
 * reads. */
export type ToolResultStore = {
  /** Keeps `text` as the call's output, replacing an earlier attempt's (a rerun after a restart), and returns its
   * `result://` reference. */
  put(input: ToolResultKey & { text: string }): Promise<string>;
  /** The text kept for the call; throws when there is none or the workspace pruned it. */
  text(key: ToolResultKey): Promise<string>;
};
/** What pi-durable keeps of a tool's output by default (its `DEFAULT_MAX_BYTES` and `DEFAULT_MAX_LINES`, from the head),
 * set on every GitSpace tool registration so the harness and `keepWholeOutput` cut at the same place. */
export const TOOL_OUTPUT_LIMITS: OutputLimits = { maxBytes: 50 * 1024, maxLines: 2000, retain: 'head' };

/** Lines as pi-durable counts them: a trailing newline ends the last line rather than starting another. */
function lineCount(text: string): number {
  if (text === '') return 0;
  let newlines = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) newlines++;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

/**
 * One line of JSON (an MCP result, say) cannot be paged or grepped by line, so it is kept and shown indented, which parses
 * to the same value. Any other text stays as it is, and so does JSON whose indented form would pass what a result keeps.
 */
function indentedJson(text: string): string {
  const newline = text.indexOf('\n');
  if ((newline !== -1 && newline !== text.length - 1) || text.length > TOOL_RESULT_MAX_BYTES) return text;
  let indented: string;
  try { indented = JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  return utf8ByteLength(indented) > TOOL_RESULT_MAX_BYTES ? text : indented;
}

/**
 * A result whose text output is longer than `limits` keep, with that text kept whole in `store` (the first, or last,
 * `TOOL_RESULT_MAX_BYTES` of it): its text becomes the part the harness keeps, shortened to leave room for a line naming
 * the reference, the whole size and how to read the rest, and `details.fullOutput` marks it. Text items are joined by
 * newlines into that one, and one line of JSON is indented; images stay in place. A result that fits is returned as it is.
 */
export async function keepWholeOutput(result: ToolExecutionResult, store: ToolResultStore, key: ToolResultKey, limits: OutputLimits): Promise<ToolExecutionResult> {
  const output = result.output ?? [];
  const joined = output.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');
  if (boundOutput(joined, limits).droppedBytes === 0) return result;
  const text = indentedJson(joined);
  const kept = boundOutput(text, { maxBytes: TOOL_RESULT_MAX_BYTES, maxLines: Number.MAX_SAFE_INTEGER, retain: limits.retain });
  const reference = await store.put({ ...key, text: kept.text });
  const full: RuntimeFullOutput = { reference, bytes: kept.bytes + kept.droppedBytes, lines: lineCount(text), keptBytes: kept.bytes };
  const size = full.bytes >= 1024 * 1024 ? `${(full.bytes / 1024 / 1024).toFixed(1)} MB` : `${(full.bytes / 1024).toFixed(1)} KB`;
  const head = limits.retain === 'head';
  const how = kept.droppedBytes > 0
    ? `The ${head ? 'first' : 'last'} ${TOOL_RESULT_MAX_BYTES / 1024 / 1024} MB of it is kept as ${reference}: read it with offset and limit, or grep it; the rest was dropped.`
    : `The whole output is kept as ${reference}: read it with offset and limit, grep it, or call this tool from codemode, which receives it whole.`;
  /** `shown` lines, the last of them possibly cut, and the line to read on from. */
  const note = (shown: number, next: number) => head
    ? `[Output truncated after line ${shown} of ${full.lines} (${size} in all); offset ${next} reads on. ${how}]`
    : `[Output truncated: its last ${shown} of ${full.lines} lines follow (${size} in all). ${how}]`;
  // Counting every line as shown gives the longest note, so the actual one fits the room left for it.
  const room = new TextEncoder().encode(note(full.lines, full.lines + 1)).length + 1;
  const preview = boundOutput(text, { maxBytes: limits.maxBytes - room, maxLines: limits.maxLines - 1, retain: limits.retain }).text;
  const shown = lineCount(preview);
  const shortened = head
    ? `${preview}${preview === '' || preview.endsWith('\n') ? '' : '\n'}${note(shown, preview.endsWith('\n') ? shown + 1 : Math.max(shown, 1))}`
    : `${note(shown, 0)}\n${preview}`;
  const at = head ? output.findIndex(item => item.type === 'text') : output.findLastIndex(item => item.type === 'text');
  const details = result.details !== null && typeof result.details === 'object' && !Array.isArray(result.details) ? result.details : {};
  return { ...result, output: output.filter((item, index) => item.type !== 'text' || index === at).map(item => item.type === 'text' ? { type: 'text' as const, text: shortened } : item), details: { ...details, fullOutput: full } };
}
