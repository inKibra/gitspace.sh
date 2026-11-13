import { z } from 'zod';

/**
 * Dictation in the workspace composer: one socket per recording (`DICTATION_PATH`, upgraded, signed by one of the
 * account's devices in `Sec-WebSocket-Protocol`). The browser sends the recording as binary frames of 16 kHz mono
 * PCM16 (signed little-endian) and `{ type: 'stop' }` when it ends. The project's inference profile picks the provider
 * (its `dictation` selector): a live provider answers `interim` text while you speak and `final` text per finished
 * utterance; a provider that transcribes recordings answers `transcribing` after `stop`, then one `final`. `done` closes
 * a recording that ended well, `error` one that did not. Final text is the person's draft to edit; nothing sends it.
 */

export const DICTATION_PATH = '/api/dictation';
export const DICTATION_SAMPLE_RATE = 16_000;
/** The longest recording: the server stops it here and sends `limit`. */
export const DICTATION_MAX_MS = 600_000;
/** Bytes of audio in the longest recording. */
export const DICTATION_MAX_BYTES = DICTATION_SAMPLE_RATE * 2 * (DICTATION_MAX_MS / 1000);
/** The largest audio frame a socket takes. */
export const DICTATION_FRAME_MAX_BYTES = 64 * 1024;

export const RuntimeDictationQuerySchema = z.strictObject({ projectId: z.string().min(1).max(256), workspaceId: z.string().min(1).max(256) });
export type RuntimeDictationQuery = z.infer<typeof RuntimeDictationQuerySchema>;

export const RuntimeDictationClientMessageSchema = z.discriminatedUnion('type', [
  /** The recording ended: the provider finishes what it heard. */
  z.strictObject({ type: z.literal('stop') }),
]);
export type RuntimeDictationClientMessage = z.infer<typeof RuntimeDictationClientMessageSchema>;

export const RuntimeDictationServerMessageSchema = z.discriminatedUnion('type', [
  /** The provider is ready for audio. `live`: text arrives while you speak; `batch`: after the recording stops. */
  z.strictObject({ type: z.literal('ready'), mode: z.enum(['live', 'batch']) }),
  /** What the live provider heard so far of the utterance in progress; the next `interim` or `final` replaces it. */
  z.strictObject({ type: z.literal('interim'), text: z.string() }),
  /** Finished text, for the draft at the cursor. */
  z.strictObject({ type: z.literal('final'), text: z.string() }),
  /** The recording stopped and the provider is transcribing it. */
  z.strictObject({ type: z.literal('transcribing') }),
  /** The recording reached `DICTATION_MAX_MS`: the server stopped it and finishes what it heard. */
  z.strictObject({ type: z.literal('limit') }),
  /** Every final text was sent; the socket closes. */
  z.strictObject({ type: z.literal('done') }),
  z.strictObject({ type: z.literal('error'), message: z.string() }),
]);
export type RuntimeDictationServerMessage = z.infer<typeof RuntimeDictationServerMessageSchema>;
