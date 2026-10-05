import { z } from 'zod';
import rules from './edit-rules.json' with { type: 'json' };
import { EditToolSchema, type EditTool } from './schema.js';

export const EditToolRulesSchema = z.object({
  version: z.literal(1), defaultTool: EditToolSchema,
  rules: z.array(z.object({ pattern: z.string(), tool: EditToolSchema })),
});
export const EDIT_TOOL_RULES = EditToolRulesSchema.parse(rules);
export const EditToolOverridesSchema = z.record(z.string(), z.record(z.string(), EditToolSchema));
export type EditToolOverrides = z.infer<typeof EditToolOverridesSchema>;
const compiledRules = EDIT_TOOL_RULES.rules.map(rule => ({ pattern: new RegExp(rule.pattern, 'i'), tool: rule.tool }));

/** Exact profile overrides win; otherwise strip vendor prefixes before family matching. */
export function selectEditTool(model: { provider: string; id: string; editTool?: EditTool }, overrides: EditToolOverrides = {}): EditTool {
  const override = overrides[model.provider]?.[model.id] ?? model.editTool;
  if (override) return override;
  const id = model.id.slice(model.id.lastIndexOf('/') + 1).replace(/^(?:(?:global|us|eu|apac)\.)?[^.]+\.(?=(?:gpt-|o\d))/i, '');
  for (const rule of compiledRules) if (rule.pattern.test(id)) return rule.tool;
  return EDIT_TOOL_RULES.defaultTool;
}
