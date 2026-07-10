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

// ── goal-doc blocks (intent / boundaries / anti-shortcut / plan / evidence-shape)
// The planning vocabulary of a goal doc: the user's north star, protected
// surfaces, shortcut prevention, a cited implementation plan, and the shape of
// the decisive final evidence. Field names mirror the agent-surfaces mock.

export const intentData = z.object({
  quote: z.string(),
  source: z.string().optional(),
  why: z.string().optional(),
});
export type IntentData = z.infer<typeof intentData>;
defineBlock({
  type: 'intent',
  tier: 'content',
  description: "The user's intent verbatim — the north star quote a goal doc is anchored to, with source and why it matters.",
  schema: intentData,
});

export const boundaryItem = z.object({
  surface: z.string(),
  rule: z.string(),
});
export const boundariesData = z.object({
  items: z.array(boundaryItem),
});
export type BoundariesData = z.infer<typeof boundariesData>;
defineBlock({
  type: 'boundaries',
  tier: 'content',
  description: 'Protected boundaries — locked surfaces that must not change without explicit approval, each with its rule.',
  schema: boundariesData,
});

export const shortcutItem = z.object({
  shortcut: z.string(),
  why: z.string(),
});
export const antiShortcutData = z.object({
  items: z.array(shortcutItem),
});
export type AntiShortcutData = z.infer<typeof antiShortcutData>;
defineBlock({
  type: 'anti-shortcut',
  tier: 'content',
  description: 'Shortcut prevention — proof that looks complete but is not, and why each shortcut fails the contract.',
  schema: antiShortcutData,
});

export const planStepItem = z.object({
  title: z.string(),
  detail: z.string(),
  refs: z.array(z.string()).optional(), // file:line strings the step cites
});
export const planData = z.object({
  steps: z.array(planStepItem),
});
export type PlanData = z.infer<typeof planData>;
defineBlock({
  type: 'plan',
  tier: 'content',
  description: 'A numbered implementation plan; each step cites the code it touches via file:line refs.',
  schema: planData,
});

export const evidenceShapeItem = z.object({
  requirement: z.string(),
  kind: z.enum(['command', 'test', 'screenshot', 'video', 'note']),
  captured: z.string(),
});
export const evidenceShapeData = z.object({
  items: z.array(evidenceShapeItem),
});
export type EvidenceShapeData = z.infer<typeof evidenceShapeData>;
defineBlock({
  type: 'evidence-shape',
  tier: 'content',
  description: 'The shape of the final evidence — what decisive proof the goal wants at the end, per requirement.',
  schema: evidenceShapeData,
});

// ── workflow (recipe traversal: typed dataflow of phases, agents, gates) ────
// Mirrors the mock's WorkflowSpecData: phases with source/artifact-typed I/O,
// gated loops, per-phase created artifacts, and agent/gate/tool node rows.
export const wfIo = z.enum(['source', 'artifact']);
export type WfIo = z.infer<typeof wfIo>;
export const wfRef = z.object({
  name: z.string(),
  io: wfIo,
});
export type WfRef = z.infer<typeof wfRef>;
export const wfArtifactType = z.enum(['goal-slice', 'phased-goal', 'rubric', 'note', 'evidence', 'arbitrary']);
export type WfArtifactType = z.infer<typeof wfArtifactType>;
export const wfCreatedArtifact = z.object({
  name: z.string(),
  type: wfArtifactType,
  from: z.string().optional(),
  passedTo: z.string().optional(),
});
export type WfCreatedArtifact = z.infer<typeof wfCreatedArtifact>;
export const wfGateType = z.enum(['human', 'orchestration', 'command']);
export type WfGateType = z.infer<typeof wfGateType>;
export const wfNode = z.object({
  id: z.string(),
  /** Named agent from the discovered subagent registry (task/reviewer/
   *  designer/… — the same list the settings AGENTS tab shows via
   *  listAgentDefinitions). One of the two canonical node identities:
   *  surfaces display the agent name and its model chip resolves LIVE from
   *  the registry (override > frontmatter > session default). */
  agent: z.string().optional(),
  /** Freeform node title — parse-only back-compat. New specs author `agent`
   *  or `modelRole` as the node identity instead. */
  role: z.string().optional(),
  kind: z.enum(['agent', 'gate', 'tool']),
  /** OMP model-role id ('default' | 'task' | 'slow' | 'smol' | 'plan' |
   *  'designer' | 'vision' | …, optionally 'pi/'-prefixed; display labels in
   *  src/blocks/model-roles.ts). Canonical peer of `agent`:
   *   - alone, it IS the node identity ("run this step with the Vision role")
   *     — shown as the role label with the role's assigned model;
   *   - alongside `agent`, it is an explicit per-step model override for that
   *     agent ('reviewer · Vision — <model>'). */
  modelRole: z.string().optional(),
  /** Legacy Claude model alias ('opus'/'sonnet'/...). Parsed for back-compat
   *  only; renderers translate it to a model role and never show it raw. */
  model: z.string().optional(),
  status: z.enum(['done', 'running', 'pending']).optional(),
  gateType: wfGateType.optional(),
  reads: z.array(wfRef).optional(),
  writes: z.array(wfRef).optional(),
  out: z.string().optional(),
  fanout: z.object({ over: z.string(), instances: z.array(z.string()) }).optional(),
});
export type WfNode = z.infer<typeof wfNode>;
export const wfPhaseArtifact = z.object({
  name: z.string(),
  kind: z.string(),
  io: wfIo,
  required: z.boolean().optional(),
  status: z.enum(['created', 'pending']).optional(),
});
export type WfPhaseArtifact = z.infer<typeof wfPhaseArtifact>;
export const wfPhase = z.object({
  name: z.string(),
  inputs: z.array(wfRef),
  gate: z.object({ type: wfGateType, label: z.string() }).optional(),
  loop: z.string().optional(),
  created: z.array(wfCreatedArtifact).optional(),
  nodes: z.array(wfNode),
  outputs: z.array(wfPhaseArtifact),
});
export type WfPhase = z.infer<typeof wfPhase>;
export const workflowSpecData = z.object({
  recipe: z.string(),
  recipePath: z.string().optional(),
  rollup: z.array(z.string()).optional(),
  phases: z.array(wfPhase),
});
export type WorkflowSpecData = z.infer<typeof workflowSpecData>;
defineBlock({
  type: 'workflow',
  tier: 'structural',
  description: 'A workflow recipe traversal: phases with source/artifact-typed dataflow, agent/gate/tool nodes, gated loops, and per-phase created artifacts.',
  schema: workflowSpecData,
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
