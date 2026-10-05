import { z } from 'zod';

const rates = {
  input: z.number().nonnegative(), output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(),
};
export const CatalogCostSchema = z.object({
  ...rates,
  longContext: z.object({ ...rates, inputThreshold: z.number().nonnegative(), inputThresholdInclusive: z.boolean().optional() }).optional(),
  timeBased: z.object({
    offPeakMultiplier: z.number().nonnegative(),
    peakWindows: z.array(z.object({ weekdays: z.array(z.number().int().min(0).max(6)), startMinute: z.number().int().min(0).max(1440), endMinute: z.number().int().min(0).max(1440) })),
    effectiveRates: z.array(z.object({ ...rates, effectiveFrom: z.number(), longContext: z.object({ ...rates, inputThreshold: z.number().nonnegative(), inputThresholdInclusive: z.boolean().optional() }).optional() })).optional(),
  }).optional(),
});
export const EditToolSchema = z.enum(['edit', 'apply_patch']);
export type EditTool = z.infer<typeof EditToolSchema>;

// Compatibility/identity vocabularies belong to transports. Keep their JSON intact,
// but never admit functions or runtime objects into persisted catalog metadata.
export const CatalogModelSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), provider: z.string().min(1),
  api: z.string().min(1), baseUrl: z.string(), reasoning: z.boolean(),
  input: z.array(z.enum(['text', 'image'])), cost: CatalogCostSchema,
  contextWindow: z.number().positive().nullable(), maxTokens: z.number().positive().nullable(),
  hidden: z.boolean().optional(), editTool: EditToolSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  requestModelId: z.string().min(1).optional(),
  guardrailIdentifier: z.string().optional(), guardrailVersion: z.string().optional(),
  guardrailTrace: z.enum(['enabled', 'disabled', 'enabled_full']).optional(),
  requestMetadata: z.record(z.string(), z.string()).optional(),
}).catchall(z.json());
export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export const CatalogModelOverrideSchema = CatalogModelSchema.partial();
export type CatalogModelOverride = z.infer<typeof CatalogModelOverrideSchema>;
export const CatalogOverrideSchema = z.record(z.string(), z.record(z.string(), CatalogModelOverrideSchema));
export type CatalogOverride = z.infer<typeof CatalogOverrideSchema>;
export const CatalogSchema = z.record(z.string(), z.record(z.string(), CatalogModelSchema)).superRefine((catalog, context) => {
  for (const [provider, models] of Object.entries(catalog)) {
    for (const [id, model] of Object.entries(models)) {
      if (model.provider !== provider || model.id !== id) context.addIssue({ code: 'custom', path: [provider, id], message: 'Catalog keys must match model provider and id' });
    }
  }
});
export type Catalog = z.infer<typeof CatalogSchema>;
