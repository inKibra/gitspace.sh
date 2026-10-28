import { z } from 'zod';
import { RuntimeGrepArgumentsSchema, RuntimeReadArgumentsSchema } from './tool-arguments.js';

/** The most of one tool's text output a workspace keeps; the rest of a longer output is dropped. */
export const TOOL_RESULT_MAX_BYTES = 25 * 1024 * 1024;
/** Kept tool output a workspace holds; past it the oldest results are pruned. */
export const WORKSPACE_TOOL_RESULTS_MAX_BYTES = 500 * 1024 * 1024;
/** Where a kept tool output lives: the workspace object that ran the call, its conversation and the call. */
export type RuntimeToolResultLocation = { workspaceId: string; conversationId: string; callId: string };

/** `result://<workspace>/<conversation>/<call>`, each part URI-encoded: provider call IDs may hold `|` or `/`. */
export function toolResultReference(location: RuntimeToolResultLocation): string {
  return `result://${[location.workspaceId, location.conversationId, location.callId].map(encodeURIComponent).join('/')}`;
}

/** The location a `result://` reference names, or null when `uri` is not one. */
export function parseToolResultReference(uri: string): RuntimeToolResultLocation | null {
  const match = /^result:\/\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(uri);
  if (!match) return null;
  try {
    return { workspaceId: decodeURIComponent(match[1]!), conversationId: decodeURIComponent(match[2]!), callId: decodeURIComponent(match[3]!) };
  } catch { return null; }
}

export function isToolResultReference(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('result://');
}

/**
 * `details.fullOutput` of a tool result whose text output was longer than the transcript keeps: the model saw its head (or
 * tail) and `reference`; the workspace keeps `keptBytes` of its `bytes` UTF-8 bytes (all of them up to
 * `TOOL_RESULT_MAX_BYTES`), in `lines` lines.
 */
export const RuntimeFullOutputSchema = z.object({ reference: z.string().min(1), bytes: z.number().int().nonnegative(), lines: z.number().int().nonnegative(), keptBytes: z.number().int().nonnegative() });
export type RuntimeFullOutput = z.infer<typeof RuntimeFullOutputSchema>;
export const RuntimeFullOutputDetailsSchema = z.object({ fullOutput: RuntimeFullOutputSchema });
/** A `read` or `grep` call on a `result://` path, as the workspace that kept the output answers it. */
export const RuntimeToolResultRequestSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('read'), args: RuntimeReadArgumentsSchema }),
  z.object({ tool: z.literal('grep'), args: RuntimeGrepArgumentsSchema }),
]);
export type RuntimeToolResultRequest = z.infer<typeof RuntimeToolResultRequestSchema>;
