import { describe, expect, it } from 'bun:test';
import { coalesceTransportEvents, reduceTranscriptToTurns } from '../src/index.js';

describe('reduceTranscriptToTurns', () => {
  it('groups one main-agent turn and nests completed side agents', () => {
    const turns = reduceTranscriptToTurns([
      { sessionId: 's1', ordinal: 1, kind: 'turn_start', payload: {} },
      { sessionId: 's1', ordinal: 2, kind: 'message_end', payload: { message: { role: 'user', content: [{ type: 'text', text: 'Review this' }] } } },
      { sessionId: 's1', ordinal: 3, kind: 'message_end', payload: { message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'I should delegate.' },
        { type: 'toolCall', id: 'task-1', name: 'task', arguments: { tasks: [{ task: 'review' }] } },
      ] } } },
      { sessionId: 's1', ordinal: 4, kind: 'message_end', payload: { message: {
        role: 'toolResult', toolCallId: 'task-1', toolName: 'task', content: [{ type: 'text', text: '1 task completed' }], details: {
          results: [{ id: 'reviewer', agent: 'reviewer', description: 'Review', exitCode: 0, output: 'No defects.' }],
        },
      } } },
      { sessionId: 's1', ordinal: 5, kind: 'message_end', payload: {
        message: { role: 'assistant', content: [{ type: 'text', text: 'Looks good.' }] },
      } },
      { sessionId: 's1', ordinal: 6, kind: 'turn_end', payload: {} },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ status: 'done', user: { text: 'Review this' } });
    expect(turns[0]?.items.map((item) => item.type)).toEqual(['thinking', 'tool-call', 'message']);
    expect(turns[0]?.sideAgents).toEqual([
      expect.objectContaining({ agentId: 'reviewer', status: 'done', summary: 'No defects.' }),
    ]);
  });

  it('projects supported user images into persisted message attachments', () => {
    const turns = reduceTranscriptToTurns([
      { sessionId: 's1', ordinal: 1, kind: 'message_end', payload: { message: { role: 'user', content: [
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
        { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
      ] } } },
    ]);

    expect(turns[0]?.user).toEqual(expect.objectContaining({
      text: '',
      images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }],
    }));
  });

  it('projects supported tool-result images into expanded tool details', () => {
    const turns = reduceTranscriptToTurns([
      { sessionId: 's1', ordinal: 1, kind: 'turn_start', payload: {} },
      { sessionId: 's1', ordinal: 2, kind: 'message_end', payload: { message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'screenshot.png' } },
      ] } } },
      { sessionId: 's1', ordinal: 3, kind: 'message_end', payload: { message: {
        role: 'toolResult',
        toolCallId: 'read-1',
        toolName: 'read',
        content: [
          { type: 'text', text: 'Opened screenshot.png' },
          { type: 'image', mimeType: 'image/webp', data: 'aW1hZ2U=' },
        ],
      } } },
    ]);

    expect(turns[0]?.items[0]).toMatchObject({
      type: 'tool-call',
      result: [
        { type: 'code', text: 'Opened screenshot.png' },
        { type: 'image', url: 'data:image/webp;base64,aW1hZ2U=', alt: 'Tool output image 1' },
      ],
    });
  });

  it('splits a rehydrated transcript without turn markers at each user message', () => {
    const turns = reduceTranscriptToTurns([
      { sessionId: 's1', ordinal: 1, kind: 'message_end', payload: { message: { role: 'user', content: [{ type: 'text', text: 'first' }] } } },
      { sessionId: 's1', ordinal: 2, kind: 'message_end', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'one' }] } } },
      { sessionId: 's1', ordinal: 3, kind: 'message_end', payload: { message: { role: 'user', content: [{ type: 'text', text: 'second' }] } } },
      { sessionId: 's1', ordinal: 4, kind: 'message_end', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'two' }] } } },
      { sessionId: 's1', ordinal: 5, kind: 'turn_start', payload: {} },
      { sessionId: 's1', ordinal: 6, kind: 'message_end', payload: { message: { role: 'user', content: [{ type: 'text', text: 'third' }] } } },
      { sessionId: 's1', ordinal: 7, kind: 'message_end', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'three' }] } } },
      { sessionId: 's1', ordinal: 8, kind: 'turn_end', payload: {} },
    ]);
    expect(turns.map((turn) => [turn.user?.text, turn.status, ...turn.items.map((item) => item.type === 'message' ? item.text : item.type)])).toEqual([
      ['first', 'done', 'one'],
      ['second', 'done', 'two'],
      ['third', 'done', 'three'],
    ]);
  });

  it('coalesces message updates into the final stable message block', () => {
    const turns = reduceTranscriptToTurns([
      { sessionId: 's1', ordinal: 1, kind: 'turn_start', payload: {} },
      { sessionId: 's1', ordinal: 2, kind: 'message_update', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'hel' }] } } },
      { sessionId: 's1', ordinal: 3, kind: 'message_update', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } } },
      { sessionId: 's1', ordinal: 4, kind: 'message_end', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } } },
      { sessionId: 's1', ordinal: 5, kind: 'turn_end', payload: {} },
    ]);
    expect(turns[0]?.items).toEqual([expect.objectContaining({ type: 'message', text: 'hello' })]);
  });

  it('projects live assistant text and partial tool output before turn completion', () => {
    const turns = reduceTranscriptToTurns([
      { sessionId: 's1', ordinal: 1, kind: 'turn_start', payload: {} },
      { sessionId: 's1', ordinal: 2, kind: 'message_update', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'Streaming **Markdown**' }] } } },
      { sessionId: 's1', ordinal: 3, kind: 'tool_execution_start', payload: { toolCallId: 'read-1', toolName: 'read', args: { path: 'README.md' } } },
      { sessionId: 's1', ordinal: 4, kind: 'tool_execution_update', payload: { toolCallId: 'read-1', partialResult: '# Partial result' } },
    ]);
    expect(turns[0]?.status).toBe('running');
    expect(turns[0]?.items[0]).toMatchObject({ type: 'message', text: 'Streaming **Markdown**', pending: true });
    expect(turns[0]?.items[1]).toMatchObject({
      type: 'tool-call',
      status: 'running',
      result: [expect.objectContaining({ text: '# Partial result' })],
    });
  });
  it('projects ask tool calls as interactive question blocks', () => {
    const turns = reduceTranscriptToTurns([
      { sessionId: 's1', ordinal: 1, kind: 'turn_start', payload: {} },
      { sessionId: 's1', ordinal: 2, kind: 'tool_execution_start', payload: { toolCallId: 'ask-1', toolName: 'ask', args: { questions: [
        { id: 'runtime', header: 'Runtime', question: 'Choose a runtime', options: [{ label: 'Bun', description: 'Fast' }], recommended: 0 },
        { id: 'checks', question: 'Which checks?', options: [{ label: 'Types' }, { label: 'Browser' }], multi: true },
      ] } } },
    ]);
    expect(turns[0]?.status).toBe('running');
    expect(turns[0]?.items[0]).toEqual(expect.objectContaining({
      type: 'ask',
      toolCallId: 'ask-1',
      status: 'pending',
      questions: [
        { id: 'runtime', header: 'Runtime', prompt: 'Choose a runtime', options: [{ id: 'Bun', title: 'Bun', description: 'Fast' }], recommended: 0 },
        { id: 'checks', prompt: 'Which checks?', options: [{ id: 'Types', title: 'Types' }, { id: 'Browser', title: 'Browser' }], multiple: true },
      ],
    }));
  });

  it('retains submitted ask answers in the completed block', () => {
    const turns = reduceTranscriptToTurns([
      { sessionId: 's1', ordinal: 1, kind: 'turn_start', payload: {} },
      { sessionId: 's1', ordinal: 2, kind: 'tool_execution_start', payload: { toolCallId: 'ask-1', toolName: 'ask', args: { questions: [
        { id: 'runtime', question: 'Choose a runtime', options: [{ label: 'Bun' }] },
        { id: 'checks', question: 'Which checks?', options: [{ label: 'Types' }, { label: 'Browser' }], multi: true },
        { id: 'notes', question: 'Anything else?', options: [{ label: 'None' }] },
      ] } } },
      { sessionId: 's1', ordinal: 3, kind: 'message_end', payload: { message: { role: 'toolResult', toolCallId: 'ask-1', details: { results: [
        { id: 'runtime', selectedOptions: ['Bun'] },
        { id: 'checks', selectedOptions: ['Types', 'Browser'] },
        { id: 'notes', selectedOptions: [], customInput: 'Keep it compact' },
      ] }, content: [] } } },
    ]);
    expect(turns[0]?.items[0]).toEqual(expect.objectContaining({
      type: 'ask',
      status: 'answered',
      questions: [
        expect.objectContaining({ id: 'runtime', answer: 'Bun' }),
        expect.objectContaining({ id: 'checks', answer: ['Types', 'Browser'] }),
        expect.objectContaining({ id: 'notes', answer: 'Keep it compact' }),
      ],
    }));
  });

  it('retains the flat answer payload used by single-question asks', () => {
    const turns = reduceTranscriptToTurns([
      { sessionId: 's1', ordinal: 1, kind: 'turn_start', payload: {} },
      { sessionId: 's1', ordinal: 2, kind: 'tool_execution_start', payload: { toolCallId: 'ask-1', toolName: 'ask', args: { questions: [
        { id: 'choice', question: 'Choose A or B.', options: [{ label: 'A' }, { label: 'B' }] },
      ] } } },
      { sessionId: 's1', ordinal: 3, kind: 'message_end', payload: { message: {
        role: 'toolResult',
        toolCallId: 'ask-1',
        details: { question: 'Choose A or B.', options: ['A', 'B'], multi: false, selectedOptions: ['A'] },
        content: [{ type: 'text', text: 'User selected: A' }],
      } } },
    ]);
    expect(turns[0]?.items[0]).toEqual(expect.objectContaining({
      type: 'ask',
      status: 'answered',
      questions: [expect.objectContaining({ id: 'choice', answer: 'A' })],
    }));
  });


  it('tracks asynchronous task progress and completed hub results as subagents', () => {
    const turns = reduceTranscriptToTurns([
      { sessionId: 's1', ordinal: 1, kind: 'turn_start', payload: {} },
      { sessionId: 's1', ordinal: 2, kind: 'message_end', payload: { message: { role: 'assistant', content: [{ type: 'toolCall', id: 'task-1', name: 'task', arguments: { tasks: [{ task: 'inspect' }] } }] } } },
      { sessionId: 's1', ordinal: 3, kind: 'message_end', payload: { message: { role: 'toolResult', toolCallId: 'task-1', details: { progress: [{ id: 'Scout', agent: 'scout', modelRole: 'smol', status: 'pending', assignment: 'Inspect README' }] }, content: [] } } },
      { sessionId: 's1', ordinal: 4, kind: 'turn_end', payload: {} },
      { sessionId: 's1', ordinal: 5, kind: 'turn_start', payload: {} },
      { sessionId: 's1', ordinal: 6, kind: 'message_end', payload: { message: { role: 'assistant', content: [{ type: 'toolCall', id: 'hub-1', name: 'hub', arguments: { op: 'wait' } }] } } },
      { sessionId: 's1', ordinal: 7, kind: 'message_end', payload: { message: { role: 'toolResult', toolCallId: 'hub-1', details: { jobs: [{ id: 'Scout', label: 'Scout', status: 'completed', resolvedModel: 'openai/gpt-5', resultText: '<task-result id=\"Scout\" agent=\"scout\"><output>{\"summary\":\"# README\"}</output></task-result>' }] }, content: [] } } },
      { sessionId: 's1', ordinal: 8, kind: 'turn_end', payload: {} },
    ]);
    expect(turns[0]?.sideAgents[0]).toMatchObject({ agentId: 'Scout', agent: 'scout', model: 'smol', status: 'queued', summary: 'Inspect README' });
    expect(turns[1]?.sideAgents[0]).toMatchObject({ agentId: 'Scout', agent: 'scout', model: 'openai/gpt-5', status: 'done', summary: '# README' });
  });
});

describe('coalesceTransportEvents', () => {
  it('hides short reconnects and renders material replacement once', () => {
    const blocks = coalesceTransportEvents([
      { offset: 1, operation: 'connection-lost', entity: 'relay', entityId: 'a', payload: {}, createdAt: '2026-01-01T00:00:00.000Z' },
      { offset: 2, operation: 'connected', entity: 'relay', entityId: 'a', payload: {}, createdAt: '2026-01-01T00:00:00.800Z' },
      { offset: 3, operation: 'code-version', entity: 'machine-generation', entityId: 'sha256:abc', payload: { replacing: true } },
    ]);
    expect(blocks).toEqual([
      expect.objectContaining({ type: 'transport', status: 'replaced', title: 'Machine replaced', generation: 'sha256:abc' }),
    ]);
  });
});
