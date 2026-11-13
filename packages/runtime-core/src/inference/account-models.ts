import { isModelType, type AnyModel, type Api, type Model, type Provider } from '@earendil-works/pi-ai';
import { z } from 'zod';
import type { AccountModel } from '@gitspace/provider-auth';
import type { InferenceProfile } from '@gitspace/protocol/inference';
import { inferenceProviderSource, profileProviders } from './attempts.js';
import { StoredPiModelSchema } from './models-store.js';
import { modelAvailability, type CredentialAccount } from './selection.js';

/** A profile's source models by provider (`catalogRows`): pi-ai's, pi.dev's and its accounts' own, before the profile's
 * settings apply. The vault builds them; every catalog of the profile reads them. They cross RPC as JSON
 * (`ProfileCatalogSchema` parses it), which Cloudflare's serializable types cannot describe. */
export type ProfileCatalog = Readonly<Record<string, readonly AnyModel[]>>;
export const ProfileCatalogSchema = z.record(z.string(), z.array(StoredPiModelSchema));

/** Mythos is Fable with fewer safeguards (Anthropic's model pages): a Mythos model takes a Fable row's settings. */
const SAME_MODEL: Readonly<Record<string, string>> = { mythos: 'fable' };
/** Anthropic's effort levels as pi names its thinking levels; pi's `minimal` has no Anthropic effort. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** A model an account lists that no catalog has: the account's facts (name, limits, images, thinking) over the row of
 * the newest model of its line the catalog has, which gives what the list does not (request settings, prompt cache,
 * input limits, prices as an estimate until the catalog publishes the model's own). */
function listedRow(listed: AccountModel, template: Model<Api>): Model<Api> {
  const thinkingLevelMap = listed.thinking === null ? template.thinkingLevelMap : {
    ...(listed.thinking.off ? {} : { off: null }), minimal: null,
    ...Object.fromEntries(EFFORT_LEVELS.map(level => [level, listed.efforts.includes(level) ? level : null])),
  };
  const row: Model<Api> = {
    ...template, id: listed.id, name: listed.name,
    contextWindow: listed.contextWindow ?? template.contextWindow, maxTokens: listed.maxTokens ?? template.maxTokens,
    input: listed.images ? ['text', 'image'] : ['text'], reasoning: listed.thinking !== null,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
  // Thinking that cannot be turned off is adaptive only: pi-ai then never sends `thinking: disabled`, which it refuses.
  if (row.api === 'anthropic-messages' && listed.thinking) row.compat = { ...template.compat, forceAdaptiveThinking: listed.thinking.adaptive && !listed.thinking.off };
  return row;
}

/** `rows` (a provider's chat and other models) with a row for each model `listed` names that `rows` lacks. `listed` is
 * newest first, as providers list them, so a line's first catalogued model is its newest. A model whose line has no
 * catalogued model is left out: nothing says how to send its requests. */
export function withListedModels(rows: readonly AnyModel[], listed: readonly AccountModel[]): AnyModel[] {
  const catalogued = new Map(rows.filter((row): row is Model<Api> => isModelType(row, 'chat')).map(row => [row.id, row]));
  const added: AnyModel[] = [];
  for (const model of listed) {
    if (catalogued.has(model.id) || added.some(row => row.id === model.id)) continue;
    const line = model.line === null ? null : SAME_MODEL[model.line] ?? model.line;
    const sibling = line === null ? undefined : listed.find(other => other.line !== null && (SAME_MODEL[other.line] ?? other.line) === line && catalogued.has(other.id));
    const template = sibling && catalogued.get(sibling.id);
    if (!template) continue;
    added.push(listedRow(model, template));
  }
  return [...rows, ...added];
}

/** `provider` listing `read()`'s rows in place of its own when there are any: the vault's profile catalog. */
export function withCatalogRows(provider: Provider, read: () => readonly AnyModel[] | undefined): Provider {
  const all = () => [...read() ?? provider.getAllModels?.() ?? provider.getModels()];
  return { ...provider, getModels: () => all().filter(model => isModelType(model, 'chat')), getAllModels: all };
}

/** The models `list` gives of each provider an account of the profile has, from the vault's `catalog`: each one an
 * account offers, and for one no account can serve now, when the soonest can again and why. */
function offeredModels<T extends AnyModel>(settings: InferenceProfile['settings'], catalog: ProfileCatalog, accounts: readonly CredentialAccount[], now: number, list: (provider: Provider) => readonly T[]) {
  const providers = profileProviders(settings, inferenceProviderSource().map(provider => withCatalogRows(provider, () => catalog[provider.id])));
  return providers.filter(provider => accounts.some(account => account.provider === provider.id)).flatMap(provider => list(provider).flatMap(model => {
    const { listed, out } = modelAvailability(accounts, provider.id, model.id, now);
    return listed ? [{ model, unavailable: out && { until: new Date(out.until).toISOString(), reason: out.reason } }] : [];
  }));
}

/** The chat models a profile offers, for a picker (`offeredModels`). */
export function listCloudModels(settings: InferenceProfile['settings'], catalog: ProfileCatalog, accounts: readonly CredentialAccount[], now: number) {
  return offeredModels(settings, catalog, accounts, now, provider => {
    const models = provider.getModels();
    return provider.filterModels?.(models, undefined) ?? models;
  }).map(({ model, unavailable }) => ({ provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow, images: model.input.includes('image'), unavailable }));
}

/** The image models a profile offers, for the Images service's picker (`offeredModels`); `images` says whether a model
 * takes input images. */
export function listCloudImageModels(settings: InferenceProfile['settings'], catalog: ProfileCatalog, accounts: readonly CredentialAccount[], now: number) {
  return offeredModels(settings, catalog, accounts, now, provider => {
    const models = (provider.getAllModels?.() ?? []).filter(model => isModelType(model, 'image'));
    return provider.filterAllModels?.(models, undefined).filter(model => isModelType(model, 'image')) ?? models;
  }).map(({ model, unavailable }) => ({ provider: model.provider, id: model.id, name: model.name, contextWindow: null, images: model.input.includes('image'), unavailable }));
}
