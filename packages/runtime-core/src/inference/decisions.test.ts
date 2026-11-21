import { describe, expect, it } from 'vitest';
import { createModels, createProvider, fauxAssistantMessage, fauxProvider, type ClassifierContext, type ClassifierModel, type ClassifierResult } from '@earendil-works/pi-ai';
import { runProfileDecision, type CloudflareDecisions } from './helpers';

const cost = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
const jev: ClassifierModel<string> = {
  id: 'jev-latest', name: 'Jev', provider: 'typesafe', api: 'test-classify', baseUrl: 'https://typesafe.invalid',
  input: ['text'], cost, type: 'classifier', contextWindow: 8192,
};
const questions = {
  risky: { type: 'bool', instructions: 'Could this break sign-in?' },
  size: { type: 'choice', instructions: 'How large is it?', criteria: { small: 'A few lines', large: null } },
  quality: { type: 'score', instructions: 'How good is it?', criteria: ['poor', 'fair', 'good'] },
};
/** A classifier's answers to `questions`: score is asked as a choice of level indexes. */
function answered(model: string, context: ClassifierContext): ClassifierResult {
  expect(Object.keys(context.questions)).toEqual(['risky', 'size', 'quality']);
  return {
    api: 'test-classify', provider: model.split('/')[0]!, model, stopReason: 'stop', timestamp: 0,
    answers: {
      risky: { type: 'bool', probability: 0.8 },
      size: { type: 'choice', choice: 'small', probabilities: { small: 0.75, large: 0.25 }, confidence: 0.9 },
      quality: { type: 'choice', choice: '2', probabilities: { 0: 0, 1: 0.5, 2: 0.5 }, confidence: 0.6 },
    },
    usage: { input: 120, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0.0001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 } },
  };
}
const classifierAnswers = {
  risky: { bool: 0.8 },
  size: { choice: 'small', probabilities: { small: 0.75, large: 0.25 }, confidence: 0.9 },
  quality: { score: 1.5, probabilities: { 0: 0, 1: 0.5, 2: 0.5 }, confidence: 0.6 },
};
const fastAnswers = {
  risky: { bool: 0.1 },
  size: { choice: 'large', probabilities: { small: 0, large: 1 }, confidence: 0.5 },
  quality: { score: 0, probabilities: { 0: 1, 1: 0, 2: 0 }, confidence: 0.5 },
};

/** A profile with a `fast` chat model (faux) and TypeSafe's Jev on its own credential; `classify` answers Jev. */
function fixture(classify: (context: ClassifierContext) => ClassifierResult) {
  const chat = fauxProvider({ provider: 'faux', models: [{ id: 'fast-chat' }] });
  chat.setResponses([fauxAssistantMessage(JSON.stringify(fastAnswers))]);
  const classified: ClassifierContext[] = [];
  const models = createModels();
  models.setProvider(chat.provider);
  models.setProvider(createProvider({
    id: 'typesafe', auth: { apiKey: { name: 'Test', resolve: async () => ({ auth: {} }) } }, models: [jev],
    classifiers: { 'test-classify': { classify: async (_model, context) => { classified.push(context); return classify(context); } } },
  }));
  const cloudflared: string[] = [];
  const cloudflare: CloudflareDecisions = async (option, context) => { cloudflared.push(option); return answered(`cloudflare/${option}`, context); };
  const settings = (decisions?: string) => ({ modelRoles: { default: 'faux/fast-chat', fast: 'faux/fast-chat' }, ...(decisions === undefined ? {} : { decisions }) });
  return { models, chat, classified, cloudflare, cloudflared, settings };
}

describe('a profile decision', () => {
  it('is answered by the selected decision model of the profile, named with its usage', async () => {
    const { models, chat, classified, cloudflare, cloudflared, settings } = fixture(context => answered('typesafe/jev-latest', context));
    const decision = await runProfileDecision(models, { state: { title: 'Fix login' }, questions }, { settings: settings('typesafe/jev-latest'), cloudflare });
    expect(decision).toEqual({ answers: classifierAnswers, model: 'typesafe/jev-latest', usage: { input: 120, output: 0, costUsd: 0.0001 }, fallback: null });
    expect(classified[0]?.state).toEqual({ title: 'Fix login' });
    expect(classified[0]?.questions.risky).toEqual({ type: 'bool', instructions: 'Could this break sign-in?', criteria: { true: 'Yes', false: 'No' } });
    expect(cloudflared).toEqual([]);
    expect(chat.state.callCount).toBe(0);
  });

  it('runs on Cloudflare by default, a text state wrapped as an object', async () => {
    const { models, chat, classified, cloudflare, cloudflared, settings } = fixture(context => answered('typesafe/jev-latest', context));
    const decision = await runProfileDecision(models, { state: 'Fix login', questions }, { settings: settings(), cloudflare });
    expect(decision).toMatchObject({ answers: classifierAnswers, model: 'cloudflare/clef-flash', fallback: null });
    expect(cloudflared).toEqual(['clef-flash']);
    expect(classified).toEqual([]);
    expect(chat.state.callCount).toBe(0);
  });

  it('is answered by the fast model when Decisions is off', async () => {
    const { models, chat, classified, cloudflare, cloudflared, settings } = fixture(context => answered('typesafe/jev-latest', context));
    const decision = await runProfileDecision(models, { state: 'Fix login', questions }, { settings: settings('off'), cloudflare });
    expect(decision).toMatchObject({ answers: fastAnswers, model: 'faux/fast-chat', fallback: 'Decisions is off' });
    expect(decision.usage).not.toBeNull();
    expect(classified).toEqual([]);
    expect(cloudflared).toEqual([]);
    expect(chat.state.callCount).toBe(1);
  });

  it('falls back to the fast model when the decision model fails, saying why', async () => {
    const { models, chat, cloudflare, settings } = fixture(() => ({ api: 'test-classify', provider: 'typesafe', model: 'jev-latest', answers: {}, stopReason: 'error', errorMessage: 'TypeSafe error: overloaded', timestamp: 0 }));
    const decision = await runProfileDecision(models, { state: 'Fix login', questions }, { settings: settings('typesafe/jev-latest'), cloudflare });
    expect(decision).toMatchObject({ answers: fastAnswers, model: 'faux/fast-chat', fallback: 'typesafe/jev-latest: TypeSafe error: overloaded' });
    expect(chat.state.callCount).toBe(1);
  });

  it('falls back to the fast model when no credential of the profile reaches the selected model', async () => {
    const { models, chat, classified, cloudflare, settings } = fixture(context => answered('typesafe/jev-latest', context));
    const decision = await runProfileDecision(models, { state: 'Fix login', questions }, { settings: settings('openai/gpt-6-luna'), cloudflare });
    expect(decision).toMatchObject({ model: 'faux/fast-chat', fallback: 'openai/gpt-6-luna: no credential of this profile can use that model' });
    expect(classified).toEqual([]);
    expect(chat.state.callCount).toBe(1);
  });
});
