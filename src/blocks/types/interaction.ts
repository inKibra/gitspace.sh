import { z } from 'zod';
import { defineBlock } from '../registry.js';

// ── approval-gate (permission request) ──────────────────────────────────────
export const approvalGateData = z.object({
  tool: z.string(),
  detail: z.string(),
  // defaults to Allow once / Always allow / Deny when omitted
  options: z.array(z.string()).optional(),
});
export type ApprovalGateData = z.infer<typeof approvalGateData>;
defineBlock({
  type: 'approval-gate',
  tier: 'interaction',
  description: 'A permission request the human must approve before the agent proceeds.',
  schema: approvalGateData,
});

// ── host-ui dialog ──────────────────────────────────────────────────────────
export const hostUiDialogData = z.object({
  dialog: z.enum(['select', 'confirm', 'input']),
  prompt: z.string(),
  options: z.array(z.string()).optional(),
});
export type HostUiDialogData = z.infer<typeof hostUiDialogData>;
defineBlock({
  type: 'hostui-dialog',
  tier: 'interaction',
  description: 'A host-driven dialog the agent asks: select one of options, confirm, or free-text input.',
  schema: hostUiDialogData,
});

// ── verdict-chip ────────────────────────────────────────────────────────────
export const verdictChipData = z.object({
  verdict: z.enum(['pass', 'fail', 'partial']),
  label: z.string(),
  severity: z.string().optional(),
  confidence: z.string().optional(),
});
export type VerdictChipData = z.infer<typeof verdictChipData>;
defineBlock({
  type: 'verdict-chip',
  tier: 'interaction',
  description: 'An inline pass/fail/partial verdict with optional severity and confidence.',
  schema: verdictChipData,
});

// ── checklist / todos ───────────────────────────────────────────────────────
export const checklistItem = z.object({
  text: z.string(),
  done: z.boolean(),
  evidence: z.string().optional(),
});
export const checklistData = z.object({
  title: z.string().optional(),
  items: z.array(checklistItem),
});
export type ChecklistData = z.infer<typeof checklistData>;
defineBlock({
  type: 'checklist',
  tier: 'interaction',
  description: 'A todo/checklist; items toggle through the block host.',
  schema: checklistData,
});

// ── review-gate ─────────────────────────────────────────────────────────────
export const reviewGateData = z.object({
  label: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  detail: z.string().optional(),
});
export type ReviewGateData = z.infer<typeof reviewGateData>;
defineBlock({
  type: 'review-gate',
  tier: 'interaction',
  description: 'A human gate that approves or rejects advancing past a phase/review.',
  schema: reviewGateData,
});
