import { z } from 'zod';

export const SessionHistoryEntrySchema = z.object({
  id: z.string(), parentId: z.string().nullable(), role: z.enum(['user', 'assistant', 'branch']),
  sequence: z.number(), preview: z.string(), tools: z.number(), childCount: z.number(), current: z.boolean(),
});
export type SessionHistoryEntry = z.infer<typeof SessionHistoryEntrySchema>;
export const SessionHistoryPageRequestSchema = z.object({ anchorId: z.string().nullable(), direction: z.enum(['around', 'before', 'after', 'children']), cursor: z.string().nullable() });
export type SessionHistoryPageRequest = z.infer<typeof SessionHistoryPageRequestSchema>;
export const SessionHistoryPageSchema = z.object({ entries: z.array(SessionHistoryEntrySchema), anchorId: z.string().nullable(), beforeCursor: z.string().nullable(), afterCursor: z.string().nullable() });
export type SessionHistoryPage = z.infer<typeof SessionHistoryPageSchema>;
