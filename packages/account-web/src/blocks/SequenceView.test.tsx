// @vitest-environment happy-dom
import type { RuntimeQuestion } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { blockAskQuestionId } from '@gitspace/protocol/gitspace-ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionCardsContext, type QuestionCards } from '../QuestionCards.js';
import { BlockActionsProvider } from './BlockActions.js';
import { MessageBlockDocument } from './BlockDocument.js';
import { UiBlock } from './UiBlock.js';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const text = (value: string): Record<string, unknown> => ({ type: 'Text', props: { text: value }, children: [] });

function walkthrough(frames: unknown[]): Record<string, unknown> {
  return { root: 'walk', elements: { walk: { type: 'Sequence', props: { title: 'The walk', frames }, children: [] } }, state: {} };
}

function player(): HTMLElement {
  const figure = container.querySelector<HTMLElement>('[aria-roledescription="walkthrough"]');
  if (!figure) throw new Error(`no player; the page reads: ${container.textContent ?? ''}`);
  return figure;
}

async function advance(ms: number): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(ms); });
}

async function press(label: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`no button "${label}"`);
  await act(async () => { button.click(); });
}

describe('Sequence player', () => {
  it('shows frame 1 as a still, then plays frame by frame on timing without speech and stops on the last frame', async () => {
    await act(async () => root.render(<UiBlock spec={walkthrough([{ content: text('First'), say: 'One.' }, { content: text('Second'), say: 'Two.', hold: 2 }, { content: text('Third'), say: 'Three.' }])} />));
    expect(player().dataset.sequencePlaying).toBe('false');
    await advance(20_000);
    expect(player().dataset.sequenceFrame).toBe('0');

    await press('Play The walk');
    expect(player().dataset.sequencePlaying).toBe('true');
    await advance(3_900);
    expect(player().dataset.sequenceFrame).toBe('0');
    // 4 s without a voice, then the gap between frames.
    await advance(600);
    expect(player().dataset.sequenceFrame).toBe('1');
    expect(container.textContent).toContain('Two.');
    // The second frame holds 2 s.
    await advance(2_500);
    expect(player().dataset.sequenceFrame).toBe('2');
    await advance(4_500);
    expect(player().dataset.sequenceFrame).toBe('2');
    expect(player().dataset.sequencePlaying).toBe('false');
    expect(player().dataset.sequenceVoice).toBe('timing');
  });

  it('shows the error card in the place of a frame that fails its checks, and plays on to the next frame', async () => {
    const broken = { type: 'Badge', props: { label: 'x', color: 'chartreuse' }, children: [] };
    await act(async () => root.render(<UiBlock spec={walkthrough([{ content: text('Opening'), say: 'Open.' }, { content: broken, say: 'Broken.' }, { content: text('Closing'), say: 'Close.' }])} />));
    expect(container.textContent).toContain('Opening');
    await press('Play The walk');
    await advance(4_500);
    expect(player().dataset.sequenceFrame).toBe('1');
    expect(player().textContent).toContain('This block could not be drawn');
    expect(player().textContent).toContain('/props/color');
    await advance(4_500);
    expect(player().dataset.sequenceFrame).toBe('2');
    expect(player().textContent).toContain('Closing');
    expect(player().textContent).not.toContain('could not be drawn');
  });

  it('draws a frame { ref } as the element of the document with that id', async () => {
    const spec = { root: 'page', elements: { page: { type: 'Stack', props: {}, children: ['note', 'walk'] }, note: { ...text('The shared note'), id: 'note' }, walk: { type: 'Sequence', props: { title: 'The walk', frames: [{ content: text('Start') }, { content: { ref: 'note' } }] }, children: [] } }, state: {} };
    await act(async () => root.render(<UiBlock spec={spec} />));
    await press('Frame 2: note');
    expect(player().textContent).toContain('The shared note');
    expect(player().textContent).not.toContain('could not be drawn');
  });
});

describe('a required ask in a stored message', () => {
  const card = {
    root: 'ship',
    state: { answer: '', options: [{ value: 'yes', label: 'Ship it' }, { value: 'no', label: 'Hold it' }] },
    elements: {
      ship: {
        type: 'AskCard', id: 'ship', ask: { required: true, prompt: 'Ship the cache today?' },
        props: { questionId: 'ship', question: 'Ship the cache?', prompt: 'Ship the cache?', options: { $state: '/options' }, value: { $bindState: '/answer' }, answered: { $state: '/answered' } },
        on: { answer: { action: 'answer_question', params: { questionId: 'ship', question: 'Ship the cache?', answer: { $state: '/answer' }, label: { $computed: 'lookup', args: { items: { $state: '/options' }, key: 'value', value: { $state: '/answer' }, field: 'label' } } } } },
        children: [],
      },
    },
  };
  const question = (answer: RuntimeQuestion['answer']): RuntimeQuestion => ({ id: blockAskQuestionId('message-1', 'ship'), conversationId: 'c1', kind: 'ask', prompt: 'Ship the cache today?', choices: ['Ship it', 'Hold it'], answer });

  async function draw(questions: readonly RuntimeQuestion[], request: (command: RuntimeSessionCommand) => Promise<RuntimeSessionResult>, staged: string[]): Promise<void> {
    const cards: QuestionCards = { questions, request, answer: async () => undefined, watch: () => null };
    await act(async () => root.render(<QuestionCardsContext.Provider value={cards}>
      <BlockActionsProvider actions={{ answer_question: (params) => { staged.push(params.label); } }}>
        <MessageBlockDocument messageId="message-1" text="" pending={false}><UiBlock spec={card} /></MessageBlockDocument>
      </BlockActionsProvider>
    </QuestionCardsContext.Provider>));
  }

  it('answers its open workspace question through the existing answer command when the person picks a choice', async () => {
    const commands: RuntimeSessionCommand[] = [];
    const staged: string[] = [];
    // The command stays in flight: what matters is the command the pick sends.
    await draw([question(null)], (command) => { commands.push(command); return Promise.withResolvers<RuntimeSessionResult>().promise; }, staged);
    expect(container.querySelector('[data-block-ask="open"]')?.textContent).toContain('Needs your answer');
    expect(container.textContent).toContain('Picking an answer answers the question');
    expect(container.textContent).not.toContain('message bar');
    const option = [...container.querySelectorAll<HTMLElement>('button, [role="radio"], [role="option"]')].find((element) => element.textContent?.includes('Ship it'));
    if (!option) throw new Error(`no option; the page reads: ${container.textContent ?? ''}`);
    await act(async () => { option.click(); });
    await advance(50);
    expect(commands).toEqual([{ type: 'answerAsk', id: blockAskQuestionId('message-1', 'ship'), answers: [{ id: 'ship', selectedOptions: ['Ship it'], customInput: null }] }]);
    expect(staged).toEqual([]);
  });

  it('shows an answered question answered, with no flag', async () => {
    await draw([question([{ selectedOptions: ['Hold it'], customInput: null }])], async () => { throw new Error('no command expected'); }, []);
    await advance(50);
    expect(container.querySelector('[data-block-ask]')).toBeNull();
    expect(container.textContent).toContain('Hold it');
    expect(container.textContent).toContain('answered · the agent continues');
  });

  it('stages the choice in the message bar, and says so, while the workspace has no question for it', async () => {
    const staged: string[] = [];
    await draw([], async () => { throw new Error('no command expected'); }, staged);
    expect(container.textContent).toContain('Picking an answer puts it in your message bar');
    const option = [...container.querySelectorAll<HTMLElement>('button, [role="radio"], [role="option"]')].find((element) => element.textContent?.includes('Hold it'));
    if (!option) throw new Error(`no option; the page reads: ${container.textContent ?? ''}`);
    await act(async () => { option.click(); });
    await advance(50);
    expect(staged).toEqual(['Hold it']);
  });

  it('once the person replied in chat instead, is locked: it says so, and no choice answers or stages', async () => {
    const staged: string[] = [];
    await draw([{ ...question(null), closed: { reason: 'replied', at: '2026-11-16T10:00:00.000Z' } }], async () => { throw new Error('no command expected'); }, staged);
    expect(container.querySelector('[data-block-ask="closed"]')?.textContent).toBe('You replied in chat');
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Ship the cache?, You replied in chat');
    expect(container.querySelectorAll('[role="radio"], [role="option"]')).toHaveLength(0);
    expect(container.querySelector('[inert]')?.textContent).toContain('Hold it');
    expect(container.textContent).not.toContain('Picking an answer');
  });
});
