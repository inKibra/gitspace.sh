import { isModelType, type AnyModel, type Api, type Model, type ModelCost, type Provider } from '@earendil-works/pi-ai';
import { CatalogModelSchema, GITSPACE_MODEL_OVERRIDES, selectEditTool, type CatalogModelOverride, type EditToolOverrides } from '@gitspace/catalog';
import { z } from 'zod';

// This boundary accepts only display/pricing/capability metadata. Endpoint, API,
// provider, headers, and transport compatibility remain the provider's authority.
const MetadataSchema = z.object({
  name: z.string().min(1).optional(), hidden: z.boolean().optional(),
  reasoning: z.boolean().optional(), input: z.array(z.enum(['text', 'image'])).optional(),
  contextWindow: z.number().positive().nullable().optional(), maxTokens: z.number().positive().nullable().optional(),
  cost: CatalogModelSchema.shape.cost.optional(),
});

function piCost(cost: z.infer<typeof CatalogModelSchema.shape.cost>): ModelCost {
  let { input, output, cacheRead, cacheWrite, longContext } = cost;
  let multiplier = 1;
  if (cost.timeBased) {
    const now = new Date();
    let effective: NonNullable<NonNullable<typeof cost.timeBased>['effectiveRates']>[number] | undefined;
    for (const rate of cost.timeBased.effectiveRates ?? []) {
      if (rate.effectiveFrom <= now.getTime() && (!effective || rate.effectiveFrom > effective.effectiveFrom)) effective = rate;
    }
    if (effective) ({ input, output, cacheRead, cacheWrite, longContext } = effective);
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    const peak = cost.timeBased.peakWindows.some(window => window.weekdays.includes(now.getUTCDay()) && minute >= window.startMinute && minute < window.endMinute);
    if (!peak) multiplier = cost.timeBased.offPeakMultiplier;
  }
  return {
    input: input * multiplier, output: output * multiplier, cacheRead: cacheRead * multiplier, cacheWrite: cacheWrite * multiplier,
    ...(longContext ? { tiers: [{
      inputTokensAbove: longContext.inputThresholdInclusive ? longContext.inputThreshold - 1 : longContext.inputThreshold,
      input: longContext.input * multiplier, output: longContext.output * multiplier, cacheRead: longContext.cacheRead * multiplier, cacheWrite: longContext.cacheWrite * multiplier,
    }] } : {}),
  };
}

function patchChat(model: Model<Api>, patch: CatalogModelOverride | undefined): Model<Api> {
  if (!patch) return model;
  const metadata = MetadataSchema.parse(patch);
  return {
    ...model,
    ...(metadata.name !== undefined ? { name: metadata.name } : {}),
    ...(metadata.reasoning !== undefined ? { reasoning: metadata.reasoning } : {}),
    ...(metadata.input !== undefined ? { input: metadata.input } : {}),
    ...(metadata.cost !== undefined ? { cost: piCost(metadata.cost) } : {}),
    // Pi requires numeric limits. Unknown limits from the legacy catalog do not
    // erase the canonical provider's known limits or fabricate sentinel budgets.
    ...(metadata.contextWindow != null ? { contextWindow: metadata.contextWindow } : {}),
    ...(metadata.maxTokens != null ? { maxTokens: metadata.maxTokens } : {}),
  };
}

/** Apply trusted metadata without allowing a catalog row to redirect credentials. */
export function applyProviderCatalog(provider: Provider): Provider {
  const patches = GITSPACE_MODEL_OVERRIDES[provider.id] ?? {};
  const hidden = new Set(Object.entries(patches).filter(([, patch]) => patch.hidden).map(([id]) => id));
  const getModels = (): readonly Model<Api>[] => {
    const source = provider.getModels();
    const models = source.map(model => patchChat(model, patches[model.id]));
    // Only complete Bedrock profile rows can extend this provider. Anchor all
    // dispatch fields to an existing canonical Converse model, never JSON URLs.
    if (provider.id === 'amazon-bedrock') {
      const anchor = source.find(model => model.api === 'bedrock-converse-stream');
      if (anchor) {
        const ids = new Set(models.map(model => model.id));
        for (const [id, patch] of Object.entries(patches)) {
          if (ids.has(id) || patch.id === undefined) continue;
          const parsed = CatalogModelSchema.safeParse(patch);
          if (!parsed.success || parsed.data.id !== id || parsed.data.provider !== provider.id || parsed.data.api !== anchor.api || parsed.data.contextWindow === null || parsed.data.maxTokens === null) continue;
          models.push({
            id, provider: provider.id, api: anchor.api, baseUrl: anchor.baseUrl,
            name: parsed.data.name, input: parsed.data.input, reasoning: parsed.data.reasoning,
            contextWindow: parsed.data.contextWindow, maxTokens: parsed.data.maxTokens,
            cost: piCost(parsed.data.cost),
          });
        }
      }
    }
    return models;
  };
  return {
    ...provider,
    getModels,
    getAllModels: () => {
      const all = provider.getAllModels?.();
      if (!all) return getModels();
      const chat = getModels();
      const others: AnyModel[] = all.filter(model => !isModelType(model, 'chat')).map(model => {
        const patch = patches[model.id];
        if (!patch) return model;
        const metadata = MetadataSchema.parse(patch);
        return { ...model, ...(metadata.name !== undefined ? { name: metadata.name } : {}), ...(metadata.cost !== undefined ? { cost: piCost(metadata.cost) } : {}) };
      });
      return [...chat, ...others];
    },
    filterModels: (models, credential) => (provider.filterModels?.(models, credential) ?? models).filter(model => !hidden.has(model.id)),
    filterAllModels: (models, credential) => {
      const available = provider.filterAllModels?.(models, credential) ?? models.filter(model => !isModelType(model, 'chat') || (provider.filterModels?.([model], credential).length ?? 1) > 0);
      return available.filter(model => !hidden.has(model.id));
    },
  };
}

/** The same catalog rule drives the cloud tool surface and machine dispatcher. */
export function modelEditTool(model: Pick<Model<Api>, 'provider' | 'id'>, overrides?: EditToolOverrides) {
  return selectEditTool(model, overrides);
}
