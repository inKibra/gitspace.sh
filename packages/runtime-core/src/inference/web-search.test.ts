import { afterEach, expect, it, vi } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { CLAUDE_CODE_USER_AGENT } from '@gitspace/provider-auth';
import { createAttemptRunner, type AttemptEvent } from './attempts';
import { parseAnthropicSearch, parseGeminiSearch, parseOpenAISearch } from './web-search';

// Response bodies as the providers document them (Anthropic's web search tool, OpenAI's web search guide with sources,
// Gemini's grounding with Google Search).
const anthropicAnswer = {
  role: 'assistant',
  content: [
    { type: 'text', text: "I'll search for when Claude Shannon was born." },
    { type: 'server_tool_use', id: 'srvtoolu_01WYG3ziw53XMcoyKL4XcZmE', name: 'web_search', input: { query: 'claude shannon birth date' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_01WYG3ziw53XMcoyKL4XcZmE', content: [
      { type: 'web_search_result', url: 'https://en.wikipedia.org/wiki/Claude_Shannon', title: 'Claude Shannon - Wikipedia', encrypted_content: 'EqgfCioIARgBIiQ3YTAwMjY1Mi1mZjM5LTQ1NGUtODgxNC1kNjNjNTk1ZWI3Y...', page_age: 'April 30, 2025' },
      { type: 'web_search_result', url: 'https://www.britannica.com/biography/Claude-Shannon', title: 'Claude Shannon | Britannica', encrypted_content: 'Eo8BCioIAhgBIiQyYjQ0OWJmZi1lNm...' },
    ] },
    { text: 'Based on the search results, ', type: 'text' },
    { text: 'Claude Shannon was born on April 30, 1916, in Petoskey, Michigan', type: 'text', citations: [
      { type: 'web_search_result_location', url: 'https://en.wikipedia.org/wiki/Claude_Shannon', title: 'Claude Shannon - Wikipedia', encrypted_index: 'Eo8BCioIAhgBIiQyYjQ0OWJmZi1lNm..', cited_text: 'Claude Elwood Shannon (April 30, 1916 – February 24, 2001) was an American mathematician, electrical engineer, computer scientist, cryptographer and i...' },
    ] },
  ],
  id: 'msg_a930390d3a',
  usage: { input_tokens: 6039, output_tokens: 931, server_tool_use: { web_search_requests: 1 } },
  stop_reason: 'end_turn',
};

it("reads Anthropic's search results, the passages its answer cites from them, and the answer after the search", () => {
  expect(parseAnthropicSearch(anthropicAnswer)).toEqual({
    answer: 'Based on the search results, Claude Shannon was born on April 30, 1916, in Petoskey, Michigan',
    results: [
      { title: 'Claude Shannon - Wikipedia', url: 'https://en.wikipedia.org/wiki/Claude_Shannon', lastModified: 'April 30, 2025', description: 'Claude Elwood Shannon (April 30, 1916 – February 24, 2001) was an American mathematician, electrical engineer, computer scientist, cryptographer and i...' },
      { title: 'Claude Shannon | Britannica', url: 'https://www.britannica.com/biography/Claude-Shannon' },
    ],
  });
  expect(() => parseAnthropicSearch({ content: [{ type: 'web_search_tool_result', tool_use_id: 'srvtoolu_a93jad', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }] })).toThrow('max_uses_exceeded');
});

it("reads OpenAI's cited sources with the span each supports, then the search's other sources", () => {
  const text = "Spain won Euro 2024, defeating England 2-1 in the final. This victory marks Spain's record fourth European Championship title.";
  expect(parseOpenAISearch({
    id: 'resp_67c9fa0502748190', object: 'response', status: 'completed',
    output: [
      { type: 'web_search_call', id: 'ws_67c9fa0502748190b7dd390736892e100be649c1a5ff9609', status: 'completed', action: { type: 'search', query: 'who won euro 2024', sources: [{ type: 'url', url: 'https://www.uefa.com/euro2024/news/spain-wins-euro-2024' }, { type: 'url', url: 'https://www.aljazeera.com/sports/euro-2024-final' }] } },
      { id: 'msg_67c9fa077e288190af08fdffda2e34f20be649c1a5ff9609', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [
        { type: 'url_citation', start_index: 0, end_index: 56, url: 'https://www.aljazeera.com/sports/euro-2024-final', title: 'Euro 2024 final: Spain beat England' },
      ] }] },
    ],
  })).toEqual({
    answer: text,
    results: [
      { title: 'Euro 2024 final: Spain beat England', url: 'https://www.aljazeera.com/sports/euro-2024-final', description: 'Spain won Euro 2024, defeating England 2-1 in the final.' },
      { title: 'https://www.uefa.com/euro2024/news/spain-wins-euro-2024', url: 'https://www.uefa.com/euro2024/news/spain-wins-euro-2024' },
    ],
  });
});

it("reads Gemini's grounding sources, described by the answer segments each supports", () => {
  expect(parseGeminiSearch({
    candidates: [{
      content: { parts: [{ text: "Spain won Euro 2024, defeating England 2-1 in the final. This victory marks Spain's record fourth European Championship title." }], role: 'model' },
      groundingMetadata: {
        webSearchQueries: ['UEFA Euro 2024 winner', 'who won euro 2024'],
        searchEntryPoint: { renderedContent: '<!-- HTML and CSS for the search widget -->' },
        groundingChunks: [
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/aljazeera', title: 'aljazeera.com' } },
          { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/uefa', title: 'uefa.com' } },
        ],
        groundingSupports: [
          { segment: { startIndex: 0, endIndex: 56, text: 'Spain won Euro 2024, defeating England 2-1 in the final.' }, groundingChunkIndices: [0] },
          { segment: { startIndex: 57, endIndex: 124, text: "This victory marks Spain's record fourth European Championship title." }, groundingChunkIndices: [0, 1] },
        ],
      },
    }],
  })).toEqual({
    answer: "Spain won Euro 2024, defeating England 2-1 in the final. This victory marks Spain's record fourth European Championship title.",
    results: [
      { title: 'aljazeera.com', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/aljazeera', description: "Spain won Euro 2024, defeating England 2-1 in the final. … This victory marks Spain's record fourth European Championship title." },
      { title: 'uefa.com', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/uefa', description: "This victory marks Spain's record fourth European Championship title." },
    ],
  });
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

it("searches with a Claude subscription as Claude Code's request, with Anthropic's search tool, trimmed to the limit", async () => {
  const sent: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(await new Response(init?.body).text()) });
    return Response.json(anthropicAnswer);
  });
  const model: Model<Api> = { id: 'claude-haiku-4-5', name: 'Haiku', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 };
  const run = createAttemptRunner({ providers: () => builtinProviders().filter(provider => provider.id === 'anthropic') });
  const events: AttemptEvent[] = [];
  for await (const event of run({
    method: 'webSearch', model, search: { query: 'claude shannon birth date', limit: 1 }, settings: {},
    credential: { id: 'account', provider: 'anthropic', revision: 1, credential: { type: 'oauth', access: 'sk-ant-oat01-x', expires: Date.now() + 3_600_000 } },
    claude: { profileId: 'profile', sessionId: 'session' },
  })) events.push(event);
  const request = sent[0]!;
  expect(request.url).toBe('https://api.anthropic.com/v1/messages');
  expect(request.headers.get('authorization')).toBe('Bearer sk-ant-oat01-x');
  expect(request.headers.get('user-agent')).toBe(CLAUDE_CODE_USER_AGENT);
  expect(request.headers.get('anthropic-beta')).toContain('claude-code-20250219');
  expect(request.body).toMatchObject({
    model: 'claude-haiku-4-5',
    system: [{ type: 'text', text: expect.stringMatching(/^x-anthropic-billing-header: cc_version=.*cch=[0-9a-f]{5};$/u) }, { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    metadata: { user_id: expect.stringContaining('"session_id":"session"') },
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
  });
  expect(events.at(-1)).toEqual({ type: 'webSearch', found: {
    answer: 'Based on the search results, Claude Shannon was born on April 30, 1916, in Petoskey, Michigan',
    results: [expect.objectContaining({ url: 'https://en.wikipedia.org/wiki/Claude_Shannon' })],
  } });
  expect(events).toContainEqual(expect.objectContaining({ type: 'response', status: 200 }));
});
