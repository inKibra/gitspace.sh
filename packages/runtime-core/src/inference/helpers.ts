import type { ClassifierContext, ClassifierQuestion, ClassifierResult, ImageApi, ImageModel, Models, ModelTypeMap, JsonObject } from '@earendil-works/pi-ai';
import { BUILT_IN_MODEL_ROLES, DEFAULT_DECISIONS_SELECTOR, SERVICE_OFF, applyInferenceSettings, parseModelRoleSelector, parseServiceSelector, type ModelRoleSelector, type InferenceProfile } from '@gitspace/protocol/inference';
import { RuntimeDecideArgumentsSchema, RuntimeGenerateImageArgumentsSchema, RuntimeJsonSchema, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { Check } from 'typebox/schema';
import { z } from 'zod';
import { profileModelRoles, resolveAvailableProfileModel, resolveModelSelection, type ResolvedProfileModel } from './admission.js';

export type RuntimeJson = z.infer<typeof RuntimeJsonSchema>;
const jsonObject = z.record(z.string(), RuntimeJsonSchema);
const outputSchema = z.union([z.boolean(), jsonObject]);
const completionArgs = z.object({ prompt: z.string().min(1), model: z.string().min(1).optional(), system: z.string().optional(), schema: outputSchema.optional() }).strict();
type DecisionQuestions = z.infer<typeof RuntimeDecideArgumentsSchema>['questions'];
/** The Decisions service's `cloudflare/<option>` models (`CLOUDFLARE_DECISION_MODELS`), run on the platform's
 * Cloudflare account; the account worker answers them with its AI binding. */
export type CloudflareDecisions = (option: string, context: ClassifierContext, signal?: AbortSignal) => Promise<ClassifierResult>;
/** What a decision spent: tokens and cost at the model's catalog price. */
export type DecisionUsage = { input: number; output: number; costUsd: number };
/** A decision's answers by question id. `model` answered them: the profile's `decisions` selector, or the `fast` role's
 * `provider/model` when `fallback` says why the Decisions service did not. `usage` is null when the service reported none. */
export type ProfileDecision = { answers: RuntimeJson; model: string; usage: DecisionUsage | null; fallback: string | null };
const selectionSettings = z.object({ modelRoles: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(), enabledModels: z.array(z.string()).optional() });
function chooseModel<T extends ModelTypeMap[keyof ModelTypeMap]>(candidates: readonly T[], settings: InferenceProfile['settings'], selection: string | undefined, role: string | undefined): { model: T; thinking: ModelRoleSelector['thinking'] } | undefined {
  const config = selectionSettings.parse(applyInferenceSettings({}, settings));
  const matches = (pattern: string, model: T) => {
    const expression = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')}$`, 'iu');
    return expression.test(`${model.provider}/${model.id}`) || expression.test(model.id);
  };
  const admitted = candidates.filter(model => !config.enabledModels?.length || config.enabledModels.some(pattern => matches(pattern, model)));
  const visited = new Set<string>();
  const resolve = (value: string | string[]): { model: T; thinking: ModelRoleSelector['thinking'] } | undefined => {
    for (const valueSelector of typeof value === 'string' ? [value] : value) {
      const { selector: pattern, thinking } = parseModelRoleSelector(valueSelector);
      const alias = pattern.startsWith('pi/') ? pattern.slice(3) : pattern.startsWith('@') ? pattern.slice(1) : config.modelRoles?.[pattern] !== undefined ? pattern : undefined;
      if (alias !== undefined) {
        if (visited.has(alias)) throw new Error(`Circular inference model role: ${alias}`);
        visited.add(alias);
        const configured = config.modelRoles?.[alias];
        const selected = configured ? resolve(configured) : undefined;
        visited.delete(alias);
        if (selected) return thinking === null ? selected : { ...selected, thinking };
      } else {
        const selected = admitted.find(model => matches(pattern, model));
        if (selected) return { model: selected, thinking };
      }
    }
    return undefined;
  };
  const configured = selection ?? (role === undefined ? undefined : config.modelRoles?.[role]);
  return configured === undefined ? admitted[0] ? { model: admitted[0], thinking: null } : undefined : resolve(configured);
}

async function chatModel(models: Models, settings: InferenceProfile['settings'], selection: string | undefined): Promise<ResolvedProfileModel> {
  if (selection === undefined) return resolveAvailableProfileModel(settings, models);
  if (BUILT_IN_MODEL_ROLES.some(role => role === selection) || profileModelRoles(settings).includes(selection)) return resolveModelSelection(settings, models, { kind: 'role', role: selection });
  const model = chooseModel(await models.getAvailable(), settings, selection, 'default');
  if (!model) throw new Error(`No authenticated admitted chat model matches ${selection}`);
  return model;
}
/** A helper's model request fails naming the model it asked, so its caller can tell which provider or account to fix. */
async function asking<T>(model: { provider: string; id: string }, request: Promise<T>): Promise<T> {
  try { return await request; }
  catch (error) { throw new Error(`${model.provider}/${model.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}
async function completeText(models: Models, selected: ResolvedProfileModel, prompt: string, system: string | undefined, signal: AbortSignal | undefined): Promise<{ text: string; usage: DecisionUsage }> {
  const message = await models.completeSimple(selected.model, { systemPrompt: system, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] }, { signal, ...(selected.thinking === null || selected.thinking === 'off' ? {} : { reasoning: selected.thinking }) });
  if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage ?? `Model request ${message.stopReason}`);
  if (message.stopReason !== 'stop') throw new Error(`Model helper returned an incomplete response (${message.stopReason})`);
  return { text: message.content.filter(part => part.type === 'text').map(part => part.text).join(''), usage: { input: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite, output: message.usage.output, costUsd: message.usage.cost.total } };
}
function parseStructured(text: string, schema: z.infer<typeof outputSchema>): RuntimeJson {
  const json = RuntimeJsonSchema.parse(JSON.parse(text));
  if (!Check(schema, json)) throw new Error('Model response did not match the requested JSON schema');
  return json;
}

function validateJudgments(value: RuntimeJson, questions: DecisionQuestions): RuntimeJson {
  const answers = jsonObject.parse(value);
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'bool') continue;
    const answer = z.object({ probabilities: z.record(z.string(), z.number()), score: z.number().optional() }).parse(answers[id]);
    const total = Object.values(answer.probabilities).reduce((sum, probability) => sum + probability, 0);
    if (Math.abs(total - 1) > 0.001) throw new Error(`Judgment ${id} probabilities do not sum to one`);
    if (question.type === 'score') {
      const expected = Object.entries(answer.probabilities).reduce((sum, [index, probability]) => sum + Number(index) * probability, 0);
      if (answer.score === undefined || Math.abs(answer.score - expected) > 0.001) throw new Error(`Judgment ${id} score is not its probability-weighted criterion index`);
    }
  }
  return value;
}

/** The profile's image model `selection` names (a `provider/model` or a pattern), or its first admitted one when
 * `selection` is undefined; undefined when none matches. */
export async function chooseProfileImageModel(models: Models, settings: InferenceProfile['settings'], selection: string | undefined, signal?: AbortSignal): Promise<ImageModel<ImageApi> | undefined> {
  return chooseModel(await models.getAvailableOfType('image', undefined, { signal }), settings, selection, undefined)?.model;
}

/** Only the caller's admitted registry supplies authentication and transport. */
export async function generateProfileImage(models: Models, model: ImageModel<ImageApi>, args: unknown, signal?: AbortSignal): Promise<RuntimeToolResult['content']> {
  const input = RuntimeGenerateImageArgumentsSchema.parse(args);
  const result = await models.generateImages(model, { input: [{ type: 'text', text: input.prompt }, ...(input.images ?? [])] }, { signal });
  if (result.stopReason !== 'stop') throw new Error(result.errorMessage ?? `Image generation ${result.stopReason}`);
  if (!result.output.some(part => part.type === 'image')) throw new Error('Image provider returned no image');
  return result.output;
}

/** Completion returns text, or JSON validated against `schema`. */
export async function runProfileCompletion(models: Models, args: unknown, signal?: AbortSignal, settings: InferenceProfile['settings'] = {}): Promise<RuntimeJson> {
  const input = completionArgs.parse(args);
  const model = await chatModel(models, settings, input.model);
  const system = input.schema === undefined ? input.system : `${input.system ?? ''}\nReturn only JSON matching this JSON Schema, with no markdown or explanation:\n${JSON.stringify(input.schema)}`;
  const { text } = await asking(model.model, completeText(models, model, input.prompt, system, signal));
  return input.schema === undefined ? text : parseStructured(text, input.schema);
}

/** A classifier's answers in the answer shape: `bool` the probability of true, `choice` the choice with its probabilities,
 * `score` asked as a choice of level indexes, its score the probability-weighted index. */
function classifierAnswers(result: ClassifierResult, questions: DecisionQuestions, schema: z.infer<typeof jsonObject>): RuntimeJson {
  const answers: JsonObject = {};
  for (const [id, answer] of Object.entries(result.answers)) {
    const question = questions[id];
    if (!question) throw new Error(`Classifier returned an unrequested question ${id}`);
    if (question.type === 'bool' && answer.type === 'bool') answers[id] = { bool: answer.probability };
    else if (question.type === 'choice' && answer.type === 'choice') answers[id] = { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
    else if (question.type === 'score' && answer.type === 'choice') {
      const score = Object.entries(answer.probabilities).reduce((sum, [index, probability]) => sum + Number(index) * probability, 0);
      answers[id] = { score, probabilities: answer.probabilities, confidence: answer.confidence };
    } else throw new Error(`Classifier returned the wrong answer type for ${id}`);
  }
  if (!Check(schema, answers)) throw new Error('Classifier returned answers inconsistent with the requested questions');
  return validateJudgments(RuntimeJsonSchema.parse(answers), questions);
}

/**
 * Answers typed questions about a state with the profile's Decisions service (`decisions`, `DEFAULT_DECISIONS_SELECTOR`
 * when unset): `cloudflare/<option>` through `cloudflare`, `<provider>/<model>` a classifier model of the profile's own
 * credentials. Off, or a selected model that fails or answers out of shape, the profile's `fast` role answers with
 * structured output, and `fallback` says why.
 */
export async function runProfileDecision(models: Models, args: unknown, options: { settings: InferenceProfile['settings']; cloudflare: CloudflareDecisions; signal?: AbortSignal }): Promise<ProfileDecision> {
  const { signal } = options;
  const input = RuntimeDecideArgumentsSchema.parse(args);
  const questions: Record<string, ClassifierQuestion> = {};
  const answerProperties: Record<string, RuntimeJson> = {};
  for (const [id, question] of Object.entries(input.questions)) {
    if (question.type === 'choice') {
      questions[id] = { ...question, criteria: Object.fromEntries(Object.entries(question.criteria).map(([label, rubric]) => [label, rubric ?? label])) };
      answerProperties[id] = { type: 'object', additionalProperties: false, required: ['choice', 'probabilities', 'confidence'], properties: { choice: { enum: Object.keys(question.criteria) }, probabilities: { type: 'object', additionalProperties: false, required: Object.keys(question.criteria), properties: Object.fromEntries(Object.keys(question.criteria).map(label => [label, { type: 'number', minimum: 0, maximum: 1 }])) }, confidence: { type: 'number', minimum: 0, maximum: 1 } } };
    } else if (question.type === 'score') {
      // Asked as a choice of level indexes: a classifier's score answer carries no probabilities.
      questions[id] = { type: 'choice', instructions: question.instructions, criteria: Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion])) };
      const levels = question.criteria.map((_, index) => String(index));
      answerProperties[id] = { type: 'object', additionalProperties: false, required: ['score', 'probabilities', 'confidence'], properties: { score: { type: 'number', minimum: 0, maximum: levels.length - 1 }, probabilities: { type: 'object', additionalProperties: false, required: levels, properties: Object.fromEntries(levels.map(level => [level, { type: 'number', minimum: 0, maximum: 1 }])) }, confidence: { type: 'number', minimum: 0, maximum: 1 } } };
    } else {
      questions[id] = { ...question, criteria: { true: question.criteria?.true ?? 'Yes', false: question.criteria?.false ?? 'No' } };
      answerProperties[id] = { type: 'object', additionalProperties: false, required: ['bool'], properties: { bool: { type: 'number', minimum: 0, maximum: 1 } } };
    }
  }
  const schema = { type: 'object', additionalProperties: false, required: Object.keys(questions), properties: answerProperties };
  const configured = options.settings.decisions;
  const selector = typeof configured === 'string' ? configured : DEFAULT_DECISIONS_SELECTOR;
  let fallback = `Decisions is ${SERVICE_OFF}`;
  if (selector !== SERVICE_OFF) {
    try {
      const target = parseServiceSelector(selector);
      if (!target) throw new Error('that is not a decisions selector');
      const context: ClassifierContext = { state: typeof input.state === 'object' && input.state !== null && !Array.isArray(input.state) ? input.state : { state: input.state }, questions };
      let result: ClassifierResult;
      if (target.provider === 'cloudflare') result = await options.cloudflare(target.id, context, signal);
      else {
        const model = (await models.getAvailableOfType('classifier', target.provider, { signal })).find(candidate => candidate.id === target.id);
        if (!model) throw new Error('no credential of this profile can use that model');
        result = await models.classify(model, context, { signal });
      }
      if (result.stopReason !== 'stop') throw new Error(result.errorMessage ?? `Classification ${result.stopReason}`);
      const usage = result.usage ? { input: result.usage.input, output: result.usage.output, costUsd: result.usage.cost.total } : null;
      return { answers: classifierAnswers(result, input.questions, schema), model: selector, usage, fallback: null };
    } catch (error) {
      if (signal?.aborted) throw error;
      fallback = `${selector}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const model = await chatModel(models, options.settings, 'fast');
  const { text, usage } = await asking(model.model, completeText(models, model, JSON.stringify({ state: input.state, questions: input.questions }), `Evaluate each question independently against the supplied state. Return only JSON matching this JSON Schema:\n${JSON.stringify(schema)}\nProbabilities for choice and score questions must sum to one. Score is the probability-weighted zero-based criterion index. Confidence is your confidence in the judgment.`, signal));
  return { answers: validateJudgments(parseStructured(text, schema), input.questions), model: `${model.model.provider}/${model.model.id}`, usage, fallback };
}
