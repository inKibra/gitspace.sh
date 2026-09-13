import { describe, expect, it } from 'bun:test';
import {
  TRANSCRIPT_CONTENT_CHARACTERS,
  TRANSCRIPT_PAGE_BYTES,
  TRANSCRIPT_PAGE_ROWS,
  TRANSCRIPT_ROW_BYTES,
  TranscriptProjector,
  previewTranscriptItem,
  transcriptContentPageSchema,
  transcriptContentRequestSchema,
  transcriptItemSchema,
  transcriptPageRequestSchema,
  transcriptPageSchema,
  transcriptRowSchema,
  transcriptRowsToTurns,
  type TranscriptEventInput,
  type TranscriptItem,
  type TranscriptProjectionStore,
  type TranscriptRow,
  type TurnBlock,
} from '../src/index.js';

// Detached reads exercise the same ownership boundary as a persistent store.
function projectionStore() {
  const records = new Map<string, { turnId: string; ordinal: number; text: string }>();
  const statuses = new Map<string, TurnBlock['status']>();
  const memberships = new Map<string, Set<string>>();
  const hidden = new Set<string>();
  const runs = new Map<string, string>();
  const store: TranscriptProjectionStore = {
    read(id) {
      const value = records.get(id);
      return value ? JSON.parse(value.text) as TranscriptItem : undefined;
    },
    owner(id) { return records.get(id)?.turnId; },
    executionRun(identity, rowId) {
      for (const [executionId, members] of memberships) {
        if (members.has(rowId) && (executionId === identity || executionId.startsWith(`${identity}:run:`))) return executionId;
      }
      return runs.get(identity);
    },
    bindExecutionRun(identity, executionId) { runs.set(identity, executionId); },
    write(turnId, item) {
      records.set(item.id, { turnId: records.get(item.id)?.turnId ?? turnId, ordinal: records.get(item.id)?.ordinal ?? records.size, text: JSON.stringify(item) });
    },
    turn(id, status) { statuses.set(id, status); },
    linkExecution(executionId, rowId, hide) {
      let members = memberships.get(executionId);
      if (!members) memberships.set(executionId, members = new Set());
      const inserted = !members.has(rowId);
      members.add(rowId);
      if (hide) hidden.add(rowId);
      return inserted;
    },
  };
  return {
    store,
    page(offset = 0, count = TRANSCRIPT_PAGE_ROWS): TranscriptRow[] {
      return [...records.entries()].filter(([id]) => !hidden.has(id)).slice(offset, offset + count).map(([id, record]) => ({
        id,
        ordinal: record.ordinal,
        turnId: record.turnId,
        turnStatus: statuses.get(record.turnId)!,
        ...previewTranscriptItem(JSON.parse(record.text) as TranscriptItem),
      }));
    },
  };
}

function event(ordinal: number, kind: string, payload: Record<string, unknown> = {}): TranscriptEventInput {
  return { sessionId: 'session', ordinal, kind, payload };
}

function assistant(ordinal: number, kind: 'message_update' | 'message_end', text: string): TranscriptEventInput {
  return event(ordinal, kind, { message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

describe('TranscriptProjector', () => {
  it('updates the original tool and ask after many pages of one uninterrupted turn', () => {
    const { store, page } = projectionStore();
    const projector = new TranscriptProjector('session', store);
    projector.apply(event(1, 'tool_execution_start', { toolCallId: 'early-tool', toolName: 'read', args: { path: 'first.ts' } }));
    projector.apply(event(2, 'tool_execution_start', { toolCallId: 'early-ask', toolName: 'ask', args: { questions: [
      { id: 'choice', question: 'Which branch?', options: [{ label: 'Main' }, { label: 'Release' }] },
    ] } }));
    projector.flush();
    const original = page(0, 2);
    for (let index = 0; index < 1400; index++) {
      projector.apply(assistant(index + 3, 'message_end', `Intermediate answer ${index}`));
      projector.flush();
    }
    expect(page(1400, 2).map((row) => row.item)).toEqual([
      expect.objectContaining({ text: 'Intermediate answer 1398' }),
      expect.objectContaining({ text: 'Intermediate answer 1399' }),
    ]);
    projector.apply(event(1403, 'tool_execution_update', { toolCallId: 'early-tool', partialResult: 'Still reading' }));
    projector.flush();
    expect(page(0, 1)[0]).toMatchObject({
      id: original[0]!.id,
      ordinal: original[0]!.ordinal,
      item: { status: 'running', result: [{ text: 'Still reading' }] },
    });
    projector.apply(event(1404, 'tool_execution_end', { toolCallId: 'early-tool', result: 'Original file contents' }));
    projector.apply(event(1405, 'message_end', { message: {
      role: 'toolResult', toolCallId: 'early-ask', details: { id: 'choice', selectedOptions: ['Release'] }, content: [],
    } }));
    projector.flush();
    expect(page(0, 2)).toMatchObject([
      { id: original[0]!.id, ordinal: original[0]!.ordinal, turnStatus: 'done', item: { status: 'done', result: [{ text: 'Original file contents' }] } },
      { id: original[1]!.id, ordinal: original[1]!.ordinal, turnStatus: 'done', item: { status: 'answered', questions: [{ answer: 'Release' }] } },
    ]);
    expect(page(1400, 2).every((row) => row.turnId === original[0]!.turnId && row.turnStatus === 'done')).toBe(true);
  });

  it('keeps streaming row identities through flush and finalization without overwriting later messages', () => {
    const { store, page } = projectionStore();
    const projector = new TranscriptProjector('session', store);
    projector.apply(assistant(10, 'message_update', 'First partial'));
    projector.flush();
    const first = page()[0]!;
    expect(first.item).toMatchObject({ text: 'First partial', pending: true });
    projector.apply(assistant(20, 'message_end', 'First final'));
    projector.flush();
    expect(page()[0]).toMatchObject({ id: first.id, ordinal: first.ordinal, turnStatus: 'done', item: { text: 'First final', pending: false } });
    projector.apply(assistant(30, 'message_update', 'Second partial'));
    projector.flush();
    const second = page()[1]!;
    expect(second.id).not.toBe(first.id);
    expect(second.turnId).toBe(first.turnId);
    expect(page()[0]!.item).toMatchObject({ text: 'First final', pending: false });
    projector.apply(assistant(40, 'message_end', 'Second final'));
    projector.apply(assistant(50, 'message_end', 'Third non-streamed answer'));
    projector.flush();
    expect(page().map((row) => row.item)).toEqual([
      expect.objectContaining({ id: first.id, text: 'First final', pending: false }),
      expect.objectContaining({ id: second.id, text: 'Second final', pending: false }),
      expect.objectContaining({ text: 'Third non-streamed answer' }),
    ]);
    expect(page().every((row) => row.turnStatus === 'done')).toBe(true);
  });

  it('finalizes empty text and does not double-complete tools when both result event forms arrive', () => {
    const { store, page } = projectionStore();
    const projector = new TranscriptProjector('session', store);
    projector.apply(assistant(1, 'message_update', 'Discarded draft'));
    projector.apply(assistant(2, 'message_end', ''));
    projector.apply(event(3, 'tool_execution_start', { toolCallId: 'first', toolName: 'read' }));
    projector.apply(event(4, 'tool_execution_start', { toolCallId: 'second', toolName: 'read' }));
    projector.apply(event(5, 'tool_execution_end', { toolCallId: 'first', result: 'Finished' }));
    projector.apply(event(6, 'message_end', { message: { role: 'toolResult', toolCallId: 'first', content: [{ type: 'text', text: 'Finished' }] } }));
    projector.flush();
    expect(page()[0]!.item).toMatchObject({ text: '', pending: false });
    expect(page().every((row) => row.turnStatus === 'running')).toBe(true);
    projector.apply(event(7, 'tool_execution_end', { toolCallId: 'second', result: 'Also finished' }));
    projector.flush();
    expect(page().every((row) => row.turnStatus === 'done')).toBe(true);
  });
});

function rowFor(item: TranscriptItem): TranscriptRow {
  return { id: item.id, ordinal: 0, turnId: 'turn', turnStatus: 'done', ...previewTranscriptItem(item) };
}

describe('bounded transcript previews', () => {
  it('keeps fitting messages, tool metadata, attachments and questions complete', () => {
    const items: TranscriptItem[] = [
      { id: 'message', type: 'message', role: 'assistant', text: 'complete text '.repeat(700) },
      { id: 'tool', type: 'tool-call', toolCallId: 'call', tool: 'read', status: 'done',
        args: { path: 'source.ts' }, details: { lines: 100 }, result: [{ id: 'result', type: 'code', text: 'complete output '.repeat(500) }] },
      { id: 'image', type: 'image', url: `data:image/png;base64,${'aW1hZ2U='.repeat(600)}` },
      { id: 'ask', type: 'ask', toolCallId: 'question', status: 'pending',
        questions: [{ id: 'choice', prompt: 'Choose one', options: Array.from({ length: 70 }, (_, index) => ({ id: String(index), title: `Option ${index}` })) }] },
    ];
    for (const item of items) {
      const row = rowFor(item);
      expect(row.truncated).toBe(false);
      expect(row.item).toEqual(item);
      expect(transcriptRowSchema.safeParse(row).success).toBe(true);
    }
  });

  it('bounds escaped and multibyte text in serialized UTF-8, without changing the full source', () => {
    const item: TranscriptItem = { id: 'text', type: 'message', role: 'assistant', text: '\u0000"\\界😀'.repeat(20_000) };
    const fullText = JSON.stringify(item);
    const row = rowFor(item);
    expect(row.truncated).toBe(true);
    expect(row.contentBytes).toBe(new TextEncoder().encode(fullText).byteLength);
    expect(new TextEncoder().encode(JSON.stringify(row)).byteLength).toBeLessThanOrEqual(TRANSCRIPT_ROW_BYTES);
    expect(transcriptRowSchema.safeParse(row).success).toBe(true);
    expect(row.item.type === 'message' && item.text.startsWith(row.item.text)).toBe(true);
    expect(JSON.stringify(item)).toBe(fullText);
  });

  it('strips raw tool metadata and bounds nested results while the store keeps complete content', () => {
    const { store } = projectionStore();
    const item: TranscriptItem = {
      id: 'tool', type: 'tool-call', toolCallId: 'tool-call', tool: 'read', status: 'done',
      args: { hidden: 'private-input'.repeat(20_000) },
      details: { hidden: 'private-output'.repeat(20_000) },
      result: Array.from({ length: 200 }, (_, index) => ({ id: `result-${index}`, type: 'code', text: `Result ${index}: ${'data'.repeat(2000)}` })),
    };
    store.write('turn', item);
    const preview = rowFor(store.read(item.id)!);
    expect(preview.item).not.toHaveProperty('args');
    expect(preview.item).not.toHaveProperty('details');
    expect(preview.truncated).toBe(true);
    expect(transcriptRowSchema.safeParse(preview).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(preview)).byteLength).toBeLessThanOrEqual(TRANSCRIPT_ROW_BYTES);
    expect(store.read(item.id)).toEqual(item);
  });

  it('caps large nested tables and question/options arrays without violating their schemas', () => {
    const table = rowFor({
      id: 'table', type: 'table', columns: ['Result', 'Explanation'],
      rows: Array.from({ length: 100 }, () => ['value'.repeat(200), 'explanation'.repeat(100)]),
    });
    const ask = rowFor({
      id: 'ask', type: 'ask', toolCallId: 'question-tool', status: 'pending',
      questions: Array.from({ length: 100 }, (_, index) => ({
        id: `question-${index}`, prompt: 'Choose '.repeat(100),
        options: Array.from({ length: 100 }, (_, option) => ({ id: `option-${option}`, title: 'Option', preview: 'preview'.repeat(100) })),
      })),
    });
    for (const row of [table, ask]) {
      expect(row.truncated).toBe(true);
      expect(transcriptRowSchema.safeParse(row).success).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(row)).byteLength).toBeLessThanOrEqual(TRANSCRIPT_ROW_BYTES);
    }
  });

  it('keeps small images intact and omits oversized inline data without emitting broken base64', () => {
    const large = 'aW1hZ2U='.repeat(20_000);
    const imageMessage: TranscriptItem = { id: 'images', type: 'message', role: 'user', text: '', images: [
      { mimeType: 'image/png', data: 'aW1hZ2U=' },
      { mimeType: 'image/png', data: large },
    ] };
    const row = rowFor(imageMessage);
    expect(row.item).toMatchObject({ images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }] });
    expect(row.truncated).toBe(true);
    expect(transcriptRowSchema.safeParse(row).success).toBe(true);
    const image = previewTranscriptItem({ id: 'image', type: 'image', url: `data:image/png;base64,${large}` });
    expect(image.truncated).toBe(true);
    expect(image.item).toMatchObject({ id: 'image', type: 'image', url: '' });
    expect(transcriptItemSchema.safeParse(image.item).success).toBe(true);
    expect(imageMessage.images![1]!.data).toBe(large);
  });
});

describe('transcript paging boundary schemas', () => {
  it('rejects ambiguous selectors and invalid positions while allowing the latest and empty pages', () => {
    expect(transcriptPageRequestSchema.parse({})).toEqual({ generation: null, before: null, after: null, around: null });
    expect(transcriptPageRequestSchema.safeParse({ before: 1, after: 2 }).success).toBe(false);
    expect(transcriptPageRequestSchema.safeParse({ around: 'row', before: 1 }).success).toBe(false);
    expect(transcriptPageRequestSchema.safeParse({ before: -1 }).success).toBe(false);
    expect(transcriptContentRequestSchema.safeParse({ generation: 'g', rowId: 'row', offset: 0.5 }).success).toBe(false);
    expect(transcriptContentPageSchema.safeParse({ text: 'x'.repeat(TRANSCRIPT_CONTENT_CHARACTERS), offset: 0, nextOffset: null, totalCharacters: TRANSCRIPT_CONTENT_CHARACTERS }).success).toBe(true);
    expect(transcriptContentPageSchema.safeParse({ text: 'x'.repeat(TRANSCRIPT_CONTENT_CHARACTERS + 1), offset: 0, nextOffset: null, totalCharacters: TRANSCRIPT_CONTENT_CHARACTERS + 1 }).success).toBe(false);
    expect(transcriptPageSchema.safeParse({ generation: 'g', revision: 0, rows: [], hasBefore: false, hasAfter: false, total: 0 }).success).toBe(true);
  });

  it('rejects pages exceeding either the row-count or aggregate-byte limit', () => {
    const makePage = (rows: TranscriptRow[]) => ({ generation: 'g', revision: 1, rows, hasBefore: false, hasAfter: false, total: rows.length });
    const tiny = rowFor({ id: 'tiny', type: 'thinking', text: 'Short' });
    expect(transcriptPageSchema.safeParse(makePage(Array.from({ length: TRANSCRIPT_PAGE_ROWS + 1 }, () => tiny))).success).toBe(false);
    const large = rowFor({ id: 'large', type: 'thinking', text: 'x'.repeat(20_000) });
    const rows = Array.from({ length: TRANSCRIPT_PAGE_ROWS }, () => large);
    expect(new TextEncoder().encode(JSON.stringify(rows)).byteLength).toBeGreaterThan(TRANSCRIPT_PAGE_BYTES);
    expect(transcriptPageSchema.safeParse(makePage(rows)).success).toBe(false);
  });

  it('groups only supplied rows when a page begins halfway through a turn', () => {
    const message = rowFor({ id: 'middle-message', type: 'message', role: 'assistant', text: 'Middle of the turn' });
    const sideAgent = rowFor({ id: 'side', type: 'side-agent', agentId: 'scout', label: 'Scout', status: 'done' });
    const user = { ...rowFor({ id: 'next-user', type: 'message', role: 'user', text: 'Next turn' }), turnId: 'next-turn' };
    expect(transcriptRowsToTurns([message, sideAgent, user])).toEqual([
      { id: 'turn', type: 'turn', status: 'done', items: [message.item], sideAgents: [sideAgent.item] },
      { id: 'next-turn', type: 'turn', status: 'done', user: user.item, items: [], sideAgents: [] },
    ]);
  });
});
