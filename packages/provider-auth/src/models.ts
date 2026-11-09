import { z } from 'zod';
import { CLAUDE_CODE_USER_AGENT } from './claude-code';
import { request } from './refresh';

/** A model as its provider lists it for one account: one the account can use, and what it accepts. */
export const accountModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** The provider's model line (`fable`, `mythos`, `opus`), null when it names none. */
  line: z.string().nullable(),
  /** Null when the provider does not say; the model's catalog row decides. */
  contextWindow: z.number().int().positive().nullable(),
  maxTokens: z.number().int().positive().nullable(),
  images: z.boolean(),
  /** Null for a model without thinking; `off` is whether it can be turned off. */
  thinking: z.object({ adaptive: z.boolean(), off: z.boolean() }).nullable(),
  /** The effort levels it accepts, in the provider's order (lowest first). */
  efforts: z.array(z.string()),
});
export type AccountModel = z.infer<typeof accountModelSchema>;

/** Providers that list an account's models; another provider's accounts use every catalog model. */
export const ACCOUNT_MODEL_PROVIDERS: Readonly<Record<string, true>> = { anthropic: true };

/** A credential as the list is read with: a subscription's access token, or an API key. */
export type ModelListCredential = { provider: string; type: 'oauth'; access: string } | { provider: string; type: 'api_key'; key: string };

const supported = z.object({ supported: z.boolean() }).loose();
const anthropicModelSchema = z.object({
  id: z.string().min(1), display_name: z.string().min(1), line: z.string().nullish(),
  max_input_tokens: z.number().int().positive().nullish(), max_tokens: z.number().int().positive().nullish(),
  capabilities: z.object({
    image_input: supported.nullish(),
    thinking: supported.extend({ types: z.object({ adaptive: supported.nullish(), disabled: supported.nullish() }).loose().nullish() }).nullish(),
    effort: z.record(z.string(), z.union([z.boolean(), supported])).nullish(),
  }).loose().nullish(),
}).loose();
const anthropicPageSchema = z.object({ data: z.array(anthropicModelSchema), has_more: z.boolean(), last_id: z.string().nullish() });
/** Models per page: one page of Anthropic's full model descriptions stays inside `request`'s 64 KiB cap. */
const PAGE = 20;
/** Pages read at most: 200 models, far past any account's list. */
const PAGES = 10;

/** The models one account can use, newest first, as its provider lists them for it. Throws `ProviderRefreshError` when
 * the read fails; a provider outside `ACCOUNT_MODEL_PROVIDERS` is a caller error. */
export async function listAccountModels(credential: ModelListCredential, fetcher: typeof fetch = fetch): Promise<AccountModel[]> {
  if (credential.provider !== 'anthropic') throw new Error(`${credential.provider} does not list an account's models`);
  const headers: Record<string, string> = credential.type === 'oauth'
    ? { Authorization: `Bearer ${credential.access}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': CLAUDE_CODE_USER_AGENT }
    : { 'x-api-key': credential.key };
  const models: AccountModel[] = [];
  let after: string | null = null;
  for (let page = 0; page < PAGES; page++) {
    const raw = await request('anthropic', `https://api.anthropic.com/v1/models?limit=${PAGE}${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, { headers: { ...headers, 'anthropic-version': '2023-06-01', Accept: 'application/json' } }, fetcher);
    const parsed = anthropicPageSchema.parse(raw);
    for (const model of parsed.data) {
      const thinking = model.capabilities?.thinking;
      const efforts = Object.entries(model.capabilities?.effort ?? {}).flatMap(([level, value]) => level !== 'supported' && typeof value === 'object' && value.supported ? [level] : []);
      models.push({
        id: model.id, name: model.display_name, line: model.line ?? null,
        contextWindow: model.max_input_tokens ?? null, maxTokens: model.max_tokens ?? null,
        images: model.capabilities?.image_input?.supported ?? false,
        thinking: thinking?.supported ? { adaptive: thinking.types?.adaptive?.supported ?? false, off: thinking.types?.disabled?.supported ?? true } : null,
        efforts,
      });
    }
    if (!parsed.has_more || !parsed.last_id) return models;
    after = parsed.last_id;
  }
  return models;
}
