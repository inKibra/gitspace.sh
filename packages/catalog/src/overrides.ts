import { Result, TaggedError } from 'better-result';
import { z } from 'zod';
import overrides from './models.gitspace.json' with { type: 'json' };
import { CatalogModelSchema, CatalogSchema, type Catalog, type CatalogModel, type CatalogModelOverride, type CatalogOverride } from './schema.js';

export class CatalogValidationError extends TaggedError('CatalogValidationError')<{ message: string }> {}

const metadata = CatalogModelSchema.pick({ name: true, cost: true, hidden: true }).partial().strict();
const bedrock = CatalogModelSchema.pick({ id: true, name: true, provider: true, api: true, baseUrl: true, reasoning: true, input: true, cost: true, contextWindow: true, maxTokens: true, hidden: true }).partial().strict();
export const GitSpaceModelOverridesSchema = z.record(z.string(), z.record(z.string(), z.unknown())).superRefine((providers, context) => {
  for (const [provider, rows] of Object.entries(providers)) for (const [id, row] of Object.entries(rows)) {
    const parsed = (provider === 'amazon-bedrock' ? bedrock : metadata).safeParse(row);
    if (!parsed.success) context.addIssue({ code: 'custom', path: [provider, id], message: parsed.error.message });
  }
}).transform(providers => Object.fromEntries(Object.entries(providers).map(([provider, rows]) => [provider, Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, (provider === 'amazon-bedrock' ? bedrock : metadata).parse(row)]))])));
export const GITSPACE_MODEL_OVERRIDES: CatalogOverride = GitSpaceModelOverridesSchema.parse(overrides);

/** Explicit patches use shallow row replacement, including entire rate cards. */
export function applyCatalogOverrides(catalog: Catalog, patches: CatalogOverride = GITSPACE_MODEL_OVERRIDES): Result<Catalog, CatalogValidationError> {
  const merged: Catalog = {};
  for (const [provider, models] of Object.entries(catalog)) merged[provider] = { ...models };
  for (const [provider, models] of Object.entries(patches)) {
    const target = merged[provider] ??= {};
    for (const [id, patch] of Object.entries(models)) {
      const previous = target[id];
      // Partial fixes describe existing rows, not new model definitions. A provider
      // catalog can intentionally be smaller than the bundled upstream catalog.
      if (!previous && patch.id === undefined) continue;
      const parsed = CatalogSchema.safeParse({ [provider]: { [id]: { ...previous, ...patch } } });
      if (!parsed.success) return Result.err(new CatalogValidationError({ message: parsed.error.message }));
      const row = parsed.data[provider]?.[id];
      if (row) target[id] = row;
    }
  }
  const parsed = CatalogSchema.safeParse(merged);
  return parsed.success ? Result.ok(parsed.data) : Result.err(new CatalogValidationError({ message: parsed.error.message }));
}

/** Parse with the consumer's schema to retain its exact API union and extra fields. */
export function applyModelOverride<S extends z.ZodType>(model: z.input<S>, patch: CatalogModelOverride, schema: S): Result<z.output<S>, CatalogValidationError> {
  const base = z.record(z.string(), z.unknown()).safeParse(model);
  if (!base.success) return Result.err(new CatalogValidationError({ message: base.error.message }));
  const parsed = schema.safeParse({ ...base.data, ...patch });
  return parsed.success ? Result.ok(parsed.data) : Result.err(new CatalogValidationError({ message: parsed.error.message }));
}

/** Hidden rows remain addressable for historical runs, but never enter a picker. */
export function visibleCatalogModels(catalog: Catalog): CatalogModel[] {
  return Object.values(catalog).flatMap(models => Object.values(models).filter(model => !model.hidden));
}
