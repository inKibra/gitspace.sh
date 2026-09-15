/** Offline usage attribution from persisted responses, historical selections, and child transcripts. */
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { SessionUsageReport, UsageTotals } from '@gitspace/protocol';

export type { SessionUsageReport, UsageTotals };
export type TranscriptReader = (path: string) => Promise<string | null>;
/** Return absolute immediate .jsonl children; the filesystem adapter must reject symlink escapes. */
export type TranscriptLister = (directory: string) => Promise<string[]>;

type Selection = SessionUsageReport['byAgent'][number]['selection'];
type Totals = { -readonly [K in keyof UsageTotals]: UsageTotals[K] };
type AgentRow = { -readonly [K in keyof SessionUsageReport['byAgent'][number]]: SessionUsageReport['byAgent'][number][K] };
type Json = Record<string, unknown>;
interface Attribution { role: string | null; selection: Selection }
interface Definition { name: string; source: string | null; path: string | null; revision: string | null }
interface Spawn {
  id: string;
  definition: Definition;
  attribution: Attribution;
  at: string | null;
  usage: Json | null;
  requests: number;
  listed: boolean;
  referenced: boolean;
}
interface ModelRow { provider: string; model: string; totals: Totals }
interface RoleRow { role: string | null; models: Set<string>; totals: Totals }
interface CompletionRow extends ModelRow { kind: string; role: string | null }
interface State {
  readFile: TranscriptReader;
  listFiles?: TranscriptLister;
  files: Set<string>;
  sessions: Set<string>;
  completions: Set<string>;
  totalsDeep: Totals;
  childSessions: number;
  byModel: Map<string, ModelRow>;
  byRole: Map<string | null, RoleRow>;
  byAgent: Map<string, { row: AgentRow; sessions: Set<string> }>;
  byCompletion: Map<string, CompletionRow>;
  warnings: Set<string>;
}

const MAX_DEPTH = 8;
const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'reasoningTokens'] as const;
const UNKNOWN: Attribution = { role: null, selection: 'unknown' };

export function emptyTotals(): Totals {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0, costUsd: 0 };
}

function object(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function rawUsage(value: unknown): Json | null {
  const usage = object(value);
  if (!usage || !TOKEN_FIELDS.some((field) => usage[field] !== undefined)) return null;
  return TOKEN_FIELDS.every((field) => usage[field] === undefined || (typeof usage[field] === 'number' && Number.isFinite(usage[field]) && usage[field] >= 0)) ? usage : null;
}

function usageTotals(usage: Json, requests = 1): Totals {
  const totals = emptyTotals();
  totals.requests = requests;
  for (const field of TOKEN_FIELDS) totals[field] = number(usage[field]);
  totals.costUsd = number(object(usage.cost)?.total);
  return totals;
}

function mergeTotals(into: Totals, from: UsageTotals): void {
  into.requests += from.requests;
  for (const field of TOKEN_FIELDS) into[field] += from[field];
  into.costUsd += from.costUsd;
}

function historicalSelection(data: Json): Attribution {
  return { role: string(data.role), selection: data.selection === 'role' || data.selection === 'pinned' || data.selection === 'inherited' ? data.selection : 'unknown' };
}

function spawnSelection(data: Json): Attribution {
  const override = Array.isArray(data.modelOverride) ? string(data.modelOverride[0]) : string(data.modelOverride);
  const role = string(data.modelRole) ?? (override?.startsWith('pi/') ? string(override.slice(3)) : null);
  return { role, selection: role ? 'role' : override ? 'pinned' : 'unknown' };
}

function validChildId(id: string): boolean {
  return id.length <= 249 && /^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*$/u.test(id);
}

/** Child names cannot escape the parent's artifact directory, even when metadata is malformed. */
export function childSessionFileFor(parentFile: string, spawnId: string): string {
  if (!validChildId(spawnId) || !parentFile.endsWith('.jsonl')) throw new Error('Invalid child session path');
  return `${parentFile.slice(0, -6)}/${spawnId}.jsonl`;
}

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function newSpawn(id: string): Spawn {
  return { id, definition: { name: 'unknown', source: null, path: null, revision: null }, attribution: UNKNOWN, at: null, usage: null, requests: 0, listed: false, referenced: false };
}

function parseEntries(text: string, file: string, state: State): Json[] {
  const entries: Json[] = [];
  const ids = new Set<string>();
  let malformed = 0;
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed || (index === 0 && !trimmed.startsWith('{'))) continue; // Mutable, non-JSON title slot.
    try {
      const entry = object(JSON.parse(trimmed));
      if (!entry || !string(entry.type)) { malformed += 1; continue; }
      const id = string(entry.id);
      if (id && entry.type !== 'session') {
        if (ids.has(id)) continue;
        ids.add(id);
      }
      entries.push(entry);
    } catch {
      malformed += 1;
    }
  }
  if (malformed > 0) state.warnings.add(`${file}: ${malformed} malformed transcript line(s) skipped; usage coverage may be incomplete`);
  return entries;
}

function collectSpawns(entries: Json[], file: string, state: State): Map<string, Spawn> {
  const spawns = new Map<string, Spawn>();
  for (const entry of entries) {
    const message = object(entry.message);
    if (message?.role !== 'toolResult' || (message.toolName !== undefined && message.toolName !== 'task')) continue;
    const details = object(message.details);
    if (!details) continue;
    for (const field of ['progress', 'results']) {
      const rows = details[field];
      if (rows === undefined) continue;
      if (!Array.isArray(rows)) { state.warnings.add(`${file}: malformed task ${field} metadata`); continue; }
      for (const value of rows) {
        const data = object(value);
        const id = string(data?.id);
        if (!data || !id || !validChildId(id)) { state.warnings.add(`${file}: invalid child session ID in task metadata`); continue; }
        let spawn = spawns.get(id);
        if (!spawn) { spawn = newSpawn(id); spawns.set(id, spawn); }
        spawn.referenced = true;
        if (spawn.definition.name === 'unknown') spawn.definition.name = string(data.agent) ?? 'unknown';
        spawn.definition.source ??= string(data.agentSource);
        const attribution = spawnSelection(data);
        // Progress captures the initial requested role; a final serving model is not historical attribution.
        if (spawn.attribution.selection === 'unknown' && attribution.selection !== 'unknown') spawn.attribution = attribution;
        const at = timestamp(entry.timestamp);
        if (at && (!spawn.at || at < spawn.at)) spawn.at = at;
        const usage = rawUsage(data.usage);
        // Results are cumulative snapshots, not additional requests. Re-delivery must not add them again.
        if (usage) {
          const requests = data.requests === undefined ? 1 : number(data.requests);
          if (!spawn.usage || requests >= spawn.requests) { spawn.usage = usage; spawn.requests = requests; }
        }
      }
    }
  }
  return spawns;
}

function addAgent(state: State, file: string, definition: Definition, attribution: Attribution, provider: string, model: string, totals: UsageTotals, at: string | null): void {
  const key = JSON.stringify([definition.name, definition.source, definition.path, definition.revision, attribution.role, provider, model]);
  let bucket = state.byAgent.get(key);
  if (!bucket) {
    bucket = {
      row: { agentId: key, agent: definition.name, definitionSource: definition.source, definitionPath: definition.path, definitionRevision: definition.revision, role: attribution.role, selection: attribution.selection, provider, model, spawns: 0, firstAt: null, lastAt: null, totals: emptyTotals() },
      sessions: new Set(),
    };
    state.byAgent.set(key, bucket);
  }
  const row = bucket.row;
  if (!bucket.sessions.has(file)) { bucket.sessions.add(file); row.spawns += 1; }
  if (row.selection !== attribution.selection) row.selection = 'unknown';
  if (at && (!row.firstAt || at < row.firstAt)) row.firstAt = at;
  if (at && (!row.lastAt || at > row.lastAt)) row.lastAt = at;
  mergeTotals(row.totals, totals);
  if (!definition.source || !definition.path || !definition.revision) state.warnings.add('Historical agent definition provenance is missing for some child sessions; current definitions were not substituted');
}

function addResponse(state: State, own: Totals, file: string, spawn: Spawn | null, definition: Definition, attribution: Attribution, provider: string, model: string, usage: Json, at: string | null, kind?: string, requests = 1): void {
  const totals = usageTotals(usage, requests);
  mergeTotals(own, totals);
  mergeTotals(state.totalsDeep, totals);
  const modelKey = JSON.stringify([provider, model]);
  let modelRow = state.byModel.get(modelKey);
  if (!modelRow) { modelRow = { provider, model, totals: emptyTotals() }; state.byModel.set(modelKey, modelRow); }
  mergeTotals(modelRow.totals, totals);
  let roleRow = state.byRole.get(attribution.role);
  if (!roleRow) { roleRow = { role: attribution.role, models: new Set(), totals: emptyTotals() }; state.byRole.set(attribution.role, roleRow); }
  roleRow.models.add(`${provider}/${model}`);
  mergeTotals(roleRow.totals, totals);
  if (spawn) addAgent(state, file, definition, attribution, provider, model, totals, spawn.at ?? at);
  if (kind) {
    const key = JSON.stringify([kind, attribution.role, provider, model]);
    let row = state.byCompletion.get(key);
    if (!row) { row = { kind, role: attribution.role, provider, model, totals: emptyTotals() }; state.byCompletion.set(key, row); }
    mergeTotals(row.totals, totals);
  }
  if (attribution.role === null) state.warnings.add('Historical model role was not recorded for some usage; no role was inferred from serving models or current settings');
  if (provider === 'unknown' || model === 'unknown') state.warnings.add('Actual serving provider/model was not recorded for some usage');
  if (totals.costUsd === 0) state.warnings.add('Some SDK-recorded costs are zero or unavailable; these amounts are not authoritative account billing');
}

async function reconcileFiles(file: string, spawns: Map<string, Spawn>, state: State): Promise<void> {
  if (!state.listFiles) return;
  const directory = file.slice(0, -6);
  try {
    for (const candidate of await state.listFiles(directory)) {
      if (!isAbsolute(candidate) || candidate.includes('\\') || candidate.includes('\0')) { state.warnings.add(`${file}: unsafe child transcript path rejected`); continue; }
      const childFile = resolve(candidate);
      const id = basename(childFile, '.jsonl');
      if (dirname(childFile) !== directory || !childFile.endsWith('.jsonl') || !validChildId(id)) { state.warnings.add(`${file}: non-immediate or unsafe child transcript path rejected`); continue; }
      let spawn = spawns.get(id);
      if (!spawn) { spawn = newSpawn(id); spawns.set(id, spawn); }
      spawn.listed = true;
    }
  } catch {
    state.warnings.add(`${file}: child transcript directory could not be listed; usage coverage may be incomplete`);
  }
}

async function reduceTranscript(file: string, state: State, depth: number, spawn: Spawn | null): Promise<Totals | null> {
  if (state.files.has(file)) return emptyTotals();
  state.files.add(file);
  let text: string | null;
  try { text = await state.readFile(file); }
  catch (error) {
    if (!spawn) throw error;
    text = null;
  }
  if (text === null) {
    if (!spawn) return null;
    if (spawn.listed) state.childSessions += 1;
    state.warnings.add(`${file}: child transcript is missing or unreadable; usage coverage may be incomplete`);
    if (spawn.usage) {
      state.warnings.add(`${file}: using a cumulative task result because its transcript is unavailable; actual per-response model attribution is unknown`);
      addResponse(state, emptyTotals(), file, spawn, spawn.definition, spawn.attribution, 'unknown', 'unknown', spawn.usage, spawn.at, undefined, spawn.requests);
    } else {
      addAgent(state, file, spawn.definition, spawn.attribution, 'unknown', 'unknown', emptyTotals(), spawn.at);
    }
    return null;
  }
  const entries = parseEntries(text, file, state);
  const sessionId = string(entries.find((entry) => entry.type === 'session')?.id);
  if (sessionId) {
    if (state.sessions.has(sessionId)) { state.warnings.add(`${file}: duplicate session transcript ignored`); return emptyTotals(); }
    state.sessions.add(sessionId);
  }
  if (spawn) state.childSessions += 1;
  if (spawn && !spawn.referenced) state.warnings.add(`${file}: child transcript has no matching parent task metadata`);
  const own = emptyTotals();
  let definition = spawn?.definition ?? { name: 'unknown', source: null, path: null, revision: null };
  let attribution = spawn?.attribution ?? UNKNOWN;
  let pendingSelection: Attribution | null = null;
  let sawModelChange = false;
  let responseCount = 0;
  const requests = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'session_init' && string(entry.modelRole)) {
      attribution = { role: string(entry.modelRole), selection: 'role' };
      continue;
    }
    if (entry.type === 'model_change') {
      if (entry.role === 'fallback') { sawModelChange = true; continue; }
      if (entry.role === 'temporary') attribution = { role: null, selection: 'pinned' };
      else if (entry.role !== undefined) attribution = { role: string(entry.role), selection: string(entry.role) ? 'role' : 'unknown' };
      else if ((sawModelChange || responseCount > 0) && entry.resolvedModelIsFallback !== true) attribution = UNKNOWN;
      sawModelChange = true;
      continue;
    }
    if (entry.type === 'custom') {
      const data = object(entry.data);
      if (data?.version === 1 && (entry.customType === 'gitspace-agent-definition' || entry.customType === 'gitspace-model-selection' || entry.customType === 'gitspace-model-usage')) {
        if ((data.role !== null && !string(data.role)) || (data.selection !== 'role' && data.selection !== 'pinned' && data.selection !== 'inherited' && data.selection !== 'unknown')) {
          state.warnings.add(`${file}: malformed historical role/selection metadata; missing attribution remains unknown`);
        }
      }
      if (entry.customType === 'gitspace-agent-definition') {
        if (!data || data.version !== 1 || !string(data.name)) { state.warnings.add(`${file}: malformed historical agent definition record`); continue; }
        definition = { name: string(data.name)!, source: string(data.source), path: string(data.path), revision: string(data.revision) };
        attribution = historicalSelection(data);
      } else if (entry.customType === 'gitspace-model-selection') {
        if (!data || data.version !== 1) { state.warnings.add(`${file}: malformed historical model selection record`); continue; }
        attribution = historicalSelection(data);
        // A controls change while this request runs must not reattribute its eventual response.
        pendingSelection = attribution;
      } else if (entry.customType === 'gitspace-model-usage') {
        const id = string(data?.id);
        const usage = rawUsage(data?.usage);
        if (!data || data.version !== 1 || !id || !string(data.kind) || !usage) { state.warnings.add(`${file}: malformed direct completion usage record; usage coverage may be incomplete`); continue; }
        if (state.completions.has(id)) continue;
        state.completions.add(id);
        addResponse(state, own, file, spawn, definition, historicalSelection(data), string(data.provider) ?? 'unknown', string(data.model) ?? 'unknown', usage, timestamp(entry.timestamp), string(data.kind)!);
        responseCount += 1;
      }
      continue;
    }
    const message = object(entry.message);
    if (entry.type !== 'message' || message?.role !== 'assistant') continue;
    const usage = rawUsage(message.usage);
    if (!usage) { pendingSelection = null; state.warnings.add(`${file}: assistant response is missing valid usage; usage coverage may be incomplete`); continue; }
    const responseId = string(message.responseId);
    if (responseId) {
      const key = JSON.stringify(['assistant', message.provider, responseId]);
      if (requests.has(key)) continue;
      requests.add(key);
    }
    addResponse(state, own, file, spawn, definition, pendingSelection ?? attribution, string(message.provider) ?? 'unknown', string(message.model) ?? 'unknown', usage, timestamp(entry.timestamp));
    pendingSelection = null;
    responseCount += 1;
  }
  if (spawn && responseCount === 0) addAgent(state, file, definition, attribution, 'unknown', 'unknown', own, spawn.at ?? timestamp(entries.find((entry) => entry.type === 'session')?.timestamp));
  const spawns = collectSpawns(entries, file, state);
  await reconcileFiles(file, spawns, state);
  if (depth >= MAX_DEPTH) {
    if (spawns.size > 0) state.warnings.add(`${file}: spawn tree exceeds depth ${MAX_DEPTH}; deeper usage was not included`);
  } else {
    for (const child of spawns.values()) await reduceTranscript(childSessionFileFor(file, child.id), state, depth + 1, child);
  }
  return own;
}

/**
 * This session's totals include its direct completions; all breakdowns cover the full tree.
 * Append order supplies historical attribution. A readable child always wins over parent
 * cumulative results, including empty/zero-usage children. No current settings are consulted.
 */
export async function buildSessionUsageReport(sessionId: string, sessionFile: string, readFile: TranscriptReader, listFiles?: TranscriptLister): Promise<SessionUsageReport | null> {
  const state: State = { readFile, listFiles, files: new Set(), sessions: new Set(), completions: new Set(), totalsDeep: emptyTotals(), childSessions: 0, byModel: new Map(), byRole: new Map(), byAgent: new Map(), byCompletion: new Map(), warnings: new Set() };
  if (!sessionFile.endsWith('.jsonl') || sessionFile.includes('\0') || sessionFile.includes('\\')) return null;
  if (!listFiles) state.warnings.add('Child transcript directory listing is unavailable; unreferenced child sessions may be missing');
  const totals = await reduceTranscript(resolve(sessionFile), state, 0, null);
  if (!totals) return null;
  const byCost = (a: { totals: UsageTotals }, b: { totals: UsageTotals }): number => b.totals.costUsd - a.totals.costUsd;
  return {
    sessionId,
    totals,
    totalsDeep: state.totalsDeep,
    childSessions: state.childSessions,
    byModel: [...state.byModel.values()].sort(byCost),
    byRole: [...state.byRole.values()].map(({ role, models, totals: roleTotals }) => ({ role, models: [...models].sort(), totals: roleTotals })).sort(byCost),
    byAgent: [...state.byAgent.values()].map(({ row }) => row).sort(byCost),
    byCompletion: [...state.byCompletion.values()].sort(byCost),
    warnings: [...state.warnings],
  };
}
