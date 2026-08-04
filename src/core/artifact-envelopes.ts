import { z } from 'zod';

export const reportKindSchema = z.enum(['praise', 'good-pattern', 'frustration', 'workflow-quirk', 'gitspace-quirk']);

export const reportAttachmentSchema = z.object({
  type: z.string(),
  ref: z.string(),
  label: z.string().optional(),
  snapshotRef: z.string().optional(),
});

export const reportSchema = z.object({
  kind: reportKindSchema,
  surface: z.string(),
  note: z.string(),
  quote: z.string().optional(),
  rating: z.number().int().min(1).max(5).optional(),
  attachments: z.array(reportAttachmentSchema).optional(),
});
export type ReportItem = z.infer<typeof reportSchema>;
export type ReportKind = ReportItem['kind'];
export type ReportAttachment = z.infer<typeof reportAttachmentSchema>;

export const dashboardPanelSchema = z.object({
  id: z.string(),
  app: z.string(),
  title: z.string(),
  data: z.string().optional(),
  size: z.enum(['half', 'full']).optional(),
  scope: z.enum(['workspace', 'chain']).optional(),
  source: z.string().optional(),
  updated: z.string().optional(),
  stale: z.boolean().optional(),
});
export const dashboardSchema = z.object({
  name: z.string().optional(),
  panels: z.array(dashboardPanelSchema),
});
export type DashboardPanelDef = z.infer<typeof dashboardPanelSchema>;
export type DashboardDoc = z.infer<typeof dashboardSchema>;
