// @vitest-environment happy-dom
import type { RuntimeQuestion } from '@gitspace/protocol-runtime';
import type { StagedAnswer } from '@gitspace/protocol-runtime/comments';
import type { RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { blockAskQuestionId } from '@gitspace/protocol/gitspace-ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionCardsContext, type QuestionCards } from '../QuestionCards.js';
import { SpeechContext, type Speech, type SpeechClip } from '../speech.js';
import { ComposerStagingProvider } from '../chat/staging.js';
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
    expect(player().dataset.sequenceVoice).toBe('timing');
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

  it('plays a StateFlow frame\'s steps while the frame plays, and holds its step when paused', async () => {
    const flow = { type: 'StateFlow', props: { services: [{ id: 'w', name: 'Worker' }, { id: 'c', name: 'Cache' }], steps: [{ from: 'w', to: 'c', label: 'get(key)', caption: '1. The worker asks the cache.' }, { from: 'c', to: 'w', label: 'hit', caption: '2. The cache answers.' }] }, children: [] };
    await act(async () => root.render(<UiBlock spec={walkthrough([{ content: flow, say: 'Reads go to the cache.', hold: 8 }, { content: text('Done'), say: 'Done.' }])} />));
    // A still frame waits for its play.
    await advance(3_000);
    expect(player().textContent).toContain('Press play to walk through it.');
    await press('Play The walk');
    await advance(300);
    expect(player().textContent).toContain('1. The worker asks the cache.');
    // The player's own Pause and Play, after the StateFlow's in the page.
    const control = (label: string): HTMLButtonElement => {
      const found = [...player().querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)].at(-1);
      if (!found) throw new Error(`no button "${label}"`);
      return found;
    };
    await act(async () => control('Pause').click());
    expect(player().dataset.sequencePlaying).toBe('false');
    await advance(3_000);
    expect(player().textContent).toContain('1. The worker asks the cache.');
    await act(async () => control('Play').click());
    await advance(2_300);
    expect(player().textContent).toContain('2. The cache answers.');
  });

  it('draws a frame { ref } as the element of the document with that id', async () => {
    const spec = { root: 'page', elements: { page: { type: 'Stack', props: {}, children: ['note', 'walk'] }, note: { ...text('The shared note'), id: 'note' }, walk: { type: 'Sequence', props: { title: 'The walk', frames: [{ content: text('Start') }, { content: { ref: 'note' } }] }, children: [] } }, state: {} };
    await act(async () => root.render(<UiBlock spec={spec} />));
    await press('Frame 2: note');
    expect(player().textContent).toContain('The shared note');
    expect(player().textContent).not.toContain('could not be drawn');
  });
});

/** An audio element whose playback the test drives: `play()` answers with `playResult`, and the test ends it. */
class FakeAudio {
  static made: FakeAudio[] = [];
  static playResult: () => Promise<void> = () => Promise.resolve();
  playbackRate = 1;
  duration = 6;
  paused = true;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly src: string) { FakeAudio.made.push(this); }
  play(): Promise<void> { this.paused = false; return FakeAudio.playResult(); }
  pause(): void { this.paused = true; }
}

describe('Sequence player with a voice', () => {
  const frames = [{ content: text('First'), say: 'One.' }, { content: text('Second'), say: 'Two.' }, { content: text('Third'), say: 'Three.' }];
  let asked: string[];
  let prepared: string[][];
  beforeEach(() => {
    asked = [];
    prepared = [];
    FakeAudio.made = [];
    FakeAudio.playResult = () => Promise.resolve();
    vi.stubGlobal('Audio', FakeAudio);
  });

  async function play(clip: (text: string) => Promise<SpeechClip | null>): Promise<void> {
    const speech: Speech = {
      voice: { id: 'model:athena', label: 'Athena' }, voices: [{ id: 'model:athena', label: 'Athena' }], setBrowserVoice: () => undefined,
      clip: (line) => { asked.push(line); return clip(line); },
      prepare: (texts) => { prepared.push([...texts]); },
    };
    await act(async () => root.render(<SpeechContext.Provider value={speech}><UiBlock spec={walkthrough(frames)} /></SpeechContext.Provider>));
    await press('Play The walk');
  }
  function voiceOff(): string | null {
    return player().querySelector('[data-sequence-voice-off]')?.textContent ?? null;
  }

  it('speaks each frame\'s clip, moves on at the clip\'s end, and makes every later frame\'s clip while one plays', async () => {
    await play(async (line) => ({ url: `/clips/${line}`, durationMs: 6000 }));
    expect(FakeAudio.made.map((audio) => audio.src)).toEqual(['/clips/One.']);
    expect(asked).toEqual(['One.']);
    expect(prepared).toEqual([['Two.', 'Three.']]);
    expect(player().dataset.sequenceVoice).toBe('speech');
    // The clip is still playing: the frame stays.
    await advance(7_000);
    expect(player().dataset.sequenceFrame).toBe('0');
    await act(async () => { FakeAudio.made[0]?.onended?.(); });
    await advance(500);
    expect(player().dataset.sequenceFrame).toBe('1');
    expect(FakeAudio.made.map((audio) => audio.src)).toEqual(['/clips/One.', '/clips/Two.']);
    expect(prepared).toEqual([['Two.', 'Three.'], ['Three.']]);
    expect(voiceOff()).toBeNull();
  });

  it('shows a clip that fails on timing, with a note that the voice is off for the frame, and moves on; paused, the note goes', async () => {
    await play(async () => { throw new Error('synthesis failed'); });
    expect(player().dataset.sequenceVoice).toBe('timing');
    expect(voiceOff()).toContain('Voice off for this frame: the clip did not load');
    expect(player().querySelector('[data-sequence-caption]')?.textContent).toContain('One.');
    await advance(4_500);
    expect(player().dataset.sequenceFrame).toBe('1');
    await press('Pause');
    await press('Frame 3: Three.');
    expect(voiceOff()).toBeNull();
  });

  it('shows a frame whose sound the browser refuses on timing, with the voice-off note, and moves on', async () => {
    FakeAudio.playResult = () => Promise.reject(new DOMException('play() failed because the user didn\'t interact with the document first.', 'NotAllowedError'));
    await play(async (line) => ({ url: `/clips/${line}`, durationMs: 6000 }));
    expect(FakeAudio.made).toHaveLength(1);
    expect(player().dataset.sequenceVoice).toBe('timing');
    expect(voiceOff()).toContain('Voice off for this frame: the browser blocked sound');
    await advance(4_500);
    expect(player().dataset.sequenceFrame).toBe('1');
    expect(player().dataset.sequencePlaying).toBe('true');
  });

  it('waits for a slow clip only so long, then shows the line on timing and moves on', async () => {
    await play(() => Promise.withResolvers<SpeechClip | null>().promise);
    expect(player().textContent).toContain('Preparing the voice');
    await advance(9_900);
    expect(player().dataset.sequenceFrame).toBe('0');
    await advance(200);
    expect(voiceOff()).toContain('Voice off for this frame: the clip was not ready in time');
    await advance(2_000);
    expect(player().dataset.sequenceFrame).toBe('1');
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

  async function draw(questions: readonly RuntimeQuestion[], request: (command: RuntimeSessionCommand) => Promise<RuntimeSessionResult>, staged: string[], answers: readonly StagedAnswer[] = []): Promise<void> {
    const cards: QuestionCards = { questions, request, answer: async () => { throw new Error('no answer expected'); }, watch: () => null };
    await act(async () => root.render(<QuestionCardsContext.Provider value={cards}><ComposerStagingProvider answers={answers}>
      <BlockActionsProvider actions={{ answer_question: (params) => { staged.push(params.label); } }}>
        <MessageBlockDocument messageId="message-1" text="" pending={false}><UiBlock spec={card} /></MessageBlockDocument>
      </BlockActionsProvider>
    </ComposerStagingProvider></QuestionCardsContext.Provider>));
  }
  function option(label: string): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>('button, [role="radio"], [role="option"]')].find((element) => element.textContent?.includes(label));
    if (!found) throw new Error(`no option; the page reads: ${container.textContent ?? ''}`);
    return found;
  }

  it('stages an answer to its open workspace question when the person picks a choice: no answer command, and the card stays whole and changeable', async () => {
    const commands: RuntimeSessionCommand[] = [];
    const staged: string[] = [];
    const respond = async (command: RuntimeSessionCommand): Promise<RuntimeSessionResult> => { commands.push(command); return Promise.withResolvers<RuntimeSessionResult>().promise; };
    await draw([question(null)], respond, staged);
    expect(container.querySelector('[data-block-ask="open"]')?.textContent).toContain('Needs your answer');
    expect(container.textContent).toContain('Your answer goes with your next message.');
    expect(container.textContent).not.toContain('Picking an answer');
    await act(async () => { option('Ship it').click(); });
    await advance(50);
    const id = blockAskQuestionId('message-1', 'ship');
    expect(commands).toEqual([{ type: 'stageAnswer', questionId: id, answer: [{ id: 'ship', selectedOptions: ['Ship it'], customInput: null }] }]);
    expect(staged).toEqual([]);
    // Staged: the question still waits, the whole card stays with the pick marked, and another pick replaces it.
    await draw([question(null)], respond, staged, [{ questionId: id, answer: [{ id: 'ship', selectedOptions: ['Ship it'], customInput: null }], stagedAt: '2026-11-16T10:00:00.000Z', deviceId: 'browser' }]);
    expect(container.querySelector('[data-block-ask="staged"]')?.textContent).toContain('Answer in your message');
    expect(container.textContent).toContain('staged · in your message');
    expect(option('Ship it').getAttribute('aria-checked')).toBe('true');
    expect(option('Hold it').getAttribute('aria-checked')).toBe('false');
    await act(async () => { option('Hold it').click(); });
    await advance(50);
    expect(commands.at(-1)).toEqual({ type: 'stageAnswer', questionId: id, answer: [{ id: 'ship', selectedOptions: ['Hold it'], customInput: null }] });
  });

  it('once answered is locked: the question, the chosen option checked and the other struck through, with no flag', async () => {
    await draw([question([{ selectedOptions: ['Hold it'], customInput: null }])], async () => { throw new Error('no command expected'); }, []);
    await advance(50);
    expect(container.querySelector('[data-block-ask]')).toBeNull();
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Ship the cache?, Answered');
    const rows = [...container.querySelectorAll('section li')];
    expect(rows.find((row) => row.textContent === 'Hold it')?.querySelector('[aria-label="Chosen"]')).not.toBeNull();
    expect(rows.find((row) => row.textContent === 'Ship it')?.className).toContain('line-through');
    expect(container.querySelectorAll('[role="radio"], [role="option"]')).toHaveLength(0);
  });

  it('stages the choice in the message bar, and says so, while the workspace has no question for it', async () => {
    const staged: string[] = [];
    await draw([], async () => { throw new Error('no command expected'); }, staged);
    expect(container.textContent).toContain('Your answer goes with your next message.');
    await act(async () => { option('Hold it').click(); });
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
