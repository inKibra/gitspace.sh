import type { ClassifierQuestion, Model, Models, ModelTypeMap, JsonObject } from '@earendil-works/pi-ai';
import { applyInferenceSettings, type InferenceProfile } from '@gitspace/protocol/inference';
import { RuntimeGenerateImageArgumentsSchema, RuntimeJsonSchema, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { Check } from 'typebox/schema';
import { z } from 'zod';
import { resolveAvailableProfileModel } from './admission.js';

export type RuntimeJson = z.infer<typeof RuntimeJsonSchema>;
const jsonObject = z.record(z.string(), RuntimeJsonSchema);
const outputSchema = z.union([z.boolean(), jsonObject]);
const modelSelection = z.string().min(1).optional();
const completionArgs = z.object({ prompt: z.string().min(1), model: modelSelection, system: z.string().optional(), schema: outputSchema.optional() }).strict();
const questionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), instructions: z.string(), criteria: z.record(z.string(), z.string().nullable()).refine(value => Object.keys(value).length >= 2, 'Choice questions require at least two labels') }),
  z.object({ type: z.literal('score'), instructions: z.string(), criteria: z.array(z.string()).min(2) }),
  z.object({ type: z.literal('bool'), instructions: z.string(), criteria: z.object({ true: z.string().optional(), false: z.string().optional() }).optional() }),
]);
const judgeArgs = z.object({ state: RuntimeJsonSchema, questions: z.record(z.string(), questionSchema).refine(value => Object.keys(value).length > 0, 'At least one question is required'), model: modelSelection }).strict();
const selectionSettings = z.object({ modelRoles: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(), enabledModels: z.array(z.string()).optional() });
function chooseModel<T extends ModelTypeMap[keyof ModelTypeMap]>(candidates: readonly T[], settings: InferenceProfile['settings'], selection: string | undefined, role: string): T | undefined {
  const config = selectionSettings.parse(applyInferenceSettings({}, settings));
  const matches = (pattern: string, model: T) => {
    const expression = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*')}$`, 'iu');
    return expression.test(`${model.provider}/${model.id}`) || expression.test(model.id);
  };
  const admitted = candidates.filter(model => !config.enabledModels?.length || config.enabledModels.some(pattern => matches(pattern, model)));
  const visited = new Set<string>();
  const resolve = (value: string | string[]): T | undefined => {
    for (const pattern of typeof value === 'string' ? [value] : value) {
      const alias = pattern.startsWith('pi/') ? pattern.slice(3) : pattern.startsWith('@') ? pattern.slice(1) : config.modelRoles?.[pattern] !== undefined ? pattern : undefined;
      if (alias !== undefined) {
        if (visited.has(alias)) throw new Error(`Circular inference model role: ${alias}`);
        visited.add(alias);
        const configured = config.modelRoles?.[alias];
        const selected = configured ? resolve(configured) : undefined;
        visited.delete(alias);
        if (selected) return selected;
      } else {
        const selected = admitted.find(model => matches(pattern, model));
        if (selected) return selected;
      }
    }
    return undefined;
  };
  const configured = selection ?? config.modelRoles?.[role];
  return configured === undefined ? admitted[0] : resolve(configured);
}

async function chatModel(models: Models, settings: InferenceProfile['settings'], selection: string | undefined): Promise<Model<string>> {
  if (selection === undefined || ['default', 'smol', 'slow'].includes(selection)) return resolveAvailableProfileModel(settings, models, selection ?? 'default');
  const model = chooseModel(await models.getAvailable(), settings, selection, 'default');
  if (!model) throw new Error(`No authenticated admitted chat model matches ${selection}`);
  return model;
}
async function completeText(models: Models, model: Model<string>, prompt: string, system: string | undefined, signal: AbortSignal | undefined): Promise<string> {
  const message = await models.completeSimple(model, { systemPrompt: system, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] }, { signal });
  if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage ?? `Model request ${message.stopReason}`);
  if (message.stopReason !== 'stop') throw new Error(`Model helper returned an incomplete response (${message.stopReason})`);
  return message.content.filter(part => part.type === 'text').map(part => part.text).join('');
}
function parseStructured(text: string, schema: z.infer<typeof outputSchema>): RuntimeJson {
  const json = RuntimeJsonSchema.parse(JSON.parse(text));
  if (!Check(schema, json)) throw new Error('Model response did not match the requested JSON schema');
  return json;
}

function validateJudgments(value: RuntimeJson, questions: z.infer<typeof judgeArgs>['questions']): RuntimeJson {
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

/** Only the caller's admitted registry supplies authentication and transport. */
export async function generateProfileImage(models: Models, args: unknown, signal?: AbortSignal, settings: InferenceProfile['settings'] = {}): Promise<RuntimeToolResult['content']> {
  const input = RuntimeGenerateImageArgumentsSchema.parse(args);
  const model = chooseModel(await models.getAvailableOfType('image', undefined, { signal }), settings, input.model, 'image');
  if (!model) throw new Error('No authenticated admitted image model matches the image role or requested model');
  const result = await models.generateImages(model, { input: [{ type: 'text', text: input.prompt }, ...(input.images ?? [])] }, { signal });
  if (result.stopReason !== 'stop') throw new Error(result.errorMessage ?? `Image generation ${result.stopReason}`);
  if (!result.output.some(part => part.type === 'image')) throw new Error('Image provider returned no image');
  return result.output;
}

/** Completion returns text or schema-validated JSON; judge returns typed answers. */
export async function runProfileModelHelper(models: Models, operation: 'completion' | 'judge', args: unknown, signal?: AbortSignal, settings: InferenceProfile['settings'] = {}): Promise<RuntimeJson> {
  if (operation === 'completion') {
    const input = completionArgs.parse(args);
    const model = await chatModel(models, settings, input.model);
    const system = input.schema === undefined ? input.system : `${input.system ?? ''}\nReturn only JSON matching this JSON Schema, with no markdown or explanation:\n${JSON.stringify(input.schema)}`;
    const text = await completeText(models, model, input.prompt, system, signal);
    return input.schema === undefined ? text : parseStructured(text, input.schema);
  }
  const input = judgeArgs.parse(args);
  const questions: Record<string, ClassifierQuestion> = {};
  const answerProperties: Record<string, RuntimeJson> = {};
  for (const [id, question] of Object.entries(input.questions)) {
    if (question.type === 'choice') {
      questions[id] = { ...question, criteria: Object.fromEntries(Object.entries(question.criteria).map(([label, rubric]) => [label, rubric ?? label])) };
      answerProperties[id] = { type: 'object', additionalProperties: false, required: ['choice', 'probabilities', 'confidence'], properties: { choice: { enum: Object.keys(question.criteria) }, probabilities: { type: 'object', additionalProperties: false, required: Object.keys(question.criteria), properties: Object.fromEntries(Object.keys(question.criteria).map(label => [label, { type: 'number', minimum: 0, maximum: 1 }])) }, confidence: { type: 'number', minimum: 0, maximum: 1 } } };
    } else if (question.type === 'score') {
      questions[id] = { type: 'choice', instructions: question.instructions, criteria: Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion])) };
      const levels = question.criteria.map((_, index) => String(index));
      answerProperties[id] = { type: 'object', additionalProperties: false, required: ['score', 'probabilities', 'confidence'], properties: { score: { type: 'number', minimum: 0, maximum: levels.length - 1 }, probabilities: { type: 'object', additionalProperties: false, required: levels, properties: Object.fromEntries(levels.map(level => [level, { type: 'number', minimum: 0, maximum: 1 }])) }, confidence: { type: 'number', minimum: 0, maximum: 1 } } };
    } else {
      questions[id] = { ...question, criteria: { true: question.criteria?.true ?? 'Yes', false: question.criteria?.false ?? 'No' } };
      answerProperties[id] = { type: 'object', additionalProperties: false, required: ['bool'], properties: { bool: { type: 'number', minimum: 0, maximum: 1 } } };
    }
  }
  const schema = { type: 'object', additionalProperties: false, required: Object.keys(questions), properties: answerProperties };
  const classifier = chooseModel(await models.getAvailableOfType('classifier', undefined, { signal }), settings, input.model, 'judge');
  if (classifier) {
    const state: JsonObject = typeof input.state === 'object' && input.state !== null && !Array.isArray(input.state) ? input.state : { state: input.state };
    const result = await models.classify(classifier, { state, questions }, { signal });
    if (result.stopReason !== 'stop') throw new Error(result.errorMessage ?? `Classification ${result.stopReason}`);
    const answers: JsonObject = {};
    for (const [id, answer] of Object.entries(result.answers)) {
      const question = input.questions[id];
      if (!question) throw new Error(`Classifier returned an unrequested question ${id}`);
      if (question.type === 'bool' && answer.type === 'bool') answers[id] = { bool: answer.probability };
      else if (question.type === 'choice' && answer.type === 'choice') answers[id] = { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
      else if (question.type === 'score' && answer.type === 'choice') {
        const score = Object.entries(answer.probabilities).reduce((sum, [index, probability]) => sum + Number(index) * probability, 0);
        answers[id] = { score, probabilities: answer.probabilities, confidence: answer.confidence };
      } else throw new Error(`Classifier returned the wrong answer type for ${id}`);
    }
    if (!Check(schema, answers)) throw new Error('Classifier returned answers inconsistent with the requested questions');
    return validateJudgments(RuntimeJsonSchema.parse(answers), input.questions);
  }
  // A registry without an applicable classifier still has a real cloud inference
  // path: the admitted chat model must return the same checked answer schema.
  const model = await chatModel(models, settings, input.model ?? 'smol');
  const text = await completeText(models, model, JSON.stringify({ state: input.state, questions: input.questions }), `Evaluate each question independently against the supplied state. Return only JSON matching this JSON Schema:\n${JSON.stringify(schema)}\nProbabilities for choice and score questions must sum to one. Score is the probability-weighted zero-based criterion index. Confidence is your confidence in the judgment.`, signal);
  return validateJudgments(parseStructured(text, schema), input.questions);
}
