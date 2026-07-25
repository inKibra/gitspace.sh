/**
 * Per-session provider/model/path usage attribution — computed OFFLINE from the
 * pi session transcript, with no live session required.
 *
 * Why this exists: the SDK's `getUsageStatistics()` is a single flat scalar for
 * the whole session ({input,output,cacheRead,cacheWrite,premiumRequests,cost}),
 * which answers "how much" but never "on what, and how did we get there". The
 * transcript itself already carries everything needed for the breakdown:
 *
 *   - every assistant message records `provider` / `model` / `api` plus a
 *     `usage` object with token buckets AND a USD `cost` breakdown;
 *   - `model_change` entries record the active model and (for role-driven
 *     switches) the ROLE that selected it;
 *   - every `task` toolResult records one row per spawned subagent, with
 *     `agent` / `agentSource` / `modelOverride` / `resolvedModel` / `requests`
 *     / `durationMs` and that subagent's own `usage`.
 *
 * So the report is a pure reduction over data already on disk. It answers the
 * question the flat total can't: "my subscription is draining — which path is
 * doing it?" (e.g. one eval spawning many `advisor`-role subagents).
 *
 * Subagents live in their OWN transcript files, linked by convention:
 *   <dir>/<parentStem>/<spawnId>.jsonl
 * Detached/async spawns report zeroes in the parent (they finish after the tool
 * returns), so their real cost is only in the child file — which is why this
 * recurses rather than trusting the parent's aggregate.
 */

import { createReadStream, existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import { createInterface } from 'readline';

/** Token + cost totals, summed from any number of requests. */
export interface UsageTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

/** Spend grouped by the concrete model that served it. */
export interface ProviderModelRow extends UsageTotals {
  provider: string;
  model: string;
  api?: string;
}

/** Spend grouped by the model ROLE active when the request was made. */
export interface RoleRow extends UsageTotals {
  /** 'default' | 'smol' | 'slow' | 'advisor' | … (SDK treats absent as 'default'). */
  role: string;
  /** Models seen while this role was active. */
  models: string[];
}

/**
 * Spend split by service tier — "fast mode" (priority) vs standard. The tier is
 * per provider FAMILY (`{openai:'priority', anthropic:'standard', …}`), tracked
 * from `service_tier_change` entries and resolved per request against the
 * message's own provider/api/model.
 */
export interface ServiceTierRow extends UsageTotals {
  tier: 'fast' | 'standard';
  /** Models served under this tier. */
  models: string[];
}

/**
 * A contiguous stretch of the session where the (role, model) pair held steady
 * — the session's usage TIMELINE. The lifetime rollups above deliberately mix
 * eras: a role that was bound to one model earlier and another later shows both
 * models and one merged total, which reads as "I'm paying for a model I didn't
 * select". Segments date the spend so that question is answerable.
 */
export interface UsageSegment extends UsageTotals {
  role: string;
  provider: string;
  model: string;
  tier?: 'fast' | 'standard';
  /** Epoch ms of the first / last request in this stretch. */
  startedAt: number;
  endedAt: number;
}

/** One subagent spawn recorded in a `task` toolResult. */
export interface SpawnRow extends UsageTotals {
  id: string;
  agent: string;
  agentSource?: string;
  description?: string;
  /** Raw selector the caller asked for: `pi/<role>` (role) or `provider/model` (pinned). */
  modelOverride?: string[];
  /** Concrete model the selector resolved to. */
  resolvedModel?: string;
  durationMs?: number;
  /** How the model was addressed — the provenance this report exists to show. */
  selection: 'role' | 'pinned' | 'inherited';
  /** Child transcript, when it exists on disk. */
  childSessionFile?: string;
}

export interface SessionUsageReport {
  sessionFile: string;
  /** Totals for THIS session only (excludes children). */
  totals: UsageTotals;
  /** Totals including every descendant session. */
  totalsDeep: UsageTotals;
  byProviderModel: ProviderModelRow[];
  byRole: RoleRow[];
  /** Fast (priority) vs standard — empty when the session never set a tier. */
  byServiceTier: ServiceTierRow[];
  /** Chronological (role, model) eras — dates the spend. */
  segments: UsageSegment[];
  spawns: SpawnRow[];
  children: SessionUsageReport[];
  /** Non-fatal parse problems (unreadable child, malformed line, size cap hit). */
  warnings: string[];
}

/** Depth guard for the spawn tree (subagents can spawn subagents). */
const MAX_DEPTH = 8;

export function emptyTotals(): UsageTotals {
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
  premiumRequests?: number;
  cost?: { total?: number };
}

function addUsage(into: UsageTotals, usage: RawUsage | undefined, requests = 1): void {
  if (!usage) return;
  into.requests += requests;
  into.input += usage.input ?? 0;
  into.output += usage.output ?? 0;
  into.cacheRead += usage.cacheRead ?? 0;
  into.cacheWrite += usage.cacheWrite ?? 0;
  into.totalTokens += usage.totalTokens ?? 0;
  into.reasoningTokens += usage.reasoningTokens ?? 0;
  into.costUsd += usage.cost?.total ?? 0;
}

function mergeTotals(into: UsageTotals, from: UsageTotals): void {
  into.requests += from.requests;
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.totalTokens += from.totalTokens;
  into.reasoningTokens += from.reasoningTokens;
  into.costUsd += from.costUsd;
}

/**
 * Classify HOW a spawn's model was addressed. `pi/<role>` is the role
 * indirection; a bare `provider/model` is a hard pin; nothing means the
 * subagent inherited the session/agent default.
 */
function classifySelection(modelOverride: string[] | undefined): SpawnRow['selection'] {
  const first = modelOverride?.[0];
  if (!first) return 'inherited';
  return first.startsWith('pi/') ? 'role' : 'pinned';
}

/** Child transcript path for a spawn — the `<parentStem>/<spawnId>.jsonl` convention. */
export function childSessionFileFor(parentFile: string, spawnId: string): string {
  return join(dirname(parentFile), basename(parentFile, '.jsonl'), `${spawnId}.jsonl`);
}

interface ParsedEntry {
  type?: string;
  /** ISO timestamp on every entry. */
  timestamp?: string;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    api?: string;
    usage?: RawUsage;
    toolName?: string;
    details?: { results?: RawSpawnResult[] };
  };
  /** model_change fields */
  model?: string;
  role?: string;
  /** service_tier_change: per provider-family tier map. */
  serviceTier?: Record<string, string> | null;
}

/**
 * Which service-tier family a request belongs to. Uses the SDK's own resolver
 * (the authoritative mapping) against the message's real provider/api/model,
 * falling back to the provider string when the SDK can't classify it.
 */
type TierFamilyResolver = (msg: { provider: string; api?: string; model: string }) => string;

async function loadTierFamilyResolver(): Promise<TierFamilyResolver> {
  try {
    const mod = (await import('@oh-my-pi/pi-ai')) as {
      serviceTierFamily?: (m: { provider: string; api?: string; id: string }) => string | undefined;
    };
    const fn = mod.serviceTierFamily;
    if (typeof fn !== 'function') return (m) => m.provider;
    return (m) => {
      try {
        return fn({ provider: m.provider, api: m.api, id: m.model }) ?? m.provider;
      } catch {
        return m.provider;
      }
    };
  } catch {
    return (m) => m.provider;
  }
}

interface RawSpawnResult {
  id?: string;
  agent?: string;
  agentSource?: string;
  description?: string;
  modelOverride?: string[];
  resolvedModel?: string;
  tokens?: number;
  requests?: number;
  durationMs?: number;
  usage?: RawUsage;
}

/**
 * Build the attribution report for one session transcript, recursing into
 * subagent transcripts. Returns null when the file is unreadable.
 *
 * Role attribution uses file order: a `model_change` sets the active role for
 * the assistant messages that follow it. Sessions are a tree (entries carry
 * parentId) so a forked/rewound branch could in principle interleave; file
 * order matches the SDK's own append semantics and is right for the common
 * linear case.
 */
export async function buildSessionUsageReport(
  sessionFile: string,
  opts: { depth?: number; tierFamily?: TierFamilyResolver } = {},
): Promise<SessionUsageReport | null> {
  const depth = opts.depth ?? 0;
  const warnings: string[] = [];
  if (!existsSync(sessionFile)) return null;
  // Resolved once and threaded into children — the SDK import is not free.
  const tierFamily = opts.tierFamily ?? (await loadTierFamilyResolver());

  const totals = emptyTotals();
  const byModel = new Map<string, ProviderModelRow>();
  const byRole = new Map<string, RoleRow & { modelSet: Set<string> }>();
  const byTier = new Map<'fast' | 'standard', ServiceTierRow & { modelSet: Set<string> }>();
  const spawns: SpawnRow[] = [];
  const segments: UsageSegment[] = [];
  // Current (role, model) era — a new one opens whenever either changes.
  let segment: UsageSegment | null = null;
  // The SDK treats an absent role as 'default'; our own restore/persist writes
  // also land as 'default', so this bucket is "unattributed", not "user chose
  // the default role". Keep the name honest in the UI.
  let currentRole = 'default';
  // Per provider-FAMILY tier map from service_tier_change ({openai:'priority'}).
  let currentTier: Record<string, string> | null = null;
  let sawTierEntry = false;
  let malformed = 0;

  // Stream: a real transcript can reach hundreds of MB, and slurping it (one
  // giant string PLUS an array of every line) blew memory and forced a size cap
  // that skipped exactly the sessions worth reporting on. Line-at-a-time keeps
  // memory flat regardless of file size, so there is no cap at all now.
  const rl = createInterface({ input: createReadStream(sessionFile, 'utf8'), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
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

      if (entry.type === 'service_tier_change') {
        currentTier = entry.serviceTier ?? null;
        sawTierEntry = true;
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
          modelRow = { provider, model, api: message.api, ...emptyTotals() };
          byModel.set(modelKey, modelRow);
        }
        addUsage(modelRow, message.usage);

        let roleRow = byRole.get(currentRole);
        if (!roleRow) {
          roleRow = { role: currentRole, models: [], modelSet: new Set(), ...emptyTotals() };
          byRole.set(currentRole, roleRow);
        }
        roleRow.modelSet.add(modelKey);
        addUsage(roleRow, message.usage);

        // Fast mode = this request's provider family was on 'priority'. A
        // premiumRequests count is definitive when the provider reports one.
        if (sawTierEntry) {
          const family = tierFamily({ provider, api: message.api, model });
          const isFast = currentTier?.[family] === 'priority' || (message.usage.premiumRequests ?? 0) > 0;
          const tier: 'fast' | 'standard' = isFast ? 'fast' : 'standard';
          let tierRow = byTier.get(tier);
          if (!tierRow) {
            tierRow = { tier, models: [], modelSet: new Set(), ...emptyTotals() };
            byTier.set(tier, tierRow);
          }
          tierRow.modelSet.add(modelKey);
          addUsage(tierRow, message.usage);
        }

        // Timeline: extend the open era, or start a new one when the role or
        // model changed. `at` falls back to the previous stamp so an entry with
        // no/!parseable timestamp can't produce a NaN range.
        const parsed = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        const at: number = Number.isFinite(parsed) ? parsed : (segment?.endedAt ?? 0);
        const tierNow: 'fast' | 'standard' | undefined = sawTierEntry
          ? (currentTier?.[tierFamily({ provider, api: message.api, model })] === 'priority'
             || (message.usage.premiumRequests ?? 0) > 0 ? 'fast' : 'standard')
          : undefined;
        if (!segment || segment.role !== currentRole || segment.provider !== provider || segment.model !== model) {
          segment = { role: currentRole, provider, model, tier: tierNow, startedAt: at, endedAt: at, ...emptyTotals() };
          segments.push(segment);
        }
        segment.endedAt = at;
        addUsage(segment, message.usage);
        continue;
      }

      // `task` spawns: one row per subagent, already carrying its own usage.
      const results = message.details?.results;
      if (message.role === 'toolResult' && Array.isArray(results)) {
        for (const result of results) {
          const id = result.id;
          if (!id) continue;
          const row: SpawnRow = {
            id,
            agent: result.agent ?? 'unknown',
            agentSource: result.agentSource,
            description: result.description,
            modelOverride: result.modelOverride,
            resolvedModel: result.resolvedModel,
            durationMs: result.durationMs,
            selection: classifySelection(result.modelOverride),
            ...emptyTotals(),
          };
          addUsage(row, result.usage, result.requests ?? 1);
          const childFile = childSessionFileFor(sessionFile, id);
          if (existsSync(childFile)) row.childSessionFile = childFile;
          spawns.push(row);
        }
      }
    }
  } catch {
    return null; // unreadable mid-stream
  } finally {
    rl.close();
  }

  if (malformed > 0) warnings.push(`${malformed} malformed transcript line(s) skipped`);

  const children: SessionUsageReport[] = [];
  if (depth < MAX_DEPTH) {
    for (const spawn of spawns) {
      if (!spawn.childSessionFile) continue;
      const child = await buildSessionUsageReport(spawn.childSessionFile, { depth: depth + 1, tierFamily });
      if (child) children.push(child);
      else warnings.push(`unreadable child transcript: ${spawn.childSessionFile}`);
    }
  } else if (spawns.some((s) => s.childSessionFile)) {
    warnings.push(`spawn tree deeper than ${MAX_DEPTH} — not recursed further`);
  }

  // Deep totals: this session + every descendant. Deliberately built from the
  // CHILD transcripts rather than the parent's spawn rows — a detached spawn
  // reports zeroes in the parent, so trusting those would undercount.
  const totalsDeep = emptyTotals();
  mergeTotals(totalsDeep, totals);
  for (const child of children) mergeTotals(totalsDeep, child.totalsDeep);
  // A spawn WITHOUT a readable child transcript still has to be counted, and
  // the parent's row is then the only record of it.
  for (const spawn of spawns) {
    if (spawn.childSessionFile) continue;
    mergeTotals(totalsDeep, spawn);
  }

  const roleRows: RoleRow[] = [...byRole.values()]
    .map(({ modelSet, ...row }) => ({ ...row, models: [...modelSet].sort() }))
    .sort((a, b) => b.costUsd - a.costUsd);
  const tierRows: ServiceTierRow[] = [...byTier.values()]
    .map(({ modelSet, ...row }) => ({ ...row, models: [...modelSet].sort() }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    sessionFile,
    totals,
    totalsDeep,
    byProviderModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
    byRole: roleRows,
    byServiceTier: tierRows,
    segments,
    spawns,
    children,
    warnings,
  };
}

/** One row of the "which path is burning the budget" rollup. */
export interface PathRollupRow extends UsageTotals {
  /** Grouping key: agent name + how its model was addressed + the model. */
  agent: string;
  selection: SpawnRow['selection'];
  model: string;
  /** How many times this path was spawned — the "tons of advisor spawns" signal. */
  spawnCount: number;
}

/**
 * Flatten the whole spawn tree into "agent × selection × model" rows, sorted by
 * spend. This is the view that answers "why is my subscription draining": a row
 * with a large `spawnCount` and a big `costUsd` is the culprit.
 *
 * Cost per spawn is taken from the CHILD transcript when one exists (detached
 * spawns report zeroes in the parent), else from the parent's row.
 */
export function rollupByPath(report: SessionUsageReport): PathRollupRow[] {
  const rows = new Map<string, PathRollupRow>();

  const visit = (node: SessionUsageReport): void => {
    const childByFile = new Map(node.children.map((c) => [c.sessionFile, c]));
    for (const spawn of node.spawns) {
      const model = spawn.resolvedModel ?? spawn.modelOverride?.[0] ?? 'inherited';
      const key = `${spawn.agent}|${spawn.selection}|${model}`;
      let row = rows.get(key);
      if (!row) {
        row = { agent: spawn.agent, selection: spawn.selection, model, spawnCount: 0, ...emptyTotals() };
        rows.set(key, row);
      }
      row.spawnCount += 1;
      const child = spawn.childSessionFile ? childByFile.get(spawn.childSessionFile) : undefined;
      // Prefer the child's own measured totals; fall back to the parent's row.
      mergeTotals(row, child ? child.totals : spawn);
    }
    for (const child of node.children) visit(child);
  };

  visit(report);
  return [...rows.values()].sort((a, b) => b.costUsd - a.costUsd);
}
