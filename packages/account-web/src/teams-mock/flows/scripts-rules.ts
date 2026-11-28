// Who may approve, revoke and use an approved script, read from the shared stores (env-model.ts): a scope's approver
// (the holder for "For me", the project's Leads for a project, Owners and Admins for the team) must also be allowed to
// use every secret the script needs under that secret's rule. The board's Needs you, the workspace transcript, the
// approval card and the library pages all ask these.
import { principalOf, projectRoleIdOf, PROJECTS, USERS, WORKSPACES } from '../data.js';
import { roleName } from '../settings/roles.js';
import { mayUse, rolesLine } from './secret-rules.js';
import { createStore } from '../store.js';
import { approvedScripts, defaultRule, secretRules, type ApprovedScript, type ScriptScope, type ScriptVersion, type SecretRule } from './env-model.js';

export type ScopeKind = ScriptScope['kind'];

/** The project a script belongs to: its scope's, or the project of the workspace that submitted its newest version. */
export function scriptProject(script: ApprovedScript): string {
  if (script.scope.kind === 'project') return script.scope.projectId;
  return workspaceProject(script.versions[0]?.submittedIn ?? '');
}

export function projectLabel(projectId: string): string { return PROJECTS.find((project) => project.id === projectId)?.name ?? projectId; }

/** "Maya and Theo", "Maya, Theo and Rina". */
export function firstNames(ids: readonly string[]): string {
  const firsts = ids.map((id) => principalOf(id).first);
  return firsts.length <= 2 ? firsts.join(' and ') : `${firsts.slice(0, -1).join(', ')} and ${firsts.at(-1)}`;
}

/** The rule a secret used in `projectId` follows: the project's own, else the team's, else the per-holder value's,
 * else the default for the project. */
export function ruleOf(name: string, projectId: string): { key: string; rule: SecretRule } {
  const rules = secretRules.get();
  for (const key of [`${projectId}:${name}`, `team:${name}`, `personal:${name}`]) {
    const rule = rules[key];
    if (rule) return { key, rule };
  }
  return { key: `${projectId}:${name}`, rule: defaultRule(projectId) };
}

/** Null when `userId` may use the secret in `projectId`, else why not. */
export function secretRefusal(userId: string, name: string, projectId: string): string | null {
  const { key, rule } = ruleOf(name, projectId);
  if (mayUse(userId, rule, key.split(':')[0] ?? projectId)) return null;
  const own = projectRoleIdOf(userId, projectId);
  return `${name} is for ${rolesLine(rule, null)}; ${principalOf(userId).first} is ${own ? `${roleName(own)} in ${projectLabel(projectId)}` : `not in ${projectLabel(projectId)}`}, so can’t approve a script that uses it`;
}

/** The first secret the script needs that `userId` couldn't use, as a reason. */
export function secretsRefusal(userId: string, version: ScriptVersion, projectId: string): string | null {
  for (const name of version.secrets) {
    const reason = secretRefusal(userId, name, projectId);
    if (reason) return reason;
  }
  return null;
}

/** Null when `userId`'s role lets them approve for `scope` (holders: the workspace's holders). */
export function scopeRoleRefusal(userId: string, scope: ScopeKind, projectId: string, holders: readonly string[]): string | null {
  const principal = principalOf(userId);
  if (principal.kind === 'bot') return 'Bots never approve scripts';
  if (scope === 'me') return holders.includes(userId) ? null : 'Only a holder of the workspace approves a script for themselves';
  if (scope === 'project') return projectRoleIdOf(userId, projectId) === 'lead' ? null : `Only ${projectLabel(projectId)}’s Leads approve for the project`;
  return principal.accountRole === 'owner' || principal.accountRole === 'admin' ? null : 'Only Owners and Admins approve for the team';
}

/** Everyone who could approve `version` for `scope`: their role allows it and they may use every secret it needs. */
export function approversFor(scope: ScopeKind, version: ScriptVersion, projectId: string, holders: readonly string[]): readonly string[] {
  return USERS.map((user) => user.id).filter((id) => scopeRoleRefusal(id, scope, projectId, holders) === null && secretsRefusal(id, version, projectId) === null);
}

export function pendingVersion(script: ApprovedScript): ScriptVersion | undefined {
  return script.versions.find((version) => version.state === 'pending');
}
export function currentVersion(script: ApprovedScript): ScriptVersion | undefined {
  return script.versions.find((version) => version.state === 'approved');
}

/** "For me (Sam)", "For Crumb", "For the team". */
export function scopeLabel(scope: ScriptScope): string {
  return scope.kind === 'me' ? `For ${principalOf(scope.userId).first} only` : scope.kind === 'project' ? `For ${projectLabel(scope.projectId)}` : 'For the team';
}
/** The same in running text: "for Sam only", "for Crumb", "for the team". */
export function scopePhrase(scope: ScriptScope): string {
  return `f${scopeLabel(scope).slice(1)}`;
}

/** Null when `userId` may revoke the script: its owner for a personal one, the project's Leads, Owners and Admins for
 * the team. */
export function revokeRefusal(userId: string, script: ApprovedScript): string | null {
  if (script.scope.kind === 'me') return script.scope.userId === userId ? null : `Only ${principalOf(script.scope.userId).first} revokes their own script`;
  return scopeRoleRefusal(userId, script.scope.kind, scriptProject(script), []);
}

/** A run of an interactive script: it pauses at each declared prompt until the right person answers (the answer goes
 * into the process's input, never the transcript or the model), then continues. `step` is the next prompt's index;
 * `answered` lists who answered each one. */
export interface PromptRun { id: string; scriptId: string; version: number; workspaceId: string; step: number; answered: readonly string[]; state: 'paused' | 'done' }
export const scriptRuns = createStore<readonly PromptRun[]>([
  { id: 'run-checkout', scriptId: 'deploy-checkout', version: 1, workspaceId: 'checkout-apple-pay', step: 0, answered: [], state: 'paused' },
  { id: 'run-sso', scriptId: 'aws-sso-sandbox', version: 1, workspaceId: 'bank-feed-sync', step: 0, answered: [], state: 'paused' },
]);

/** Who answers a run's next prompt: the workspace's holders (a bot holder's sponsor in its place), or for `scope`
 * the people who can see that workspace: members of its project, Owners included. Delivered through their Needs you. */
export function promptRecipients(runId: string, holdersOf: (workspaceId: string) => readonly string[]): readonly string[] {
  const run = scriptRuns.get().find((entry) => entry.id === runId);
  const script = approvedScripts.get().find((entry) => entry.id === run?.scriptId);
  const prompt = script?.versions.find((version) => version.n === run?.version)?.prompts[run?.step ?? 0];
  if (!run || !script || !prompt || run.state !== 'paused') return [];
  if (prompt.answeredBy === 'holder') return [...new Set(holdersOf(run.workspaceId).flatMap((id) => {
    const principal = principalOf(id);
    return principal.kind === 'person' ? [id] : principal.sponsor ? [principal.sponsor] : [];
  }))];
  const projectId = workspaceProject(run.workspaceId);
  return USERS.map((user) => user.id).filter((id) => projectRoleIdOf(id, projectId) !== null);
}

/** The project a workspace belongs to. */
export function workspaceProject(workspaceId: string): string {
  return WORKSPACES.find((workspace) => workspace.id === workspaceId)?.projectId ?? 'crumb';
}

/** Who may see a script in the libraries: team ones everyone, a project's its members, a personal one its owner. */
export function canSee(userId: string, script: ApprovedScript): boolean {
  if (script.scope.kind === 'team') return true;
  if (script.scope.kind === 'me') return script.scope.userId === userId;
  return projectRoleIdOf(userId, script.scope.projectId) !== null;
}

/** Who a script's pending version waits on: the approvers of the scope it's requested for. */
export function pendingRecipients(scriptId: string, holdersOf: (workspaceId: string) => readonly string[]): readonly string[] {
  const script = approvedScripts.get().find((entry) => entry.id === scriptId);
  const pending = script ? pendingVersion(script) : undefined;
  if (!script || !pending) return [];
  return approversFor(script.scope.kind, pending, scriptProject(script), holdersOf(pending.submittedIn));
}

/** A version decided in this session (shown in its workspace's transcript), by `${scriptId}@${n}`: approved (`note` is
 * the machine it ran on), declined or sent back with a note, or sent to the approvers of a scope (`note` names them). */
export interface Decision { outcome: 'approved' | 'declined' | 'changes' | 'sent'; by: string; note: string; scope: ScriptScope }
export const scriptDecisions = createStore<Readonly<Record<string, Decision>>>({});

/** A short content hash for a script body (stand-in for the real sha256 prefix). */
export function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0').slice(0, 7);
}

/** Variables the body reads (`$NAME` or `${NAME}`) that are neither its secrets nor its inputs. */
export function undeclared(body: string, version: ScriptVersion): readonly string[] {
  const assigned = [...body.matchAll(/^([A-Z][A-Z0-9_]*)=/gmu)].map((match) => match[1] ?? '');
  const known = new Set([...version.secrets, ...version.inputs.map((input) => input.name), ...version.prompts.map((prompt) => prompt.name), ...assigned, 'HOME', 'PATH']);
  const read = [...body.matchAll(/\$\{?([A-Z][A-Z0-9_]*)\}?/gu)].map((match) => match[1] ?? '');
  return [...new Set(read.filter((name) => name && !known.has(name)))];
}
