/**
 * A web search run by a model with its provider's built-in search tool, on one of the profile's accounts: one
 * non-streaming request (Anthropic's Messages API, OpenAI's Responses API or Gemini's generateContent) asking the model
 * to search for the query and answer briefly, and the provider's raw answer read into the search's answer and results.
 * A Claude subscription request takes Claude Code's shape, as its chat requests do (`claudeCode`).
 */
import type { Api, Model, ModelAuth } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { CLAUDE_CODE_VERSION } from '@gitspace/provider-auth';
import { CLAUDE_CODE_INSTRUCTION } from './claude-code-request.js';

export type WebSearchHit = { title: string; url: string; description?: string; lastModified?: string };
export type WebSearchAnswer = { answer: string | null; results: WebSearchHit[] };
export type WebSearchRequest = { query: string; limit: number };
/** What a web search attempt ends with: the search's answer, or why the provider did not give one. */
export type WebSearchEvent = { type: 'webSearch'; found: WebSearchAnswer } | { type: 'webSearchError'; errorMessage: string };
/** How a search request is sent: never following redirects, and with Claude Code's shape for a Claude subscription. */
export type WebSearchTransport = { fetch: typeof fetch; onPayload(payload: unknown, model: Model<Api>): Promise<unknown> };

/** Searches one turn may run on Anthropic's API. */
const ANTHROPIC_MAX_SEARCHES = 3;
/** The answer is a few sentences; a reasoning model's thinking counts against the same allowance. */
const ANSWER_TOKENS = 1024;
const REASONING_ANSWER_TOKENS = 4096;

/** Results in the order first seen, one per URL, each described by the distinct passages cited from it. */
function collected() {
  const byUrl = new Map<string, { hit: WebSearchHit; cited: string[] }>();
  const add = (url: string, title: string | null | undefined, lastModified?: string | null) => {
    const existing = byUrl.get(url);
    if (!existing) {
      byUrl.set(url, { hit: { title: title || url, url, ...(lastModified ? { lastModified } : {}) }, cited: [] });
      return;
    }
    if (title && existing.hit.title === url) existing.hit.title = title;
    if (lastModified && !existing.hit.lastModified) existing.hit.lastModified = lastModified;
  };
  return {
    add,
    cite(url: string, title: string | null | undefined, passage: string) {
      add(url, title);
      const text = passage.trim();
      const entry = byUrl.get(url)!;
      if (text && !entry.cited.includes(text)) entry.cited.push(text);
    },
    hits: (): WebSearchHit[] => [...byUrl.values()].map(({ hit, cited }) => cited.length ? { ...hit, description: cited.join(' … ') } : hit),
  };
}

const AnthropicResponseSchema = z.looseObject({ content: z.array(z.looseObject({ type: z.string() })) });
const AnthropicResultsSchema = z.looseObject({
  type: z.literal('web_search_tool_result'),
  content: z.union([z.array(z.looseObject({ type: z.string(), url: z.string().optional(), title: z.string().nullish(), page_age: z.string().nullish() })), z.looseObject({ error_code: z.string() })]),
});
const AnthropicTextSchema = z.looseObject({ type: z.literal('text'), text: z.string(), citations: z.array(z.looseObject({ url: z.string().optional(), title: z.string().nullish(), cited_text: z.string().optional() })).nullish() });
/** A Messages API answer: results from its `web_search_tool_result` blocks, described by the passages its text cites;
 * the answer is the text after the last search (what came before announces the search). */
export function parseAnthropicSearch(body: unknown): WebSearchAnswer {
  const blocks = AnthropicResponseSchema.parse(body).content;
  const found = collected();
  const failures: string[] = [];
  let answerFrom = 0;
  blocks.forEach((block, index) => {
    const results = AnthropicResultsSchema.safeParse(block);
    if (!results.success) return;
    answerFrom = index + 1;
    if (!Array.isArray(results.data.content)) { failures.push(results.data.content.error_code); return; }
    for (const result of results.data.content) if (result.type === 'web_search_result' && result.url) found.add(result.url, result.title, result.page_age);
  });
  const text = blocks.flatMap(block => { const parsed = AnthropicTextSchema.safeParse(block); return parsed.success ? [parsed.data] : []; });
  for (const block of text) for (const citation of block.citations ?? []) if (citation.url && citation.cited_text) found.cite(citation.url, citation.title, citation.cited_text);
  const hits = found.hits();
  if (!hits.length && failures.length) throw new Error(`Anthropic's search failed: ${failures.join(', ')}`);
  const after = blocks.slice(answerFrom).flatMap(block => { const parsed = AnthropicTextSchema.safeParse(block); return parsed.success ? [parsed.data.text] : []; }).join('').trim();
  const answer = after || text.map(block => block.text).join('').trim();
  return { answer: answer || null, results: hits };
}

const OpenAIResponseSchema = z.looseObject({ status: z.string().optional(), error: z.looseObject({ message: z.string() }).nullish(), output: z.array(z.looseObject({ type: z.string() })) });
const OpenAICallSchema = z.looseObject({ type: z.literal('web_search_call'), action: z.looseObject({ sources: z.array(z.looseObject({ url: z.string().optional() })).nullish() }).nullish() });
const OpenAIMessageSchema = z.looseObject({
  type: z.literal('message'),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional(), annotations: z.array(z.looseObject({ type: z.string(), url: z.string().optional(), title: z.string().nullish(), start_index: z.number().optional(), end_index: z.number().optional() })).nullish() })),
});
/** A Responses API answer: results from the output text's `url_citation` annotations (described by the span each
 * cites), then the search calls' other sources; the answer is the output text. */
export function parseOpenAISearch(body: unknown): WebSearchAnswer {
  const response = OpenAIResponseSchema.parse(body);
  if (response.status === 'failed') throw new Error(`OpenAI's response failed: ${response.error?.message ?? 'no reason given'}`);
  const found = collected();
  const texts: string[] = [];
  for (const item of response.output) {
    const message = OpenAIMessageSchema.safeParse(item);
    if (!message.success) continue;
    for (const part of message.data.content) {
      if (part.type !== 'output_text' || part.text === undefined) continue;
      texts.push(part.text);
      for (const annotation of part.annotations ?? []) {
        if (annotation.type === 'url_citation' && annotation.url) found.cite(annotation.url, annotation.title, part.text.slice(annotation.start_index ?? 0, annotation.end_index ?? 0));
      }
    }
  }
  for (const item of response.output) {
    const call = OpenAICallSchema.safeParse(item);
    if (call.success) for (const source of call.data.action?.sources ?? []) if (source.url) found.add(source.url, null);
  }
  const answer = texts.join('\n\n').trim();
  return { answer: answer || null, results: found.hits() };
}

const GeminiResponseSchema = z.looseObject({
  candidates: z.array(z.looseObject({
    content: z.looseObject({ parts: z.array(z.looseObject({ text: z.string().optional(), thought: z.boolean().optional() })).optional() }).optional(),
    groundingMetadata: z.looseObject({
      groundingChunks: z.array(z.looseObject({ web: z.looseObject({ uri: z.string().optional(), title: z.string().nullish() }).optional() })).optional(),
      groundingSupports: z.array(z.looseObject({ segment: z.looseObject({ text: z.string().optional() }).optional(), groundingChunkIndices: z.array(z.number()).optional() })).optional(),
    }).optional(),
  })).optional(),
});
/** A generateContent answer: results from its grounding chunks' web sources, described by the answer segments each
 * supports; the answer is the candidate's text. */
export function parseGeminiSearch(body: unknown): WebSearchAnswer {
  const candidate = GeminiResponseSchema.parse(body).candidates?.[0];
  const found = collected();
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  for (const chunk of chunks) if (chunk.web?.uri) found.add(chunk.web.uri, chunk.web.title);
  for (const support of candidate?.groundingMetadata?.groundingSupports ?? []) {
    for (const index of support.groundingChunkIndices ?? []) {
      const web = chunks[index]?.web;
      if (web?.uri && support.segment?.text) found.cite(web.uri, web.title, support.segment.text);
    }
  }
  const answer = (candidate?.content?.parts ?? []).flatMap(part => part.thought || part.text === undefined ? [] : [part.text]).join('').trim();
  return { answer: answer || null, results: found.hits() };
}

type SearchCall = { url: string; headers: Record<string, string>; payload: Record<string, unknown>; parse(body: unknown): WebSearchAnswer };
/** The request for `model`'s provider: `key` is its API key or OAuth access token. */
function searchCall(model: Model<Api>, auth: ModelAuth, key: string, subscription: boolean, prompt: string): SearchCall {
  const base = (auth.baseUrl ?? model.baseUrl).replace(/\/+$/u, '');
  const headers = { 'content-type': 'application/json', accept: 'application/json', ...model.headers, ...auth.headers };
  const tokens = model.reasoning ? REASONING_ANSWER_TOKENS : ANSWER_TOKENS;
  switch (model.provider) {
    case 'anthropic': return {
      url: `${base}/v1/messages`,
      // A subscription request is sent as pi-ai sends one (Claude Code's identity), then shaped as Claude Code's.
      headers: { ...headers, 'anthropic-version': '2023-06-01', ...(subscription
        ? { authorization: `Bearer ${key}`, 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20', 'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}`, 'x-app': 'cli', 'anthropic-dangerous-direct-browser-access': 'true' }
        : { 'x-api-key': key }) },
      payload: {
        model: model.id, max_tokens: ANSWER_TOKENS,
        ...(subscription ? { system: [{ type: 'text', text: CLAUDE_CODE_INSTRUCTION }] } : {}),
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: ANTHROPIC_MAX_SEARCHES }],
      },
      parse: parseAnthropicSearch,
    };
    case 'openai': return {
      url: `${base}/responses`,
      headers: { ...headers, authorization: `Bearer ${key}` },
      payload: {
        model: model.id, input: prompt, store: false,
        tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'],
        // Web search needs more than minimal reasoning; a ChatGPT sign-in refuses an output limit (as pi-ai omits it).
        ...(model.reasoning ? { reasoning: { effort: 'low' } } : {}),
        ...(subscription ? {} : { max_output_tokens: tokens }),
      },
      parse: parseOpenAISearch,
    };
    case 'google': return {
      url: `${base}/models/${encodeURIComponent(model.id)}:generateContent`,
      headers: { ...headers, 'x-goog-api-key': key },
      payload: { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: tokens } },
      parse: parseGeminiSearch,
    };
    default: throw new Error(`${model.provider} has no built-in web search`);
  }
}

const ProviderErrorSchema = z.looseObject({ error: z.looseObject({ message: z.string() }) });
/** Searches with `model`'s built-in search tool in one request; the provider's refusal or an unreadable answer ends as
 * a `webSearchError` naming it. Throws only when `signal` aborts. */
export async function searchWithModel(model: Model<Api>, auth: ModelAuth, subscription: boolean, search: WebSearchRequest, transport: WebSearchTransport, signal?: AbortSignal): Promise<WebSearchEvent> {
  try {
    if (!auth.apiKey) throw new Error(`The ${model.provider} account has no key`);
    const prompt = `Search the web for: ${search.query}\n\nThen answer from what you found in a few sentences at most.`;
    const call = searchCall(model, auth, auth.apiKey, subscription, prompt);
    const payload = await transport.onPayload(call.payload, model) ?? call.payload;
    const response = await transport.fetch(call.url, { method: 'POST', headers: call.headers, body: JSON.stringify(payload), ...(signal ? { signal } : {}) });
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = undefined; }
    if (!response.ok) {
      const refusal = ProviderErrorSchema.safeParse(body);
      throw new Error(`${response.status} ${refusal.success ? refusal.data.error.message : text.slice(0, 300)}`);
    }
    if (body === undefined) throw new Error(`The provider answered with no JSON: ${text.slice(0, 300)}`);
    const found = call.parse(body);
    return { type: 'webSearch', found: { answer: found.answer, results: found.results.slice(0, search.limit) } };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { type: 'webSearchError', errorMessage: error instanceof z.ZodError ? `The provider's answer has an unexpected shape: ${z.prettifyError(error)}` : error instanceof Error ? error.message : String(error) };
  }
}
