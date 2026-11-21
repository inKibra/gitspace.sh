/**
 * The Decisions service's `cloudflare/<option>` models on Cloudflare Workers AI, billed to the platform's Cloudflare
 * account: Cloudflare's Clef (`@cf/cloudflare/clef-flash`, `@cf/cloudflare/clef`) and TypeSafe's Jev hosted there
 * (`typesafe/jev`). pi-ai's Workers AI System One transport builds each request and reads its answer and usage; its
 * `fetch` is the worker's AI binding: the REST call (`POST …/ai/run` with `{ model, input }`) runs as
 * `ai.run(model, input)` and is answered in the REST envelope, `{ success: true, result }`. The transport and pi-ai's
 * catalog rows load on the first decision, not at the worker's startup.
 */
import type { CloudflareDecisions } from '@gitspace/runtime-core/inference';
import { z } from 'zod';

type DecisionModel = '@cf/cloudflare/clef-flash' | '@cf/cloudflare/clef' | 'typesafe/jev';
type DecisionRun = { inputs: Record<string, unknown>; postProcessedOutputs: unknown };
declare global {
  /** The binding's models, with the decision models its types do not list yet. */
  interface AiModels { '@cf/cloudflare/clef-flash': DecisionRun; '@cf/cloudflare/clef': DecisionRun; 'typesafe/jev': DecisionRun }
}
/** Workers AI's model, by the selector's option (`CLOUDFLARE_DECISION_MODELS`). */
const DECISION_MODELS: Readonly<Record<string, DecisionModel>> = { 'clef-flash': '@cf/cloudflare/clef-flash', clef: '@cf/cloudflare/clef', jev: 'typesafe/jev' };
const RunRequest = z.object({ input: z.record(z.string(), z.unknown()) });

/** Runs a `cloudflare/<option>` decision on the worker's AI binding. */
export function workersAiDecisions(ai: Ai): CloudflareDecisions {
  return async (option, context, signal) => {
    const id = Object.hasOwn(DECISION_MODELS, option) ? DECISION_MODELS[option] : undefined;
    if (!id) throw new Error('Workers AI has no such decision model here');
    const [{ CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS }, { classify }] = await Promise.all([
      import('@earendil-works/pi-ai/providers/cloudflare-workers-ai.models'),
      import('@earendil-works/pi-ai/api/cloudflare-workers-ai-system-one'),
    ]);
    // The binding needs no key; the transport refuses to send without one.
    return classify(CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS[id], context, {
      apiKey: 'workers-ai-binding', ...(signal ? { signal } : {}),
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
        const request = RunRequest.parse(JSON.parse(typeof init?.body === 'string' ? init.body : 'null'));
        return Response.json({ success: true, result: await ai.run(id, request.input, init?.signal ? { signal: init.signal } : {}) });
      },
    });
  };
}
