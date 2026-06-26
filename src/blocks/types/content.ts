import { z } from 'zod';
import { defineBlock } from '../registry.js';

// ── markdown ──────────────────────────────────────────────────────────────
export const markdownData = z.object({
  text: z.string(),
});
export type MarkdownData = z.infer<typeof markdownData>;
defineBlock({
  type: 'markdown',
  tier: 'content',
  description: 'Prose rendered as Markdown. The default for explanatory text.',
  schema: markdownData,
});

// ── callout ───────────────────────────────────────────────────────────────
export const calloutData = z.object({
  tone: z.enum(['info', 'warning', 'success', 'danger']),
  title: z.string().optional(),
  text: z.string(),
});
export type CalloutData = z.infer<typeof calloutData>;
defineBlock({
  type: 'callout',
  tier: 'content',
  description: 'A toned aside (info/warning/success/danger) highlighting a single point.',
  schema: calloutData,
});

// ── code ──────────────────────────────────────────────────────────────────
export const codeData = z.object({
  lang: z.string().optional(),
  text: z.string(),
  startLine: z.number().int().positive().optional(),
});
export type CodeData = z.infer<typeof codeData>;
defineBlock({
  type: 'code',
  tier: 'content',
  description: 'A syntax-highlightable code block.',
  schema: codeData,
});

// ── code-ref ──────────────────────────────────────────────────────────────
export const codeRefData = z.object({
  path: z.string(),
  lines: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  snippet: z.string(),
  note: z.string().optional(),
  exemplar: z.boolean().optional(),
});
export type CodeRefData = z.infer<typeof codeRefData>;
defineBlock({
  type: 'code-ref',
  tier: 'content',
  description: 'A snippet anchored to a real file path + line range, optionally annotated.',
  schema: codeRefData,
});

// ── data-structure ────────────────────────────────────────────────────────
export const dataField = z.object({
  name: z.string(),
  type: z.string(),
  note: z.string().optional(),
});
export const dataStructureData = z.object({
  name: z.string(),
  lang: z.enum(['ts', 'rust', 'go']).optional(),
  fields: z.array(dataField),
  note: z.string().optional(),
});
export type DataStructureData = z.infer<typeof dataStructureData>;
defineBlock({
  type: 'data-structure',
  tier: 'content',
  description: 'A named record/type with typed fields — for sketching a data shape.',
  schema: dataStructureData,
});

// ── diff ──────────────────────────────────────────────────────────────────
// Carries a unified-diff patch string (git/`diff -u` format), rendered by
// @pierre/diffs (PatchDiff) in the web layer. `file` is an optional display label.
export const diffData = z.object({
  patch: z.string(),
  file: z.string().optional(),
});
export type DiffData = z.infer<typeof diffData>;
defineBlock({
  type: 'diff',
  tier: 'content',
  description: 'A unified-diff patch for one file, rendered with @pierre/diffs.',
  schema: diffData,
});

// ── file-tree ───────────────────────────────────────────────────────────────
// A flat list of paths rendered as a tree by @pierre/trees, with optional git
// status per path (the same tree engine the repo's file browser uses).
export const gitStatusEntry = z.object({
  path: z.string(),
  status: z.enum(['added', 'deleted', 'ignored', 'modified', 'renamed', 'untracked']),
});
export const fileTreeData = z.object({
  paths: z.array(z.string()),
  gitStatus: z.array(gitStatusEntry).optional(),
});
export type FileTreeData = z.infer<typeof fileTreeData>;
defineBlock({
  type: 'file-tree',
  tier: 'content',
  description: 'A file tree built from a list of paths (rendered with @pierre/trees), with optional git status.',
  schema: fileTreeData,
});

// ── table ───────────────────────────────────────────────────────────────────
export const tableData = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  caption: z.string().optional(),
});
export type TableData = z.infer<typeof tableData>;
defineBlock({
  type: 'table',
  tier: 'content',
  description: 'A data table: column headers and string rows.',
  schema: tableData,
});

// ── evidence (artifact-backed) ──────────────────────────────────────────────
// ArtifactRef is the local-now / remote-later seam: the renderer resolves a
// handle (inline text, image data URL, repo path, or remote URL) — swap the
// resolver, keep the component.
export const artifactRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), mime: z.string(), text: z.string() }),
  z.object({ kind: z.literal('image'), mime: z.string(), dataUrl: z.string(), width: z.number().optional(), height: z.number().optional() }),
  z.object({ kind: z.literal('path'), path: z.string(), mime: z.string().optional() }),
  z.object({ kind: z.literal('url'), url: z.string(), mime: z.string().optional() }),
]);
export type ArtifactRef = z.infer<typeof artifactRef>;
export const evidenceData = z.object({
  name: z.string(),
  source: z.enum(['captured', 'asserted']),
  ref: artifactRef,
  meta: z.string().optional(),
});
export type EvidenceData = z.infer<typeof evidenceData>;
defineBlock({
  type: 'evidence',
  tier: 'content',
  description: 'A captured or asserted piece of evidence, backed by an artifact reference.',
  schema: evidenceData,
});

// ── mermaid (diagram) ───────────────────────────────────────────────────────
export const mermaidData = z.object({
  code: z.string(),
  title: z.string().optional(),
});
export type MermaidData = z.infer<typeof mermaidData>;
defineBlock({
  type: 'mermaid',
  tier: 'content',
  description: 'A Mermaid diagram (flowchart, sequence, etc.).',
  schema: mermaidData,
});

// ── mini-app (sandboxed gitspace mini-app) ──────────────────────────────────
export const miniAppData = z.object({
  name: z.string(),
  html: z.string(), // the .gssh.html app source, rendered in a sandboxed iframe
  data: z.unknown().optional(), // a data artifact handed to the app via postMessage
  height: z.number().int().positive().optional(),
});
export type MiniAppData = z.infer<typeof miniAppData>;
defineBlock({
  type: 'mini-app',
  tier: 'structural',
  description: 'A sandboxed gitspace mini-app (.gssh.html) rendered in an iframe, fed a data artifact.',
  schema: miniAppData,
});
