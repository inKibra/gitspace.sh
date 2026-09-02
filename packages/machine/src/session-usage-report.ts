/**
 * Per-session usage attribution, reduced OFFLINE from the OMP session JSONL.
 *
 * Nothing here touches a live worker: the transcript on disk is the record, so
 * the same reducer answers for live, dormant, and closed sessions. File I/O is
 * injected (`readFile`) so the reducer stays pure and testable without a
 * filesystem.
 *
 * JSONL fields consumed:
 * - assistant `message` entries: `message.usage`, `message.provider`, `message.model`, `message.api`
 * - `model_change` entries: `role` (absent → 'default'); sets the role for the assistant messages that follow
 * - `toolResult` entries carrying `message.details.results[]` (task spawns):
 *   `id`, `agent`, `modelOverride` (string | string[]), `modelRole`, `resolvedModel`, `requests`, `usage`
 * - entry `timestamp` for spawn dating
 * Child transcripts live at `<parentStem>/<spawnId>.jsonl`.
 */

import type { SessionUsageReport, UsageTotals } from '@gitspace/protocol';

export type { SessionUsageReport, UsageTotals };

export type TranscriptReader = (path: string) => Promise<string | null>;

type Selection = SessionUsageReport['byAgent'][number]['selection'];
/** Wire types are readonly; the accumulators are not. */
type Totals = { -readonly [K in keyof UsageTotals]: UsageTotals[K] };

/** Depth guard for the spawn tree (subagents can spawn subagents). */
const MAX_DEPTH = 8;

export function emptyTotals(): Totals {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0, costUsd: 0 };
}

/** Shape of the SDK `Usage` object as persisted on assistant messages / spawns. */
interface RawUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cost?: { total?: number };
}

interface RawSpawnResult {
  id?: string;
  agent?: string;
  modelOverride?: string | string[];
  modelRole?: string;
  resolvedModel?: string;
  requests?: number;
  usage?: RawUsage;
}

interface ParsedEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    api?: string;
    usage?: RawUsage;
    details?: { results?: RawSpawnResult[] };
  };
  /** model_change */
  role?: string;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function addUsage(into: Totals, usage: RawUsage | undefined, requests = 1): void {
  if (!usage) return;
  into.requests += requests;
  into.input += num(usage.input);
  into.output += num(usage.output);
  into.cacheRead += num(usage.cacheRead);
  into.cacheWrite += num(usage.cacheWrite);
  into.totalTokens += num(usage.totalTokens);
  into.reasoningTokens += num(usage.reasoningTokens);
  into.costUsd += num(usage.cost?.total);
}

function mergeTotals(into: Totals, from: UsageTotals): void {
  into.requests += from.requests;
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.totalTokens += from.totalTokens;
  into.reasoningTokens += from.reasoningTokens;
  into.costUsd += from.costUsd;
}

function firstOverride(modelOverride: string | string[] | undefined): string | undefined {
  return Array.isArray(modelOverride) ? modelOverride[0] : modelOverride || undefined;
}

/**
 * Classify HOW a spawn's model was addressed. An explicit `modelRole` or a
 * `pi/<role>` selector is the role indirection; a bare `provider/model` is a
 * hard pin; nothing means the subagent inherited the session/agent default.
 */
function classifySelection(result: RawSpawnResult): Selection {
  if (result.modelRole) return 'role';
  const first = firstOverride(result.modelOverride);
  if (!first) return 'inherited';
  return first.startsWith('pi/') ? 'role' : 'pinned';
}

/** Child transcript path for a spawn — the `<parentStem>/<spawnId>.jsonl` convention. */
export function childSessionFileFor(parentFile: string, spawnId: string): string {
  return `${parentFile.replace(/\.jsonl$/u, '')}/${spawnId}.jsonl`;
}

interface SpawnRow {
  id: string;
  agent: string;
  selection: Selection;
  model: string;
  at: string | null;
  totals: Totals;
  childSessionFile: string | null;
}

interface ModelRow { provider: string; model: string; totals: Totals }
interface RoleRow { role: string; modelSet: Set<string>; totals: Totals }

interface Node {
  totals: Totals;
  totalsDeep: Totals;
  byModel: Map<string, ModelRow>;
  byRole: Map<string, RoleRow>;
  spawns: SpawnRow[];
  children: Map<string, Node>;
  descendants: number;
  warnings: string[];
}

async function reduceTranscript(file: string, readFile: TranscriptReader, depth: number): Promise<Node | null> {
  const text = await readFile(file);
  if (text === null) return null;

  const totals = emptyTotals();
  const byModel = new Map<string, ModelRow>();
  const byRole = new Map<string, RoleRow>();
  const spawns: SpawnRow[] = [];
  const warnings: string[] = [];
  // The SDK treats an absent role as 'default', so this bucket is
  // "unattributed", not "user chose the default role".
  let currentRole = 'default';
  let malformed = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    // Line 1 is a fixed-width mutable title slot, not JSON.
    if (!trimmed.startsWith('{')) continue;
    let entry: ParsedEntry;
    try {
      entry = JSON.parse(trimmed) as ParsedEntry;
    } catch {
      malformed += 1;
      continue;
    }

    if (entry.type === 'model_change') {
      currentRole = entry.role ?? 'default';
      continue;
    }

    const message = entry.message;
    if (!message) continue;

    if (message.role === 'assistant' && message.usage) {
      const provider = message.provider ?? 'unknown';
      const model = message.model ?? 'unknown';
      addUsage(totals, message.usage);

      const modelKey = `${provider}/${model}`;
      let modelRow = byModel.get(modelKey);
      if (!modelRow) {
        modelRow = { provider, model, totals: emptyTotals() };
        byModel.set(modelKey, modelRow);
      }
      addUsage(modelRow.totals, message.usage);

      let roleRow = byRole.get(currentRole);
      if (!roleRow) {
        roleRow = { role: currentRole, modelSet: new Set(), totals: emptyTotals() };
        byRole.set(currentRole, roleRow);
      }
      roleRow.modelSet.add(modelKey);
      addUsage(roleRow.totals, message.usage);
      continue;
    }

    // `task` spawns: one row per subagent, already carrying its own usage.
    const results = message.details?.results;
    if (message.role === 'toolResult' && Array.isArray(results)) {
      const at = typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : null;
      for (const result of results) {
        if (!result || typeof result.id !== 'string' || !result.id) continue;
        const row: SpawnRow = {
          id: result.id,
          agent: result.agent ?? 'unknown',
          selection: classifySelection(result),
          model: result.resolvedModel ?? firstOverride(result.modelOverride) ?? 'inherited',
          at,
          totals: emptyTotals(),
          childSessionFile: null,
        };
        addUsage(row.totals, result.usage, result.requests ?? 1);
        spawns.push(row);
      }
    }
  }

  if (malformed > 0) warnings.push(`${malformed} malformed transcript line(s) skipped`);

  const children = new Map<string, Node>();
  let descendants = 0;
  if (depth < MAX_DEPTH) {
    for (const spawn of spawns) {
      const childFile = childSessionFileFor(file, spawn.id);
      const child = await reduceTranscript(childFile, readFile, depth + 1);
      if (!child) continue;
      spawn.childSessionFile = childFile;
      children.set(childFile, child);
      descendants += 1 + child.descendants;
      warnings.push(...child.warnings.map((warning) => `${spawn.id}: ${warning}`));
    }
  } else if (spawns.length > 0) {
    warnings.push(`spawn tree deeper than ${MAX_DEPTH} — not recursed further`);
  }

  // Deep totals: this session + every descendant. Built from the CHILD
  // transcripts where they exist — a detached spawn reports zeroes in the
  // parent, so trusting those would undercount. A spawn WITHOUT a readable
  // child transcript is counted from the parent's row, the only record of it.
  const totalsDeep = emptyTotals();
  mergeTotals(totalsDeep, totals);
  for (const child of children.values()) mergeTotals(totalsDeep, child.totalsDeep);
  for (const spawn of spawns) {
    if (spawn.childSessionFile) continue;
    mergeTotals(totalsDeep, spawn.totals);
  }

  return { totals, totalsDeep, byModel, byRole, spawns, children, descendants, warnings };
}

type AgentRow = { -readonly [K in keyof SessionUsageReport['byAgent'][number]]: SessionUsageReport['byAgent'][number][K] } & { totals: Totals };

/**
 * Flatten the whole spawn tree into "agent × selection × model" rows. Cost per
 * spawn is the CHILD transcript's own totals when one exists, else the
 * parent's row.
 */
function rollupByAgent(root: Node): AgentRow[] {
  const rows = new Map<string, AgentRow>();
  const visit = (node: Node): void => {
    for (const spawn of node.spawns) {
      const key = `${spawn.agent}|${spawn.selection}|${spawn.model}`;
      let row = rows.get(key);
      if (!row) {
        row = { agentId: key, agent: spawn.agent, selection: spawn.selection, model: spawn.model, spawns: 0, firstAt: null, lastAt: null, totals: emptyTotals() };
        rows.set(key, row);
      }
      row.spawns += 1;
      if (spawn.at) {
        if (row.firstAt === null || spawn.at < row.firstAt) row.firstAt = spawn.at;
        if (row.lastAt === null || spawn.at > row.lastAt) row.lastAt = spawn.at;
      }
      const child = spawn.childSessionFile ? node.children.get(spawn.childSessionFile) : undefined;
      mergeTotals(row.totals, child ? child.totals : spawn.totals);
    }
    for (const child of node.children.values()) visit(child);
  };
  visit(root);
  return [...rows.values()].sort((a, b) => b.totals.costUsd - a.totals.costUsd);
}

/**
 * Build the attribution report for one session transcript, recursing into
 * subagent transcripts. Returns null when the root transcript is unreadable.
 *
 * Role attribution uses file order: a `model_change` sets the active role for
 * the assistant messages that follow it. Sessions are a tree (entries carry
 * parentId) so a forked/rewound branch could in principle interleave; file
 * order matches the SDK's own append semantics and is right for the common
 * linear case.
 */
export async function buildSessionUsageReport(
  sessionId: string,
  sessionFile: string,
  readFile: TranscriptReader,
): Promise<SessionUsageReport | null> {
  const root = await reduceTranscript(sessionFile, readFile, 0);
  if (!root) return null;
  const byCost = (a: { totals: UsageTotals }, b: { totals: UsageTotals }): number => b.totals.costUsd - a.totals.costUsd;
  return {
    sessionId,
    totals: root.totals,
    totalsDeep: root.totalsDeep,
    childSessions: root.descendants,
    byModel: [...root.byModel.values()].sort(byCost),
    byRole: [...root.byRole.values()]
      .map(({ role, modelSet, totals }) => ({ role, models: [...modelSet].sort(), totals }))
      .sort(byCost),
    byAgent: rollupByAgent(root),
    warnings: root.warnings,
  };
}
