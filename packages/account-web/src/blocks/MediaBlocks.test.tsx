// @vitest-environment happy-dom
import type { RuntimeBrowserCaptureView } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand, RuntimeSessionResult, SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QuestionCardsContext, type QuestionCards } from '../QuestionCards.js';
import { UiBlock } from './UiBlock.js';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const captureId = '00000000-0000-4000-8000-0000000000c1';
const image = { root: 'shot', elements: { shot: { type: 'Image', props: { src: `capture:${captureId}`, alt: 'Home' }, children: [] } }, state: {} };
const control: SessionControlView = { sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, history: [], historyAnchorId: null };

it('shows a capture’s current image in a later message after the capture was read for an earlier one', async () => {
  let views: RuntimeBrowserCaptureView[] = [];
  const request = vi.fn(async (command: RuntimeSessionCommand): Promise<RuntimeSessionResult> => {
    if (command.type !== 'browserCaptures') throw new Error(`unexpected ${command.type}`);
    return { control, browserCaptures: views };
  });
  const cards: QuestionCards = { questions: [], request, answer: async () => { throw new Error('no answer expected'); }, watch: () => null };
  const capture = (url: string): RuntimeBrowserCaptureView => ({
    capture: { version: 2, captureId, name: 'Home', by: 'agent', source: 'headless', browser: 'Cloud browser', page: { url: 'https://app.example.com', title: 'App' }, target: null, startedAt: '2026-11-18T12:00:00.000Z', endedAt: '2026-11-18T12:00:01.000Z', state: 'saved', reason: null, tracks: { image: { path: 'image.jpg', width: 1280, height: 800 } } },
    files: { 'image.jpg': url },
  });

  // The first message names the capture before it exists.
  await act(async () => root.render(<QuestionCardsContext.Provider value={cards}><UiBlock key="first" spec={image} /></QuestionCardsContext.Provider>));
  await act(async () => {});
  expect(container.textContent).toContain('no such capture in this workspace');

  views = [capture('/files/first')];
  await act(async () => root.render(<QuestionCardsContext.Provider value={cards}><UiBlock key="first" spec={image} /><UiBlock key="second" spec={image} /></QuestionCardsContext.Provider>));
  await act(async () => {});
  expect([...container.querySelectorAll('img[alt="Home"]')].map((element) => element.getAttribute('src'))).toEqual(['/files/first']);

  views = [capture('/files/second')];
  await act(async () => root.render(<QuestionCardsContext.Provider value={cards}><UiBlock key="first" spec={image} /><UiBlock key="second" spec={image} /><UiBlock key="third" spec={image} /></QuestionCardsContext.Provider>));
  await act(async () => {});
  expect([...container.querySelectorAll('img[alt="Home"]')].map((element) => element.getAttribute('src'))).toEqual(['/files/first', '/files/second']);
});
