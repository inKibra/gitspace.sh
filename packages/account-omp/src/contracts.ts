import type { SessionActivity } from '@gitspace/protocol';
import type { PendingAsk, PendingAskAnswer } from './ask-bridge.js';

export interface OmpRuntimeEvent {
  type: string;
  [key: string]: unknown;
}


export interface OmpSessionControlView {
  sessionId: string;
  role: string | null;
  roleLabel: string | null;
  roles: Array<{ id: string; label: string; provider: string; model: string; thinking: string | null; current: boolean }>;
  provider: string | null;
  models: Array<{ provider: string; id: string; name: string; contextWindow: number | null }>;
  model: string | null;
  thinking: string | null;
  fastMode: boolean;
  approvalMode: 'always-ask' | 'write' | 'yolo';
  context: { tokens: number; contextWindow: number; percent: number } | null;
  cost: number;
  todos: Array<{ name: string; tasks: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked'; blocker: string | null }> }>;
  queue: { steering: string[]; followUp: string[] };
  tree: Array<{ id: string; parentId: string | null; role: 'user' | 'assistant'; preview: string; tools: number; sequence: number; current: boolean; onPath: boolean }>;
  history: Array<{ entryId: string; text: string }>;
  goal: { id: string; status: 'active' | 'paused' | 'budget-limited' | 'complete' | 'dropped'; objective: string; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number } | null;
  pendingAsk: PendingAsk | null;
}
export interface OmpRuntimeSession {
  id: string;
  sessionFile: string;
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; images?: Array<{ type: 'image'; data: string; mimeType: string }> }): Promise<boolean>;
  subscribe(handler: (event: OmpRuntimeEvent) => void): () => void;
  subscribeActivity(handler: (activity: SessionActivity, errorMessage?: string) => void): () => void;
  activity(): { activity: SessionActivity; errorMessage?: string };
  persist(): Promise<void>;
  handoff(): Promise<boolean>;
  reloadSettings?(): Promise<void>;
  instructionsChanged?(): Promise<void>;
  resume(): Promise<void>;
  dispose(): Promise<void>;
  control(): Promise<OmpSessionControlView>;
  cycleRole(direction: 'forward' | 'backward'): Promise<OmpSessionControlView>;
  setModel(provider: string, model: string): Promise<OmpSessionControlView>;
  setThinking(thinking: string | null): Promise<OmpSessionControlView>;
  setFast(enabled: boolean): Promise<OmpSessionControlView>;
  setApproval(approvalMode: 'always-ask' | 'write' | 'yolo'): Promise<OmpSessionControlView>;
  setGoal(input: { enabled: boolean; objective?: string }): Promise<OmpSessionControlView>;
  compact(instructions?: string): Promise<OmpSessionControlView>;
  clearQueue(): Promise<OmpSessionControlView>;
  removeQueuedMessage(kind: 'steering' | 'followUp', index: number): Promise<OmpSessionControlView>;
  promoteQueuedMessage(index: number): Promise<OmpSessionControlView>;
  answerAsk(id: string, answers: readonly PendingAskAnswer[]): Promise<OmpSessionControlView>;
  stop(): Promise<OmpSessionControlView>;
  navigateTree(entryId: string): Promise<OmpSessionControlView>;
  messages(): Promise<unknown[]>;
}

export interface OmpRuntime {
  create(input: { projectId: string; workspaceId: string | null; workingDirectory: string; sessionKey: string; artifactsDir: string }): Promise<OmpRuntimeSession>;
  open(input: { projectId: string; workspaceId: string | null; workingDirectory: string; sessionKey: string; artifactsDir: string; sessionFile: string }): Promise<OmpRuntimeSession>;
  transcript(sessionFile: string): Promise<OmpTranscriptEvent[]>;
  checkpointTranscript(bytes: Uint8Array): Promise<OmpTranscriptEvent[]>;
}

export interface OmpTranscriptEvent {
  ordinal: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

