import { describe, expect, it } from 'bun:test';
import {
  HostUIBridgeState,
  type HostUIBridgeEmitter,
  type HostUIDialogRequest,
} from '../host-ui-bridge.js';
import type { OmpAskFormAnswer, OmpAskFormQuestion } from '../omp-types.js';

function makeCapturingEmitter(): { emitter: HostUIBridgeEmitter; requests: HostUIDialogRequest[] } {
  const requests: HostUIDialogRequest[] = [];
  const emitter: HostUIBridgeEmitter = {
    emitDialogRequest: (request) => requests.push(request),
    emitEvent: () => {},
  };
  return { emitter, requests };
}

const QUESTIONS: OmpAskFormQuestion[] = [
  {
    id: 'color',
    question: 'Pick a color',
    options: [{ label: 'red' }, { label: 'green' }, { label: 'blue' }],
    multiple: false,
  },
  {
    id: 'sizes',
    question: 'Pick sizes',
    options: [{ label: 'small' }, { label: 'large' }],
    multiple: true,
  },
];

describe('HostUIBridgeState askForm round-trip', () => {
  it('emits one ask-form request and resolves with all answers', async () => {
    const bridge = new HostUIBridgeState();
    const { emitter, requests } = makeCapturingEmitter();
    const ctx = bridge.createContextForSession('sess-1', emitter);

    const pending = ctx.askForm('Agent questions', QUESTIONS);

    // A single ask-form request is emitted carrying every question.
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.type).toBe('ask-form');
    if (request.type !== 'ask-form') throw new Error('expected ask-form request');
    expect(request.sessionId).toBe('sess-1');
    expect(request.title).toBe('Agent questions');
    expect(request.questions).toEqual(QUESTIONS);

    // The client answers all questions in one submit.
    const answers: OmpAskFormAnswer[] = [
      { id: 'color', selectedOptions: ['green'] },
      { id: 'sizes', selectedOptions: ['small', 'large'] },
    ];
    const resolved = bridge.resolveDialog({ type: 'ask-form', id: request.id, value: answers });
    expect(resolved).toBe(true);

    await expect(pending).resolves.toEqual(answers);
  });

  it('resolves undefined when the form is cancelled', async () => {
    const bridge = new HostUIBridgeState();
    const { emitter, requests } = makeCapturingEmitter();
    const ctx = bridge.createContextForSession('sess-2', emitter);

    const pending = ctx.askForm('Agent questions', QUESTIONS);
    const request = requests[0]!;

    expect(bridge.resolveDialog({ type: 'ask-form', id: request.id, value: undefined })).toBe(true);
    await expect(pending).resolves.toBeUndefined();
  });

  it('preserves free-text customInput answers through the round-trip', async () => {
    const bridge = new HostUIBridgeState();
    const { emitter, requests } = makeCapturingEmitter();
    const ctx = bridge.createContextForSession('sess-3', emitter);

    const pending = ctx.askForm('Agent questions', QUESTIONS);
    const request = requests[0]!;

    const answers: OmpAskFormAnswer[] = [
      { id: 'color', selectedOptions: [], customInput: 'chartreuse' },
      { id: 'sizes', selectedOptions: ['small'] },
    ];
    bridge.resolveDialog({ type: 'ask-form', id: request.id, value: answers });
    await expect(pending).resolves.toEqual(answers);
  });

  it('rejects a response whose type does not match the pending ask-form', async () => {
    const bridge = new HostUIBridgeState();
    const { emitter, requests } = makeCapturingEmitter();
    const ctx = bridge.createContextForSession('sess-4', emitter);

    const pending = ctx.askForm('Agent questions', QUESTIONS);
    const request = requests[0]!;

    // A mismatched dialog type must not resolve the ask-form promise.
    expect(bridge.resolveDialog({ type: 'select', id: request.id, value: 'red' })).toBe(false);
    await expect(pending).rejects.toThrow(/type mismatch/i);
  });

  it('rejects a malformed ask-form value payload', async () => {
    const bridge = new HostUIBridgeState();
    const { emitter, requests } = makeCapturingEmitter();
    const ctx = bridge.createContextForSession('sess-5', emitter);

    const pending = ctx.askForm('Agent questions', QUESTIONS);
    const request = requests[0]!;

    // selectedOptions missing → invalid payload, rejected before resolving.
    const bad = [{ id: 'color' }] as unknown as OmpAskFormAnswer[];
    expect(bridge.resolveDialog({ type: 'ask-form', id: request.id, value: bad })).toBe(false);
    await expect(pending).rejects.toThrow(/value mismatch/i);
  });
});
