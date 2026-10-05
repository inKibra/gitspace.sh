import type { AnyModel, ModelsStore, ModelsStoreEntry } from '@earendil-works/pi-ai';
import { z } from 'zod';

const rates = { input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative() };
const cost = z.object({ ...rates, tiers: z.array(z.object({ ...rates, inputTokensAbove: z.number() })).optional() });
const bool = z.boolean().optional();
const strings = z.array(z.string()).optional();
const percentile = z.union([z.number(), z.object({ p50: z.number().optional(), p75: z.number().optional(), p90: z.number().optional(), p99: z.number().optional() })]);
const price = z.union([z.number(), z.string()]).optional();
const templateValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.object({ $var: z.enum(['thinking.enabled', 'thinking.effort', 'thinking.budget']), omitWhenOff: bool })]);
const compat = z.object({
  supportsStore: bool, supportsDeveloperRole: bool, supportsReasoningEffort: bool,
  supportsUsageInStreaming: bool, supportsFinishReason: bool,
  maxTokensField: z.enum(['max_completion_tokens', 'max_tokens']).optional(),
  requiresToolResultName: bool, requiresAssistantAfterToolResult: bool,
  requiresThinkingAsText: bool, requiresReasoningContentOnAssistantMessages: bool,
  thinkingFormat: z.enum(['openai', 'openrouter', 'deepseek', 'together', 'baseten', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling']).optional(),
  chatTemplateKwargs: z.record(z.string(), templateValue).optional(), chatTemplateArgs: z.record(z.string(), templateValue).optional(),
  openRouterRouting: z.object({
    allow_fallbacks: bool, require_parameters: bool, data_collection: z.enum(['deny', 'allow']).optional(), zdr: bool, enforce_distillable_text: bool,
    order: strings, only: strings, ignore: strings, quantizations: strings,
    sort: z.union([z.string(), z.object({ by: z.string().optional(), partition: z.string().nullable().optional() })]).optional(),
    max_price: z.object({ prompt: price, completion: price, image: price, audio: price, request: price }).optional(),
    preferred_min_throughput: percentile.optional(), preferred_max_latency: percentile.optional(),
  }).optional(),
  vercelGatewayRouting: z.object({ only: strings, order: strings }).optional(),
  zaiToolStream: bool, thinkingTokenBudgetField: z.enum(['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens']).optional(),
  supportsThinkingTokenBudget: bool, supportsOpenAIGrammarTools: bool,
  supportsMidConvoSystemMessages: bool, supportsMidConvoToolAdditions: bool, supportsStrictMode: bool,
  cacheControlFormat: z.literal('anthropic').optional(), sendSessionAffinityHeaders: bool,
  sessionAffinityFormat: z.enum(['openai', 'openai-nosession', 'openrouter']).optional(),
  supportsLongCacheRetention: bool, vllmPriority: z.number().optional(),
  supportsAdditionalTools: bool, supportsToolSearch: bool, supportsExplicitPromptCacheMode: bool, supportsMaxOutputTokens: bool,
  supportsEagerToolInputStreaming: bool, supportsCacheControlOnTools: bool, supportsTemperature: bool,
  forceAdaptiveThinking: bool, allowEmptySignature: bool, supportsStrictTools: bool,
  supportsMidConvoEffort: bool, supportsMidConvoToolChanges: bool,
  allowedFallbackModels: z.array(z.object({ provider: z.string(), model: z.string(), cost })).optional(),
}).catchall(z.json());
const base = z.object({
  id: z.string().min(1), name: z.string().min(1), api: z.string().min(1), provider: z.string().min(1), baseUrl: z.string(),
  input: z.array(z.enum(['text', 'image'])), cost,
  headers: z.record(z.string(), z.string()).optional(),
  inputLimits: z.object({
    maxRequestBytes: z.number().optional(),
    images: z.object({
      resize: z.object({ maxWidth: z.number().optional(), maxHeight: z.number().optional(), maxBytes: z.number().optional(), jpegQuality: z.number().optional() }).optional(),
      maxPerMessage: z.number().optional(), maxPerRequest: z.number().optional(),
    }).optional(),
  }).optional(),
}).catchall(z.json());

export const StoredPiModelSchema = z.union([
  base.extend({
    type: z.literal('chat').optional(), reasoning: z.boolean(), contextWindow: z.number(), maxTokens: z.number(),
    thinkingLevelMap: z.partialRecord(z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']), z.string().nullable()).optional(),
    promptCache: z.object({ short: z.number().optional(), long: z.number().optional() }).optional(),
    samplingParams: z.record(z.string(), z.json()).optional(), compat: compat.optional(),
  }),
  base.extend({ type: z.literal('image'), output: z.array(z.enum(['text', 'image'])).refine(values => values.includes('image'), 'Image models must output images') }),
  base.extend({ type: z.literal('classifier'), contextWindow: z.number() }),
]) satisfies z.ZodType<AnyModel>;

export const ModelsStoreEntrySchema = z.object({
  models: z.array(StoredPiModelSchema),
  lastModified: z.number().optional(), checkedAt: z.number().optional(), etag: z.string().optional(),
}) satisfies z.ZodType<ModelsStoreEntry>;

export type DurableModelsStorage = {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
};

/** Pi owns publication generation checks; storage must atomically replace each key. */
export function createDurableModelsStore(storage: DurableModelsStorage): ModelsStore {
  return {
    async read(providerId, options) {
      options?.signal?.throwIfAborted();
      const raw = await storage.read(`inference/catalog/${encodeURIComponent(providerId)}`);
      options?.signal?.throwIfAborted();
      if (raw === undefined || raw === null) return undefined;
      const entry = ModelsStoreEntrySchema.parse(raw);
      for (const model of entry.models) {
        if (model.provider !== providerId) throw new Error('Persisted catalog provider does not match its storage key');
        delete model.headers;
      }
      return entry;
    },
    async write(providerId, value, options) {
      options?.signal?.throwIfAborted();
      const entry = ModelsStoreEntrySchema.parse(value);
      for (const model of entry.models) {
        if (model.provider !== providerId) throw new Error('Catalog provider does not match its storage key');
        // Provider-defined header names can carry secrets. Runtime providers must
        // restore canonical static headers, never serialized request credentials.
        delete model.headers;
      }
      await storage.write(`inference/catalog/${encodeURIComponent(providerId)}`, entry);
    },
    async delete(providerId, options) {
      options?.signal?.throwIfAborted();
      await storage.delete(`inference/catalog/${encodeURIComponent(providerId)}`);
    },
  };
}
