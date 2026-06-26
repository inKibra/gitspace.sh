// ── ArtifactRef: a resolvable handle, identical for local-now and remote-later ──
// Block renderers never embed bytes directly; they take an ArtifactRef and a
// resolver decides whether it's an inline string, a local path, an image data
// URL, or (later) an uploaded blob URL. Swap the resolver, keep the components.
export type ArtifactRef =
  | { kind: 'inline'; mime: string; text: string }
  | { kind: 'image'; mime: string; dataUrl: string; width?: number; height?: number; bytes?: number }
  | { kind: 'path'; path: string; mime?: string }
  | { kind: 'url'; url: string; mime?: string };

// ── Block: a typed unit of structured content authored by an agent ──
export interface Block {
  id: string;
  type: string;
  data: unknown;
}

export type Tone = 'info' | 'warning' | 'success' | 'danger';

export interface MarkdownData { text: string }
export interface CalloutData { tone: Tone; title?: string; text: string }
export interface CodeData { lang?: string; text: string; startLine?: number }

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk';
export interface DiffLine { kind: DiffLineKind; text: string; ln?: number }
export interface DiffData { file: string; lines: DiffLine[] }

export type GitMark = 'M' | 'U' | 'A' | 'D';
export interface FileNode { name: string; path: string; kind: 'dir' | 'file'; depth: number; git?: GitMark }
export interface FileTreeData { nodes: FileNode[] }

export interface VerdictData { verdict: 'pass' | 'fail' | 'partial'; label: string; severity?: string; confidence?: string }

export interface ChecklistItem { text: string; done: boolean; evidence?: string }
export interface ChecklistData { items: ChecklistItem[] }

export interface AnnotatedLine { ln: number; text: string; hot?: boolean }
export interface AnnotatedNote { anchor: string; text: string }
export interface AnnotatedCodeData { lines: AnnotatedLine[]; notes: AnnotatedNote[] }

export type AgentStatus = 'running' | 'done' | 'blocked' | 'queued';
export interface AgentNodeData {
  role: string;
  model: string;
  status: AgentStatus;
  tokens?: number;
  cost?: number;
  intent: string;
  tool?: string;
}

export type RunNodeStatus = 'done' | 'running' | 'blocked' | 'pending';
export interface RunNodeTag { label: string; kind?: 'recipe' | 'schema' }
export interface RunNodeMeta { label?: string; value: string; tone?: 'acc' | 'dim' | 'red' }
export interface RunNode { role: string; status: RunNodeStatus; target?: string; meta?: RunNodeMeta[]; tags?: RunNodeTag[]; dim?: boolean }
export interface RunPhase { phase: string; barrier?: string; fan?: 'out' | 'in'; nodes: RunNode[] }
export interface RunGraphData { recipe: string; recipePath?: string; rollup?: string[]; phases: RunPhase[] }

export type Signal = 'core' | 'supporting' | 'noise';
export interface GuideSection { title: string; signal: Signal; rationale: string; anchors: string[] }
export interface GuideData { sections: GuideSection[] }

export interface EvidenceData {
  name: string;
  source: 'captured' | 'asserted';
  ref: ArtifactRef;
  meta?: string;
}

// ── goal-doc authoring blocks ──
export interface DataField { name: string; type: string; note?: string }
export interface DataStructureData { name: string; lang?: 'ts' | 'rust' | 'go'; fields: DataField[]; note?: string }
export interface MermaidData { title?: string; code: string }
export interface CodeRefData { path: string; lines?: string; startLine?: number; snippet: string; note?: string; exemplar?: boolean }
export interface PlanStepItem { title: string; detail: string; refs?: string[] }
export interface PlanData { steps: PlanStepItem[] }

// ── goal-doc planning sections ──
export interface IntentData { quote: string; source?: string; why?: string }
export interface BoundaryItem { surface: string; rule: string }
export interface BoundariesData { items: BoundaryItem[] }
export interface ShortcutItem { shortcut: string; why: string }
export interface AntiShortcutData { items: ShortcutItem[] }
export interface EvidenceShapeItem { requirement: string; kind: string; captured: string }
export interface EvidenceShapeData { items: EvidenceShapeItem[] }
export interface MockupData { title: string; artifact: string; app: string }

// ── workflow spec: dataflow graph (source vs artifact I/O, gated loops, gates, per-phase created artifacts) ──
export type WfIo = 'source' | 'artifact';
export interface WfRef { name: string; io: WfIo }
export type WfArtifactType = 'goal-slice' | 'phased-goal' | 'rubric' | 'note' | 'evidence' | 'arbitrary';
export interface WfCreatedArtifact { name: string; type: WfArtifactType; from?: string; passedTo?: string }
export type WfNodeKind = 'agent' | 'gate' | 'tool';
export type WfNodeStatus = 'done' | 'running' | 'pending';
export interface WfNode { id: string; role: string; kind: WfNodeKind; model?: string; status?: WfNodeStatus; reads?: WfRef[]; writes?: WfRef[]; out?: string; gateType?: 'human' | 'orchestration'; fanout?: { over: string; instances: string[] } }
export interface WfPhaseArtifact { name: string; kind: string; io: WfIo; required?: boolean; status?: 'created' | 'pending' }
export interface WfPhase { name: string; inputs: WfRef[]; nodes: WfNode[]; loop?: string; created?: WfCreatedArtifact[]; outputs: WfPhaseArtifact[]; gate?: { type: 'human' | 'orchestration'; label: string } }
export interface WorkflowSpecData { recipe: string; recipePath?: string; rollup?: string[]; phases: WfPhase[] }
