import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { TranscriptEvent } from '@gitspace/protocol-runtime/session-controls';

const HeaderSchema = z.object({ type: z.literal('session'), version: z.number().optional() });
export const LegacyTitleSlotSchema = z.object({ type: z.literal('title'), v: z.literal(1), title: z.string(), updatedAt: z.string(), pad: z.string(), source: z.enum(['user', 'auto']).optional() });
const EntrySchema = z.object({ id: z.string(), parentId: z.string().nullable(), type: z.string(), timestamp: z.string(), message: z.unknown().optional(), customType: z.string().optional(), data: z.unknown().optional() }).passthrough();
/** Historical JSONL is data, never an executable runtime or a reason to launch OMP. */
export function readLegacyTranscriptBytes(bytes: Uint8Array): TranscriptEvent[] {
  const rows = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n');
  const entries = new Map<string, z.infer<typeof EntrySchema>>();
  let leaf: string | null = null;
  let header = false;
  let version = 1;
  for (let index = 0; index < rows.length; index++) {
    const line = rows[index]!;
    if (!line.trim()) continue;
    const input: unknown = JSON.parse(line);
    if (!header && LegacyTitleSlotSchema.safeParse(input).success) continue;
    if (!header) {
      const parsed = HeaderSchema.parse(input);
      if (parsed.version !== undefined && parsed.version > 3) throw new Error(`Unsupported historical session format ${parsed.version}`);
      version = parsed.version ?? 1;
      header = true; continue;
    }
    const entry: z.infer<typeof EntrySchema> = version < 2
      ? EntrySchema.parse({ ...z.record(z.string(), z.unknown()).parse(input), id: `legacy-${index}`, parentId: leaf })
      : EntrySchema.parse(input);
    if (version < 3 && entry.type === 'message') {
      const message = z.record(z.string(), z.unknown()).safeParse(entry.message);
      if (message.success && message.data.role === 'hookMessage') entry.message = { ...message.data, role: 'custom' };
    }
    entries.set(entry.id, entry); leaf = entry.id;
  }
  if (!header) throw new Error('Historical session header is missing');
  const branch: z.infer<typeof EntrySchema>[] = [];
  const seen = new Set<string>();
  while (leaf !== null) {
    if (seen.has(leaf)) throw new Error('Historical session contains a parent cycle');
    seen.add(leaf);
    const entry = entries.get(leaf);
    if (!entry) throw new Error('Historical session has a missing parent');
    branch.push(entry); leaf = entry.parentId;
  }
  const events: TranscriptEvent[] = [];
  for (const entry of branch.reverse()) {
    if (entry.type === 'message') events.push({ ordinal: events.length + 1, kind: 'message_end', payload: { message: entry.message }, createdAt: entry.timestamp });
    if (entry.type === 'custom') {
      if (!entry.customType) throw new Error('Historical custom event has no type');
      const object = z.record(z.string(), z.unknown()).safeParse(entry.data);
      events.push({ ordinal: events.length + 1, kind: entry.customType, payload: object.success ? object.data : { value: entry.data }, createdAt: entry.timestamp });
    }
  }
  return events;
}
export async function readLegacyTranscriptFile(path: string): Promise<TranscriptEvent[]> { return readLegacyTranscriptBytes(await readFile(path)); }
