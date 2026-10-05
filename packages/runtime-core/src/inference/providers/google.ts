import {
  createAssistantMessageEventStream, calculateCost, createProvider, getCurrentSystemPrompt, getCurrentTools,
  type AssistantMessageEventStream, type AssistantMessage, type JsonObject, type JsonValue, type Model, type ModelThinkingLevel,
  type Provider, type SimpleStreamOptions, type StreamOptions, type TranscriptContext,
} from '@earendil-works/pi-ai';
import { z } from 'zod';
import { googleCatalog } from './google-models';

// Wire protocol ported from the pinned OMP 18.2.11 Cloud Code Assist adapter.
// Refresh and account rotation belong to the vault; only this attempt's key is used.
const credentialsSchema = z.object({ access: z.string().min(1), projectId: z.string().min(1) });
const jsonObjectSchema = z.record(z.string(), z.json());
const chunkSchema = z.object({
  error: z.object({ code: z.number().optional(), message: z.string().optional(), status: z.string().optional() }).optional(),
  response: z.object({
    responseId: z.string().optional(), modelVersion: z.string().optional(),
    promptFeedback: z.object({ blockReason: z.string().optional(), blockReasonMessage: z.string().optional() }).optional(),
    candidates: z.array(z.object({
      finishReason: z.string().optional(), content: z.object({ parts: z.array(z.object({
        text: z.string().optional(), thought: z.boolean().optional(), thoughtSignature: z.string().optional(),
        functionCall: z.object({ name: z.string(), args: jsonObjectSchema.optional(), id: z.string().optional() }).optional(),
      })).optional() }).optional(),
    })).optional(),
    usageMetadata: z.object({ promptTokenCount: z.number().optional(), candidatesTokenCount: z.number().optional(), thoughtsTokenCount: z.number().optional(), cachedContentTokenCount: z.number().optional(), totalTokenCount: z.number().optional() }).optional(),
  }).optional(),
});
const extraOptionsSchema = z.object({
  toolChoice: z.union([z.enum(['auto', 'none', 'any']), z.object({ mode: z.literal('ANY'), allowedFunctionNames: z.array(z.string()).min(1) })]).optional(),
  thinking: z.object({ enabled: z.boolean(), budgetTokens: z.number().optional(), level: z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'THINKING_LEVEL_UNSPECIFIED']).optional(), suppress: z.union([z.object({ level: z.string() }), z.object({ budget: z.number() })]).optional() }).optional(),
  hideThinkingSummary: z.boolean().optional(), requestModelId: z.string().optional(),
  topP: z.number().optional(), topK: z.number().optional(), presencePenalty: z.number().optional(),
  antigravityEndpointMode: z.enum(['auto', 'production', 'sandbox']).optional(),
});
type ExtraOptions = z.infer<typeof extraOptionsSchema>;
type WireContent = { role: 'user' | 'model'; parts: JsonObject[] };
const dailyEndpoint = 'https://daily-cloudcode-pa.googleapis.com';
const sandboxEndpoint = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const wireProfiles: Readonly<Record<string, { modelEnum?: string; maxOutputTokens: number }>> = {
  'gemini-3.5-flash-extra-low': { modelEnum: 'MODEL_PLACEHOLDER_M187', maxOutputTokens: 65536 },
  'gemini-3.5-flash-low': { modelEnum: 'MODEL_PLACEHOLDER_M20', maxOutputTokens: 65536 },
  'gemini-3-flash-agent': { modelEnum: 'MODEL_PLACEHOLDER_M132', maxOutputTokens: 65536 },
  'gemini-3.1-pro-low': { modelEnum: 'MODEL_PLACEHOLDER_M36', maxOutputTokens: 65535 },
  'gemini-pro-agent': { modelEnum: 'MODEL_PLACEHOLDER_M16', maxOutputTokens: 65535 },
  'claude-sonnet-4-6': { maxOutputTokens: 64000 },
  'claude-opus-4-6-thinking': { maxOutputTokens: 64000 },
};
function entryFor(model: Model<string>) {
  return googleCatalog.find(entry => entry.model.provider === model.provider && entry.model.id === model.id);
}
function signature(value: string | undefined, same: boolean): string | undefined {
  return same && value && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined;
}
function imagePart(data: string, mimeType: string): JsonObject { return { inlineData: { data, mimeType } }; }
function convertMessages(model: Model<string>, context: TranscriptContext): WireContent[] {
  const compat = entryFor(model)?.compat;
  const contents: WireContent[] = [];
  let pendingImages: JsonObject[] = [];
  const flushImages = () => { if (pendingImages.length) { contents.push({ role: 'user', parts: pendingImages }); pendingImages = []; } };
  for (const message of context.messages) {
    if (message.role === 'system') continue;
    if (message.role !== 'toolResult') flushImages();
    if (message.role === 'user') {
      const parts: JsonObject[] = [];
      if (typeof message.content === 'string') { if (message.content.trim()) parts.push({ text: message.content.toWellFormed() }); }
      else for (const part of message.content) {
        if (part.type === 'text') { if (part.text.trim()) parts.push({ text: part.text.toWellFormed() }); }
        else parts.push(model.input.includes('image') ? imagePart(part.data, part.mimeType) : { text: '[Image omitted: model does not support images]' });
      }
      if (parts.length) contents.push({ role: 'user', parts });
    } else if (message.role === 'assistant') {
      if (message.stopReason === 'error' || message.stopReason === 'aborted') continue;
      const same = message.provider === model.provider && message.model === model.id;
      const parts: JsonObject[] = [];
      let firstCall = true;
      for (const block of message.content) {
        if (block.type === 'toolCall') {
          const sig = signature(block.thoughtSignature, same) ?? (firstCall && compat?.requiresSkipThoughtSignatureOnFirstFunctionCall ? 'skip_thought_signature_validator' : undefined);
          firstCall = false;
          parts.push({ functionCall: { name: block.name, args: block.arguments, ...(compat?.supportsFunctionPartId ? { id: block.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) } : {}) }, ...(sig ? { thoughtSignature: sig } : {}) });
        } else {
          const text = block.type === 'text' ? block.text : block.thinking;
          const sig = signature(block.type === 'text' ? block.textSignature : block.thinkingSignature, same);
          if (!text.trim() || (block.type === 'thinking' && compat?.dropUnsignedThinking && !sig)) continue;
          parts.push({ text: text.toWellFormed(), ...(block.type === 'thinking' && sig ? { thought: true } : {}), ...(sig ? { thoughtSignature: sig } : {}) });
        }
      }
      if (parts.length) contents.push({ role: 'model', parts });
    } else {
      const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const images = message.content.filter(part => part.type === 'image');
      const response: JsonObject = { [message.isError ? 'error' : 'output']: text || (images.length ? '(see attached image)' : '') };
      const functionResponse: JsonObject = { name: message.toolName, response, ...(compat?.supportsFunctionPartId ? { id: message.toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) } : {}) };
      if (model.input.includes('image')) {
        const parts = images.map(part => imagePart(part.data, part.mimeType));
        if (compat?.multimodalFunctionResponse) functionResponse.parts = parts;
        else pendingImages.push(...parts);
      }
      const part = { functionResponse };
      const prior = contents.at(-1);
      if (prior?.role === 'user' && prior.parts.some(value => 'functionResponse' in value)) prior.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
    }
  }
  flushImages();
  return contents;
}

// CCA's legacy Schema protobuf accepts a subset of JSON Schema. Preserve modern
// parametersJsonSchema on Gemini CLI; lower the schema only for CCA legacy routes.
function normalizeSchema(value: JsonValue, root: JsonValue = value, references: readonly string[] = []): JsonValue {
  if (Array.isArray(value)) return value.map(child => normalizeSchema(child, root, references));
  if (value === null || typeof value !== 'object') return value;
  const object = jsonObjectSchema.parse(value);
  if (typeof object.$ref === 'string') {
    const ref = object.$ref;
    if (!ref.startsWith('#/') || references.includes(ref)) throw new Error(`Cloud Code Assist cannot represent schema reference ${ref}`);
    let target: JsonValue = root;
    for (const segment of ref.slice(2).split('/')) {
      const container = jsonObjectSchema.parse(target);
      const next = container[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (next === undefined) throw new Error(`Unresolved tool schema reference ${ref}`);
      target = next;
    }
    return normalizeSchema(target, root, [...references, ref]);
  }
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(object)) {
    if (['$schema', '$id', '$defs', 'definitions', 'additionalProperties', 'default', 'examples'].includes(key)) continue;
    if (key === 'const') result.enum = [child];
    else if (key === 'properties') {
      const properties: JsonObject = {};
      for (const [name, schema] of Object.entries(jsonObjectSchema.parse(child))) properties[name] = normalizeSchema(schema, root, references);
      result.properties = properties;
    } else if (key === 'type' && Array.isArray(child)) {
      const concrete = child.filter(item => item !== 'null');
      if (concrete[0] !== undefined) result.type = concrete[0];
      if (child.includes('null')) result.nullable = true;
    } else if (key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'allOf') result[key] = normalizeSchema(child, root, references);
    else result[key] = child;
  }
  return result;
}
async function sessionIdentity(context: TranscriptContext, sessionId?: string): Promise<string> {
  const firstUser = context.messages.find(message => message.role === 'user');
  const seed = sessionId ?? (firstUser?.role === 'user' ? typeof firstUser.content === 'string' ? firstUser.content : firstUser.content.find(part => part.type === 'text')?.text : undefined);
  const bytes = seed ? new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))).subarray(0, 8) : crypto.getRandomValues(new Uint8Array(8));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return `-${value & ((1n << 63n) - 1n)}`;
}
async function buildRequest(model: Model<string>, context: TranscriptContext, projectId: string, options: StreamOptions, extra: ExtraOptions): Promise<JsonObject> {
  const antigravity = model.provider === 'google-antigravity';
  const entry = entryFor(model);
  const wireModel = extra.requestModelId ?? entry?.requestModelId ?? model.id;
  const profile = antigravity ? wireProfiles[wireModel] : undefined;
  const contents = convertMessages(model, context);
  const request: JsonObject = { contents };
  const system = getCurrentSystemPrompt(context.messages);
  if (system) request.systemInstruction = { ...(antigravity ? { role: 'user' } : {}), parts: [{ text: system }] };
  const generation: JsonObject = {};
  if (options.temperature !== undefined) generation.temperature = options.temperature;
  if (options.maxTokens !== undefined) generation.maxOutputTokens = options.maxTokens;
  if (profile) generation.maxOutputTokens = profile.maxOutputTokens;
  if (extra.topP !== undefined) generation.topP = extra.topP;
  if (extra.topK !== undefined) generation.topK = extra.topK;
  if (extra.presencePenalty !== undefined) generation.presencePenalty = extra.presencePenalty;
  if (model.reasoning && extra.thinking?.enabled) generation.thinkingConfig = {
    includeThoughts: !extra.hideThinkingSummary,
    ...(extra.thinking.level ? { thinkingLevel: extra.thinking.level } : extra.thinking.budgetTokens !== undefined ? { thinkingBudget: extra.thinking.budgetTokens } : {}),
  };
  else if (model.reasoning && extra.thinking?.suppress) generation.thinkingConfig = {
    includeThoughts: false,
    ...('level' in extra.thinking.suppress ? { thinkingLevel: extra.thinking.suppress.level } : { thinkingBudget: extra.thinking.suppress.budget }),
  };
  if (Object.keys(generation).length) request.generationConfig = generation;
  const tools = getCurrentTools(context.messages);
  if (tools.length) {
    request.tools = [{ functionDeclarations: tools.map(tool => {
      const schema = jsonObjectSchema.parse(tool.parameters);
      return { name: tool.name, description: tool.description, ...(antigravity || entry?.compat.ccaLegacyParametersSchema ? { parameters: normalizeSchema(schema) } : { parametersJsonSchema: schema }) };
    }) }];
    const choice = extra.toolChoice;
    const mode = typeof choice === 'object' ? 'ANY' : choice === 'none' ? 'NONE' : choice === 'any' ? 'ANY' : antigravity ? 'VALIDATED' : 'AUTO';
    request.toolConfig = { functionCallingConfig: { mode, ...(typeof choice === 'object' ? { allowedFunctionNames: choice.allowedFunctionNames } : {}) } };
    if (antigravity && !model.id.startsWith('claude') && mode === 'ANY') contents.push({ role: 'user', parts: [{ text: `You must respond by calling ${typeof choice === 'object' ? choice.allowedFunctionNames.join(' or ') : 'one of the available tools'}. Do not answer in plain text.` }] });
  }
  if (entry?.compat.antigravityClaudeToolMode) request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
  if (!antigravity) return { project: projectId, model: wireModel, request };
  const trajectoryId = options.sessionId ?? crypto.randomUUID();
  const step = context.messages.filter(message => message.role === 'assistant').length + 2;
  const previous = context.messages.findLast(message => message.role === 'assistant' && message.provider === model.provider);
  request.labels = {
    last_step_index: String(step - 1), trajectory_id: trajectoryId,
    used_claude: entry?.compat.antigravityUsageLabel ?? String(model.id.startsWith('claude')),
    used_claude_conservative: entry?.compat.antigravityUsageLabel ?? String(model.id.startsWith('claude')),
    ...(profile?.modelEnum ? { model_enum: profile.modelEnum } : {}),
    ...(previous?.role === 'assistant' && previous.responseId ? { last_execution_id: previous.responseId } : {}),
  };
  request.sessionId = await sessionIdentity(context, options.sessionId);
  return { project: projectId, model: wireModel, request, userAgent: 'antigravity', requestType: 'agent', requestId: `agent/${trajectoryId}/${Date.now()}/${trajectoryId}/${step}` };
}

async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    while (true) {
      const next = await reader.read();
      buffer += decoder.decode(next.value, { stream: !next.done });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (data.length) { const value = data.join('\n'); data = []; if (value !== '[DONE]') yield JSON.parse(value); }
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (next.done) break;
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
    if (data.length && data.join('\n') !== '[DONE]') yield JSON.parse(data.join('\n'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function streamGoogle(model: Model<string>, context: TranscriptContext, options: StreamOptions = {}): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = { role: 'assistant', content: [], api: 'google-gemini-cli', provider: model.provider, model: model.id, stopReason: 'pending', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  void (async () => {
    try {
      if (!options.apiKey) throw new Error('Cloud Code Assist requires an account-bound OAuth credential');
      const credentials = credentialsSchema.parse(JSON.parse(options.apiKey));
      const extra = extraOptionsSchema.parse(options);
      const payload = await buildRequest(model, context, credentials.projectId, options, extra);
      const replacement = await options.onPayload?.(payload, model);
      const headers = new Headers();
      headers.set('Content-Type', 'application/json'); headers.set('Accept', 'text/event-stream');
      if (model.provider === 'google-antigravity') {
        headers.set('User-Agent', 'antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)');
        if (entryFor(model)?.compat.claudeThinkingBetaHeader) headers.set('anthropic-beta', 'interleaved-thinking-2025-05-14');
      } else {
        headers.set('User-Agent', `GeminiCLI/0.46.0/${model.id} (linux; x64; terminal)`);
        headers.set('Client-Metadata', 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI');
      }
      for (const [name, value] of Object.entries(options.headers ?? {})) { if (value === null) headers.delete(name); else headers.set(name, value); }
      headers.set('Authorization', `Bearer ${credentials.access}`);
      const base = model.baseUrl.replace(/\/+$/, '');
      const endpoints = model.provider !== 'google-antigravity' ? [base] : extra.antigravityEndpointMode === 'sandbox' ? [sandboxEndpoint] : extra.antigravityEndpointMode === 'production' ? [dailyEndpoint] : [dailyEndpoint, sandboxEndpoint].includes(base) ? [dailyEndpoint, sandboxEndpoint] : [base];
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 300_000)]) : AbortSignal.timeout(options.timeoutMs ?? 300_000);
      let response: Response | undefined;
      for (let index = 0; index < endpoints.length; index++) {
        response = await (options.fetch ?? globalThis.fetch)(`${endpoints[index]}/v1internal:streamGenerateContent?alt=sse`, { method: 'POST', headers, body: JSON.stringify(replacement ?? payload), signal, redirect: 'manual' });
        await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);
        if (response.ok) break;
        const detail = await response.text();
        if (index + 1 < endpoints.length && (response.status === 429 || response.status >= 500)) continue;
        throw new Error(`Cloud Code Assist HTTP ${response.status}: ${detail}`);
      }
      if (!response?.ok || !response.body) throw new Error('Cloud Code Assist returned no response body');
      stream.push({ type: 'start', partial: output });
      let currentIndex: number | undefined;
      let finished = false;
      let reason: 'stop' | 'length' | 'toolUse' = 'stop';
      const closeBlock = () => {
        const block = currentIndex === undefined ? undefined : output.content[currentIndex];
        if (block && currentIndex !== undefined) {
          if (block.type === 'text') stream.push({ type: 'text_end', contentIndex: currentIndex, content: block.text, partial: output });
          else if (block.type === 'thinking') stream.push({ type: 'thinking_end', contentIndex: currentIndex, content: block.thinking, partial: output });
        }
        currentIndex = undefined;
      };
      for await (const raw of sse(response.body)) {
        await options.onProviderStreamEvent?.(raw, model);
        const chunk = chunkSchema.parse(raw);
        if (chunk.error) throw new Error(`Cloud Code Assist HTTP ${chunk.error.code ?? 500}: ${chunk.error.message ?? chunk.error.status ?? 'stream error'}`);
        const data = chunk.response;
        if (!data) continue;
        if (data.responseId) output.responseId = data.responseId;
        if (data.modelVersion) output.responseModel = data.modelVersion;
        if (!data.candidates?.length && data.promptFeedback?.blockReason) throw new Error(`Cloud Code Assist blocked response: ${data.promptFeedback.blockReason}: ${data.promptFeedback.blockReasonMessage ?? ''}`);
        const candidate = data.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (part.functionCall) {
            closeBlock();
            const call = part.functionCall;
            const id = call.id && !output.content.some(block => block.type === 'toolCall' && block.id === call.id) ? call.id : `${call.name}_${crypto.randomUUID()}`;
            const toolCall = { type: 'toolCall' as const, id, name: call.name, arguments: call.args ?? {}, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) };
            const contentIndex = output.content.length;
            output.content.push(toolCall);
            stream.push({ type: 'toolcall_start', contentIndex, partial: output });
            stream.push({ type: 'toolcall_delta', contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
            stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: output });
          } else if (part.text) {
            const type = part.thought ? 'thinking' : 'text';
            let block = currentIndex === undefined ? undefined : output.content[currentIndex];
            if (block?.type !== type) {
              closeBlock(); currentIndex = output.content.length;
              block = type === 'thinking' ? { type, thinking: '' } : { type, text: '' };
              output.content.push(block);
              stream.push({ type: type === 'thinking' ? 'thinking_start' : 'text_start', contentIndex: currentIndex, partial: output });
            }
            if (currentIndex === undefined) throw new Error('Cloud Code Assist block index invariant');
            if (block.type === 'thinking') { block.thinking += part.text; if (part.thoughtSignature) block.thinkingSignature = part.thoughtSignature; stream.push({ type: 'thinking_delta', contentIndex: currentIndex, delta: part.text, partial: output }); }
            else if (block.type === 'text') { block.text += part.text; if (part.thoughtSignature) block.textSignature = part.thoughtSignature; stream.push({ type: 'text_delta', contentIndex: currentIndex, delta: part.text, partial: output }); }
          } else if (part.thoughtSignature && currentIndex !== undefined) {
            const block = output.content[currentIndex];
            if (block?.type === 'thinking') block.thinkingSignature = part.thoughtSignature;
            else if (block?.type === 'text') block.textSignature = part.thoughtSignature;
          }
        }
        if (candidate?.finishReason) {
          finished = true; output.rawStopReason = candidate.finishReason;
          if (candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') throw new Error(`Cloud Code Assist generation failed: ${candidate.finishReason}`);
          reason = candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';
        }
        if (data.usageMetadata) {
          const usage = data.usageMetadata;
          output.usage.input = (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0);
          output.usage.cacheRead = usage.cachedContentTokenCount ?? 0;
          output.usage.output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
          output.usage.reasoning = usage.thoughtsTokenCount ?? 0;
          output.usage.totalTokens = usage.totalTokenCount ?? output.usage.input + output.usage.cacheRead + output.usage.output;
          calculateCost(model, output.usage);
        }
      }
      closeBlock();
      if (!finished) throw new Error('Cloud Code Assist stream ended without a finish reason');
      if (!output.content.length) throw new Error('Cloud Code Assist returned an empty stream');
      if (output.content.some(block => block.type === 'toolCall')) reason = 'toolUse';
      output.stopReason = reason;
      stream.push({ type: 'done', reason, message: output });
    } catch (error) {
      const reason = options.signal?.aborted ? 'aborted' : 'error';
      output.stopReason = reason; output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: 'error', reason, error: output });
    } finally { stream.end(); }
  })();
  return stream;
}
function streamSimple(model: Model<string>, context: TranscriptContext, options: SimpleStreamOptions = {}) {
  const entry = entryFor(model);
  let effort: ModelThinkingLevel = options.reasoning ?? 'off';
  const metadata = entry?.thinking;
  if (metadata && (effort !== 'off' || (metadata.requiresEffort && !metadata.suppressWhenOff))) {
    const ordered: readonly ModelThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const available = ordered.filter(value => metadata.efforts.includes(value));
    if (!available.includes(effort)) {
      effort = available.find(value => ordered.indexOf(value) >= ordered.indexOf(effort)) ?? available.at(-1) ?? effort;
    }
  }
  const routed = metadata?.effortRouting?.[effort] ?? entry?.requestModelId;
  const enabled = model.reasoning && (effort !== 'off' || metadata?.requiresEffort === true);
  const level = effort === 'off' || effort === 'minimal' ? 'MINIMAL' : effort === 'low' ? 'LOW' : effort === 'medium' ? 'MEDIUM' : 'HIGH';
  const defaultBudgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
  const budgetEffort = effort === 'off' ? 'minimal' : effort === 'max' || effort === 'xhigh' ? 'high' : effort;
  const budget = metadata?.effortBudgets?.[effort] ?? options.thinkingBudgets?.[budgetEffort] ?? defaultBudgets[budgetEffort];
  const extra: ExtraOptions = {
    toolChoice: options.toolChoice, requestModelId: routed,
    thinking: { enabled: effort === 'off' && metadata?.suppressWhenOff ? false : enabled,
      ...(metadata?.mode === 'google-level' ? { level } : { budgetTokens: Math.min(budget, (options.maxTokens ?? model.maxTokens) - 1) }),
      ...(effort === 'off' && metadata?.suppressWhenOff ? { suppress: metadata.mode === 'google-level' ? { level: 'MINIMAL' } : { budget: 0 } } : {}),
    },
  };
  return streamGoogle(model, context, { ...options, ...extra });
}
function provider(id: 'google-gemini-cli' | 'google-antigravity', name: string): Provider {
  return createProvider({
    id, name, baseUrl: id === 'google-antigravity' ? dailyEndpoint : 'https://cloudcode-pa.googleapis.com',
    auth: { apiKey: { name: 'Account-bound Google OAuth', resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, source: 'vault' } : undefined } },
    models: googleCatalog.filter(entry => entry.model.provider === id).map(entry => entry.model),
    api: { stream: streamGoogle, streamSimple },
  });
}
export function geminiCliProvider(): Provider { return provider('google-gemini-cli', 'Google Gemini CLI'); }
export function antigravityProvider(): Provider { return provider('google-antigravity', 'Google Antigravity'); }
