// Who may use each secret, and how it reaches work: the rule on every secret row (the team's, a project's, a person's
// or a bot's own, and the values a project asks each holder for). A rule names the roles that may use it (Owners
// always count as Admins), whether only while holding the workspace (dropped on Let go), and its delivery: only to
// approved scripts; in a cleared shell for N minutes after a passkey (the old step-ups; an Admin can forbid it per
// secret, Lead of its project or not); by the browser filling the login form on named sites; or, for a bot's own, to
// approved scripts once its sponsor approves each use with their passkey (a bot has no passkey, so never a shell).
// Here: reading a rule in one line, the Edit rule dialog (a holder may only narrow the project's rule for their own
// value), an Admin forbidding shells on a project secret, the approved scripts a change affects, the step-up into a
// cleared shell, the secrets a workspace may use (for the workspace's Environment popover) and what the browser filled
// in a workspace's transcript.
import { glyph } from '../../glyph.js';
import { Button, InputField, InputGroup, Switch } from '@gitspace/ui';
import { AlertTriangle, Browser, FileCode01, Fingerprint01, GitBranch01, ShieldTick, Terminal } from '@untitledui/icons';
import { useState, type ReactNode } from 'react';
import { bots, findPrincipal, PROJECTS, projectRoleIdOf, principalOf, stepUps, USERS, userOf, WORKSPACES, type Bot, type StepUp } from '../data.js';
import { ACCOUNT_NAME, ACTIVE_PROJECTS, ASKED_LOGINS, PERSONAL_VALUES, projectName, recordAudit, type SecretEntry } from '../settings/data.js';
import { useHeld } from '../settings/parts.js';
import { passkeyLabel, usePasskey } from '../settings/passkey.js';
import { roleName, useRoles, whyAccount } from '../settings/roles.js';
import { useMock, useViewer } from '../viewer.js';
import { sponsorRequests } from './bots-data.js';
import { approvedScripts, defaultRule, secretRules, type ApprovedScript, type Delivery, type ScriptVersion, type SecretRule } from './env-model.js';
import { ChipPicker, ChoiceCards, FlowDialog, FlowError, FlowSuccess, Hint, PasskeyStep, StepButtons, Summary } from './kit.js';
import { secrets } from './team-data.js';
import { valueStates } from './you-data.js';

// ── Reading a rule ──

/** Whose a secret is, from its scope: the team's, a project's, or a person's or bot's own. */
export function scopeKind(scope: string): 'team' | 'project' | 'own' {
  if (scope === 'team') return 'team';
  return PROJECTS.some((project) => project.id === scope) ? 'project' : 'own';
}
/** The bot whose own secret this scope holds, or null. */
export function botOwner(scope: string): Bot | null {
  const principal = findPrincipal(scope);
  return principal?.kind === 'bot' ? principal : null;
}
/** Who approves each use of a bot's sponsor-approved secret: "Theo", or why nobody can now. */
export function sponsorOf(bot: Bot): string {
  return bot.sponsor ? userOf(bot.sponsor).first : 'its sponsor (none now: its sign-ins are blocked)';
}
/** Null when `viewerId` manages `bot`'s secrets (its sponsor, an Owner or an Admin), else why not. */
export function whyManageBot(viewerId: string, bot: Bot): string | null {
  if (bot.sponsor === viewerId || whyAccount(viewerId, 'account.bots') === null) return null;
  return `Only ${bot.sponsor ? `${userOf(bot.sponsor).first} (its sponsor)` : 'its sponsor'}, Owners and Admins manage ${bot.name}’s secrets`;
}

/** What an Edit rule acts on: a secret (team, project or own), the rule a project sets for a value it asks each holder
 * for, or one holder's narrowing of that rule for their own value. */
export type RuleTarget =
  | { kind: 'secret'; secret: SecretEntry }
  | { kind: 'ask'; projectId: string; name: string }
  | { kind: 'holder'; projectId: string; name: string; userId: string };

export function ruleKey(target: RuleTarget): string {
  if (target.kind === 'secret') return `${target.secret.scope}:${target.secret.name}`;
  return target.kind === 'ask' ? `personal:${target.name}` : `${target.userId}:${target.name}`;
}

/** The rule a new secret starts with: the scope's default roles, only while holding, and delivery by sensitivity
 * (sensitive ones only to approved scripts; the rest in a 15-minute cleared shell). A person's own start as a
 * 30-minute cleared shell; a bot's own only to approved scripts. */
export function startingRule(secret: Pick<SecretEntry, 'kind' | 'scope' | 'sensitive'>): SecretRule {
  if (scopeKind(secret.scope) === 'own') return { accountRoles: [], projectRoles: [], whileHolding: true, delivery: botOwner(secret.scope) ? { kind: 'scripts' } : { kind: 'shell', minutes: 30 }, shellForbidden: false };
  const delivery: Delivery = secret.kind === 'value' ? { kind: 'shell', minutes: 0 } : secret.sensitive ? { kind: 'scripts' } : { kind: 'shell', minutes: 15 };
  return { ...defaultRule(secret.scope), delivery };
}

/** The rule in force for a target: its own, else where it starts (a holder's value follows the project's rule). */
export function ruleOf(target: RuleTarget, rules: Readonly<Record<string, SecretRule>>): SecretRule {
  const own = rules[ruleKey(target)];
  if (own) return own;
  if (target.kind === 'secret') return startingRule(target.secret);
  return rules[`personal:${target.name}`] ?? defaultRule(target.projectId);
}
/** The project's rule a holder's own value is bounded by. */
export function askRule(projectId: string, name: string, rules: Readonly<Record<string, SecretRule>>): SecretRule {
  return rules[`personal:${name}`] ?? defaultRule(projectId);
}

function plural(name: string): string { return name.endsWith('s') ? name : `${name}s`; }
export function andList(names: readonly string[]): string {
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
/** An account role as a rule names it: Admins always include Owners. */
function accountLabel(role: string): string {
  return role === 'admin' ? 'Owners and Admins' : plural(roleName(role));
}

/** "Leads and Engineers in Crumb", "Owners and Admins", "Everyone in Crumb & Co", "Only Maya", "Only Release bot". */
export function rolesLine(rule: SecretRule, ownerId: string | null): string {
  if (ownerId) return `Only ${principalOf(ownerId).first}`;
  const parts: string[] = [];
  const account = rule.accountRoles.filter((role) => role !== 'owner' || !rule.accountRoles.includes('admin'));
  if (account.includes('admin') && account.includes('member')) parts.push(`Everyone in ${ACCOUNT_NAME}`);
  else if (account.length) parts.push(andList(account.map(accountLabel)));
  for (const entry of rule.projectRoles) if (entry.roles.length) parts.push(`${andList(entry.roles.map((role) => plural(roleName(role))))} in ${projectName(entry.projectId)}`);
  return parts.length ? parts.join(', ') : 'Nobody';
}
/** How it's delivered, in a few words; `ownerId` names the bot whose sponsor approves a sponsor-approved secret. */
export function deliveryLine(delivery: Delivery, ownerId: string | null = null): string {
  if (delivery.kind === 'scripts') return 'only to approved scripts';
  if (delivery.kind === 'shell') return `in a cleared shell for ${delivery.minutes} min with a passkey`;
  if (delivery.kind === 'autofill') return `browser autofill on ${delivery.origins.join(', ')} (and approved scripts) · the agent never sees it`;
  const bot = ownerId ? botOwner(ownerId) : null;
  return `to approved scripts once ${bot ? sponsorOf(bot) : 'its sponsor'} approves each use with a passkey`;
}
/** The rule in one line: "Leads and Engineers in Crumb · only while holding · only to approved scripts". A value
 * isn't secret: it's plain env wherever its roles may use it. */
export function ruleLine(rule: SecretRule, { value = false, ownerId = null }: { value?: boolean; ownerId?: string | null } = {}): string {
  return [rolesLine(rule, ownerId), rule.whileHolding ? 'only while holding' : 'whoever holds', value ? 'plain env, not secret' : deliveryLine(rule.delivery, ownerId)].join(' · ');
}

/** Whether `principalId` may use a secret with `rule`: a person's or bot's own only by them; otherwise (the team's, a
 * project's, or the `personal` rule a project sets for a value it asks each holder for) by account role (an Owner
 * counts as an Admin) or by project role in a project the rule names. */
export function mayUse(principalId: string, rule: SecretRule, scope: string): boolean {
  if (scope !== 'personal' && scopeKind(scope) === 'own') return principalId === scope;
  const principal = findPrincipal(principalId);
  const account = principal?.accountRole === 'owner' ? ['owner', 'admin'] : principal ? [principal.accountRole] : [];
  if (account.some((role) => rule.accountRoles.includes(role))) return true;
  return rule.projectRoles.some((entry) => { const role = projectRoleIdOf(principalId, entry.projectId); return role !== null && entry.roles.includes(role); });
}

/** Why the viewer may not edit a target's rule, or null: team secrets are the Owners' and Admins'; a project's (and the
 * rule for values it asks of holders) its Leads'; a person's own, and their narrowing of a project's ask, theirs; a
 * bot's own its sponsor's, Owners' and Admins'. */
export function whyRuleEdit(viewerId: string, target: RuleTarget): string | null {
  if (target.kind === 'holder') return viewerId === target.userId ? null : `Only ${userOf(target.userId).first} narrows the rule for their own value`;
  const scope = target.kind === 'secret' ? target.secret.scope : target.projectId;
  const kind = target.kind === 'secret' ? scopeKind(scope) : 'project';
  if (kind === 'team') return whyAccount(viewerId, 'account.credentials');
  if (kind === 'own') {
    const bot = botOwner(scope);
    if (bot) return whyManageBot(viewerId, bot);
    return viewerId === scope ? null : `Only ${userOf(scope).first} edits the rules of their own secrets`;
  }
  const role = projectRoleIdOf(viewerId, scope);
  if (!role) return `You’re not a member of ${projectName(scope)}`;
  return role === 'lead' ? null : `Your project role in ${projectName(scope)} (${roleName(role)}) can’t edit secret rules: only its Leads do`;
}
/** Why the viewer may not forbid (or allow again) shell delivery for a secret, or null: Owners and Admins only, on any
 * team or project secret, Lead of its project or not. */
export function whyForbid(viewerId: string): string | null {
  return whyAccount(viewerId, 'account.credentials') ? 'Only Owners and Admins forbid shell delivery' : null;
}

// ── Approved scripts a rule affects ──

export interface ScriptUse { script: ApprovedScript; version: ScriptVersion }
/** The approved (or waiting) scripts that ask for this secret by name, where it can reach them: any for a team secret;
 * the project's, the team's and holders' own for a project's; the person's own for theirs. */
export function scriptsUsing(target: RuleTarget, scripts: readonly ApprovedScript[]): readonly ScriptUse[] {
  const name = target.kind === 'secret' ? target.secret.name : target.name;
  const scope = target.kind === 'secret' ? target.secret.scope : target.projectId;
  const kind = target.kind === 'secret' ? scopeKind(scope) : 'project';
  return scripts.flatMap((script) => {
    const version = script.versions.find((entry) => entry.state === 'approved' || entry.state === 'pending');
    if (!version || !version.secrets.includes(name)) return [];
    const reaches = kind === 'team' ? true
      : kind === 'own' ? script.scope.kind === 'me' && script.scope.userId === scope
      : script.scope.kind === 'team' || script.scope.kind === 'me' || (script.scope.kind === 'project' && script.scope.projectId === scope);
    return reaches ? [{ script, version }] : [];
  });
}
function scopeLabel(script: ApprovedScript): string {
  return script.scope.kind === 'team' ? 'for the team' : script.scope.kind === 'project' ? `for ${projectName(script.scope.projectId)}` : `for ${userOf(script.scope.userId).first}`;
}
/** Who started a run, from its "agent in slot-picker-ui (Rina)" or "Deps bot (sponsored by Maya)" line. */
function runner(who: string): { id: string; label: string } | null {
  const bot = bots.get().find((entry) => who.startsWith(entry.name));
  if (bot) return { id: bot.id, label: bot.name };
  const user = USERS.find((entry) => who.includes(`(${entry.first})`));
  return user ? { id: user.id, label: user.first } : null;
}
/** What a delivery change does to an approved script that keeps getting the secret. */
function deliveryEffect(name: string, before: Delivery, after: Delivery, ownerId: string | null): string | null {
  if (after.kind === before.kind) return after.kind === 'autofill' && before.kind === 'autofill' && after.origins.join() !== before.origins.join() ? `Keeps getting it. The browser now fills ${name} on ${after.origins.join(', ')}` : null;
  if (after.kind === 'shell') return `Keeps getting it. ${name} now also reaches holders’ cleared shells for ${after.minutes} min after a passkey, outside this script`;
  if (after.kind === 'autofill') return `Keeps getting it. The browser now also fills ${name} on ${after.origins.join(', ')}, outside this script`;
  if (after.kind === 'sponsor') { const bot = ownerId ? botOwner(ownerId) : null; return `Gets it only once ${bot ? sponsorOf(bot) : 'its sponsor'} approves each run with a passkey`; }
  return `Keeps getting it, and becomes the only way agents get ${name}`;
}

/** What a rule change does to each approved script that uses the secret. */
export function AffectedScripts({ target, before, after }: { target: RuleTarget; before: SecretRule; after: SecretRule }) {
  const uses = scriptsUsing(target, approvedScripts.use());
  const name = target.kind === 'secret' ? target.secret.name : target.name;
  const scope = target.kind === 'secret' ? target.secret.scope : target.kind === 'holder' ? target.userId : target.projectId;
  if (!uses.length) return <Hint>No approved script uses {name}.</Hint>;
  return <div data-affected-scripts="" className="flex flex-col gap-2 rounded-xl bg-[color-mix(in_oklab,#f79009_7%,transparent)] px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,#f79009_32%,transparent)]">
    <span className="flex items-center gap-2 text-caption font-medium text-foreground"><AlertTriangle width={15} height={15} strokeWidth={1.75} className="text-[#dc6803]" />{uses.length === 1 ? 'One approved script uses' : `${uses.length} approved scripts use`} {name}</span>
    {uses.map(({ script, version }) => {
      const lost = [...new Map(script.runs.map((run) => runner(run.who)).filter((entry): entry is { id: string; label: string } => entry !== null).map((entry) => [entry.id, entry])).values()]
        .filter((entry) => mayUse(entry.id, before, scope) && !mayUse(entry.id, after, scope));
      const changed = deliveryEffect(name, before.delivery, after.delivery, scopeKind(scope) === 'own' ? scope : null);
      const effect = lost.length ? `Runs started by ${andList(lost.map((entry) => entry.label))} will fail: the new rule leaves them out (they ran it ${script.runs.find((run) => runner(run.who)?.id === lost[0]?.id)?.when ?? 'recently'})`
        : changed ?? (version.state === 'pending' ? 'Waiting for approval; it gets the secret under the new rule once approved' : 'Keeps getting it as before');
      return <div key={script.id} data-affected-script={script.id} className="flex flex-col gap-0.5 rounded-lg bg-surface-1 px-2.5 py-1.5 text-caption">
        <span className="flex flex-wrap items-center gap-1.5 text-foreground"><FileCode01 width={13} height={13} strokeWidth={1.75} /><span className="font-mono">{script.name}</span><span className="text-muted-foreground">v{version.n} · {scopeLabel(script)} · {version.state === 'pending' ? 'waiting for approval' : `approved by ${userOf(version.approvedBy ?? '').first}`}{script.runs[0] ? ` · last run ${script.runs[0].when}` : ''}</span></span>
        <span className={lost.length ? 'text-destructive' : 'text-muted-foreground'}>{effect}.</span>
      </div>;
    })}
  </div>;
}

// ── The rule on a row ──

/** A row's rule line, a forbidden shell, and the approved scripts that use it. */
export function RuleSummary({ target, value = false }: { target: RuleTarget; value?: boolean }) {
  const rules = secretRules.use();
  const scripts = approvedScripts.use();
  useRoles();
  const rule = ruleOf(target, rules);
  const ownerId = target.kind === 'holder' ? target.userId : target.kind === 'secret' && scopeKind(target.secret.scope) === 'own' ? target.secret.scope : null;
  const uses = value ? [] : scriptsUsing(target, scripts);
  const narrowed = target.kind === 'holder' && rules[ruleKey(target)] !== undefined;
  return <span className="mt-1 flex flex-col gap-0.5 text-caption">
    <span data-rule={ruleKey(target)} className="flex items-start gap-1.5 text-foreground">
      <ShieldTick width={13} height={13} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0">{target.kind === 'holder' ? <span className="text-muted-foreground">{narrowed ? 'Narrowed by you: ' : `${projectName(target.projectId)}’s rule: `}</span> : null}{ruleLine(rule, { value, ownerId: target.kind === 'holder' ? null : ownerId })}
        {!value && rule.shellForbidden ? <span data-shell-forbidden="" className="ml-1.5 inline-block rounded-full px-1.5 text-[11px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">shell forbidden by an Admin</span> : null}</span>
    </span>
    {uses.length ? <span className="text-muted-foreground">Used by approved {uses.length === 1 ? 'script' : 'scripts'} {uses.map((use) => use.script.name).join(', ')}</span> : null}
  </span>;
}

// ── Editing a rule ──

interface RuleDraft { roles: ReadonlySet<string>; whileHolding: boolean; delivery: Delivery['kind']; minutes: string; origins: string; forbidden: boolean }
function draftOf(rule: SecretRule, site: string | null): RuleDraft {
  return {
    roles: new Set([...rule.accountRoles.filter((role) => role !== 'owner').map((role) => `account:${role}`), ...rule.projectRoles.flatMap((entry) => entry.roles.map((role) => `${entry.projectId}:${role}`))]),
    whileHolding: rule.whileHolding, delivery: rule.delivery.kind,
    minutes: rule.delivery.kind === 'shell' && rule.delivery.minutes > 0 ? String(rule.delivery.minutes) : '15',
    origins: rule.delivery.kind === 'autofill' ? rule.delivery.origins.join(', ') : site ?? '',
    forbidden: rule.shellForbidden,
  };
}
/** The sites typed into the origins field, as hosts: "https://Staging.crumb.example, kds.crumb.example" →
 * ['staging.crumb.example', 'kds.crumb.example']. */
function parseOrigins(text: string): readonly string[] {
  return text.split(/[\s,]+/).filter(Boolean).map((origin) => origin.replace(/^https:\/\//i, '').toLowerCase());
}
function ruleFromDraft(draft: RuleDraft, keep: SecretRule): SecretRule {
  const picked = ['admin', 'member'].filter((role) => draft.roles.has(`account:${role}`));
  const accountRoles = picked.includes('admin') && keep.accountRoles.includes('owner') ? ['owner', ...picked] : picked;
  const byProject = new Map<string, string[]>();
  for (const id of draft.roles) {
    const [projectId, role] = id.split(':');
    if (!projectId || !role || projectId === 'account') continue;
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), role]);
  }
  const delivery: Delivery = draft.delivery === 'scripts' ? { kind: 'scripts' }
    : draft.delivery === 'sponsor' ? { kind: 'sponsor' }
    : draft.delivery === 'autofill' ? { kind: 'autofill', origins: parseOrigins(draft.origins) }
    : keep.delivery.kind === 'shell' && keep.delivery.minutes === 0 ? keep.delivery : { kind: 'shell', minutes: Number(draft.minutes) };
  return { accountRoles, projectRoles: [...byProject].map(([projectId, roles]) => ({ projectId, roles })), whileHolding: draft.whileHolding, delivery, shellForbidden: draft.forbidden };
}

/** The rule's fields, as the Edit rule dialog and the add flows' last step draw them. */
interface RuleContext {
  name: string;
  /** Account roles and these projects' roles are offered; none: the secret is a person's or a bot's own. */
  projects: readonly string[] | null;
  accountRoles: boolean;
  value: boolean;
  sensitive: boolean;
  /** A login: the browser may fill it on named sites. */
  login: boolean;
  /** The site it's for, offered as the first site to fill it on. */
  site: string | null;
  /** A bot's own: never a shell (a bot has no passkey); its sponsor may approve each use. */
  bot: Bot | null;
  /** A holder's value: the project's rule bounds what they may pick. */
  bound: { rule: SecretRule; projectId: string } | null;
  forbidReason: string | null;
}
function RoleFields({ context, draft, setDraft, error }: { context: RuleContext; draft: RuleDraft; setDraft(next: RuleDraft): void; error: string | null }) {
  const roles = useRoles();
  if (!context.projects) return null;
  return <div className="flex flex-col gap-3">
    {context.accountRoles ? <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Account roles</span>
      <ChipPicker label="Account roles" options={['admin', 'member'].map((role) => ({ id: `account:${role}`, label: accountLabel(role) }))} picked={draft.roles} onChange={(next) => setDraft({ ...draft, roles: next })} /></div> : null}
    {context.projects.map((projectId) => <div key={projectId} className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Project roles in {projectName(projectId)}</span>
      <ChipPicker label={`Project roles in ${projectName(projectId)}`} options={roles.map((role) => ({ id: `${projectId}:${role.id}`, label: plural(role.name) }))} picked={draft.roles} onChange={(next) => setDraft({ ...draft, roles: next })} /></div>)}
    {error ? <FlowError>{error}</FlowError> : <Hint>Someone may use {context.name} when any one of their roles is picked; Owners always count as Admins. Agents and approved scripts act with the roles of whoever started the turn.</Hint>}
  </div>;
}
function boundName(context: RuleContext): string { return context.bound ? projectName(context.bound.projectId) : ''; }
function DeliveryFields({ context, draft, setDraft, errors }: { context: RuleContext; draft: RuleDraft; setDraft(next: RuleDraft): void; errors: { minutes?: string; origins?: string; delivery?: string } }) {
  const bound = context.bound?.rule;
  const shellOff = context.bot ? `${context.bot.name} has no passkey: a cleared shell opens only after a person’s passkey`
    : draft.forbidden ? `An Admin forbade shell delivery for ${context.name}`
    : bound && bound.delivery.kind !== 'shell' ? `${boundName(context)}’s rule doesn’t open it in a shell: you can narrow its rule for your value, not widen it` : null;
  const autofillOff = !context.login ? 'Only for a login: the browser fills a site’s sign-in form with it'
    : bound && bound.delivery.kind !== 'autofill' ? `${boundName(context)}’s rule doesn’t have the browser fill it: you can narrow its rule for your value, not widen it` : null;
  const pick = (id: string): void => { if (id === 'scripts' || id === 'shell' || id === 'autofill' || id === 'sponsor') setDraft({ ...draft, delivery: id }); };
  return <div className="flex flex-col gap-3">
    <Switch label="Only while holding the workspace: dropped on Let go" checked={draft.whileHolding} disabled={Boolean(bound?.whileHolding)} onToggle={() => setDraft({ ...draft, whileHolding: !draft.whileHolding })} />
    {bound?.whileHolding ? <Hint>{boundName(context)}’s rule already requires holding the workspace.</Hint> : null}
    {context.value ? <Hint>A value isn’t secret: every shell of a workspace whose holder may use it gets it as plain env. Make it a secret to pick how it’s delivered.</Hint> : <>
      <ChoiceCards label="Delivery" value={draft.delivery} onChange={pick} choices={[
        { id: 'scripts', title: 'Only to approved scripts', icon: FileCode01, badge: context.sensitive && !context.bot ? <span className="text-caption font-normal text-muted-foreground">default for sensitive</span> : undefined,
          detail: 'Agents run an approved script by name; the secret goes only into that process and its output is redacted. Nothing else in the workspace sees it.' },
        ...(context.bot ? [{ id: 'sponsor', title: `${sponsorOf(context.bot)} approves each use, with a passkey`, icon: Fingerprint01,
          detail: `Each time a turn ${context.bot.name} starts asks for it, the turn waits; ${sponsorOf(context.bot)} approves in Needs you with their passkey, and it goes to that turn’s approved script only.` }] : []),
        { id: 'autofill', title: 'Browser autofill on named sites', icon: Browser, disabled: autofillOff,
          detail: 'The workspace’s browser fills the sign-in form on the sites you list; the agent sees the page signed in, never the value. Approved scripts get it too.' },
        { id: 'shell', title: 'In a cleared shell, with a passkey', icon: Terminal, disabled: shellOff,
          detail: 'After the holder’s passkey, a fresh shell gets it for a set number of minutes, for their own turns only.' },
      ]} />
      {draft.delivery === 'shell' ? <InputGroup className="w-full"><InputField index={0} label={`Minutes after each passkey (1–${bound?.delivery.kind === 'shell' ? bound.delivery.minutes : 60})`} inputMode="numeric" value={draft.minutes} error={errors.minutes} onChange={(text) => setDraft({ ...draft, minutes: text })} /></InputGroup> : null}
      {draft.delivery === 'autofill' ? <div data-autofill-origins="" className="flex flex-col gap-1">
        <InputGroup className="w-full"><InputField index={0} label="Sites it fills on" placeholder={context.site ?? 'staging.crumb.example'} value={draft.origins} error={errors.origins} onChange={(text) => setDraft({ ...draft, origins: text })} /></InputGroup>
        <Hint>Hosts, comma-separated; https only. It fills on any page of each site and nowhere else. {bound?.delivery.kind === 'autofill' ? `${boundName(context)}’s rule fills it on ${bound.delivery.origins.join(', ')}.` : 'The workspace’s browser must be allowed to open each one (the project’s Environment).'}</Hint>
      </div> : null}
      {context.bound || context.bot ? null : <div className="flex flex-col gap-1">
        <Switch label="Forbid shell delivery" checked={draft.forbidden} disabled={context.forbidReason !== null} onToggle={() => setDraft({ ...draft, forbidden: !draft.forbidden })} />
        <Hint>{context.forbidReason ? `${context.forbidReason}.` : 'Owners and Admins only: nobody can pick a cleared shell for this secret until it’s allowed again.'}</Hint>
      </div>}
      {errors.delivery ? <FlowError>{errors.delivery}</FlowError> : null}
    </>}
  </div>;
}
/** Why the typed sites can't be filled, or null. */
function originsError(context: RuleContext, text: string): string | null {
  const typed = text.split(/[\s,]+/).filter(Boolean);
  if (!typed.length) return `Name at least one site the browser fills ${context.name} on, like ${context.site ?? 'staging.crumb.example'}`;
  const seen: string[] = [];
  for (const origin of typed) {
    if (/^http:\/\//i.test(origin)) return `${origin}: https only. The browser never fills a login over plain http`;
    const host = origin.replace(/^https:\/\//i, '').toLowerCase();
    if (host.includes('*')) return `${origin}: no wildcards. Name each site it fills on`;
    if (host.includes('/')) return `${origin}: a site only, without a path. Write ${host.split('/')[0]}; it fills on any of its pages`;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/.test(host)) return `${origin} isn’t a site: write a host like ${context.site ?? 'staging.crumb.example'}`;
    if (seen.includes(host)) return `${host} is listed twice`;
    seen.push(host);
  }
  const bound = context.bound?.rule.delivery;
  const outside = bound?.kind === 'autofill' ? seen.find((host) => !bound.origins.includes(host)) : undefined;
  if (bound?.kind === 'autofill' && outside) return `${outside}: ${boundName(context)}’s rule fills it only on ${bound.origins.join(', ')}. You can narrow it, not widen it`;
  return null;
}
function deliveryErrors(context: RuleContext, draft: RuleDraft): { minutes?: string; origins?: string; delivery?: string } {
  if (context.value) return {};
  if (draft.delivery === 'autofill') {
    if (!context.login) return { delivery: `${context.name} isn’t a login: the browser fills only a sign-in form. Pick another delivery.` };
    const origins = originsError(context, draft.origins);
    return origins ? { origins } : {};
  }
  if (draft.delivery === 'sponsor' && !context.bot) return { delivery: 'Only a bot’s own secret waits for its sponsor’s approval. Pick another delivery.' };
  if (draft.delivery !== 'shell') return {};
  if (context.bot) return { delivery: `${context.bot.name} has no passkey, so never a cleared shell: pick approved scripts or ${sponsorOf(context.bot)}’s approval.` };
  const bound = context.bound?.rule;
  if (draft.forbidden) return { delivery: `Shell delivery is forbidden for ${context.name}: pick approved scripts, or allow shells again.` };
  const minutes = Number(draft.minutes);
  const most = bound?.delivery.kind === 'shell' ? bound.delivery.minutes : 60;
  if (!/^\d+$/.test(draft.minutes.trim()) || minutes < 1 || minutes > 60) return { minutes: 'Between 1 and 60 minutes: for longer, make it an approved script instead.' };
  if (minutes > most) return { minutes: `${boundName(context)}’s rule allows ${most} min at most: you can narrow it, not widen it.` };
  return {};
}
function rolesError(context: RuleContext, draft: RuleDraft): string | null {
  return context.projects && !draft.roles.size ? `Pick at least one role: with none, nobody (and no approved script anyone starts) could use ${context.name}.` : null;
}
/** What a saved rule's delivery does from now on. */
function deliveryNext(rule: SecretRule, ownerId: string | null): string {
  const delivery = rule.delivery;
  if (delivery.kind === 'scripts') return 'From the next request: only approved scripts get it; other processes see nothing.';
  if (delivery.kind === 'shell') return `From the next step-up: a cleared shell for ${delivery.minutes} min after the holder’s passkey.`;
  if (delivery.kind === 'autofill') return `From the next sign-in page: the browser fills it on ${delivery.origins.join(', ')}; the agent sees the form filled, never the value. Approved scripts get it too.`;
  const bot = ownerId ? botOwner(ownerId) : null;
  return `From the next request: each use waits in Needs you for ${bot ? sponsorOf(bot) : 'its sponsor'} to approve with a passkey, and goes to that turn’s approved script only.`;
}

/** The rule step of an add flow: its roles, handle and delivery, starting from `startingRule`. `validate` returns the
 * rule once it's valid (null, with its errors shown, while it isn't). */
export function useRuleStep(secret: Pick<SecretEntry, 'kind' | 'scope' | 'sensitive' | 'name' | 'site'>, viewerId: string): { body: ReactNode; validate(): SecretRule | null; reset(): void } {
  const start = startingRule(secret);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [tried, setTried] = useState(false);
  const kind = scopeKind(secret.scope);
  const bot = botOwner(secret.scope);
  const context: RuleContext = { name: secret.name || 'it', projects: kind === 'own' ? null : kind === 'team' ? ACTIVE_PROJECTS.map((project) => project.id) : [secret.scope], accountRoles: kind !== 'own', value: secret.kind === 'value', sensitive: secret.sensitive,
    login: secret.kind === 'login', site: secret.site ?? null, bot, bound: null, forbidReason: whyForbid(viewerId) };
  const current = draft ?? draftOf(start, context.site);
  const errors = tried ? deliveryErrors(context, current) : {};
  const roleError = tried ? rolesError(context, current) : null;
  return {
    body: <div data-rule-step="" className="flex flex-col gap-4">
      <Hint>{bot ? `Starts as only to approved scripts the turns ${bot.name} starts run. Pick ${sponsorOf(bot)}’s approval for each use instead for anything that publishes or pays.` : `Starts ${secret.sensitive ? 'as sensitive: only approved scripts get it' : 'as not sensitive: a 15-minute cleared shell after the holder’s passkey'}.`} Change it now or later with Edit rule on its row.</Hint>
      <RoleFields context={context} draft={current} setDraft={setDraft} error={roleError} />
      <DeliveryFields context={context} draft={current} setDraft={setDraft} errors={errors} />
    </div>,
    validate() {
      setTried(true);
      if (rolesError(context, current) || Object.keys(deliveryErrors(context, current)).length) return null;
      return ruleFromDraft(current, start);
    },
    reset() { setDraft(null); setTried(false); },
  };
}

function targetName(target: RuleTarget): string { return target.kind === 'secret' ? target.secret.name : target.name; }
function targetWhere(target: RuleTarget): string {
  if (target.kind === 'holder') return `your ${projectName(target.projectId)} value`;
  if (target.kind === 'ask') return `asked of each ${projectName(target.projectId)} holder`;
  const kind = scopeKind(target.secret.scope);
  return kind === 'team' ? 'team secret' : kind === 'project' ? `${projectName(target.secret.scope)} secret` : `${principalOf(target.secret.scope).first}’s own`;
}

/** Edit rule: who may use it, the handle, delivery (and for Admins, forbidding shells), then a review of before and
 * after with the approved scripts the change affects. A holder only narrows the project's rule for their value. */
export function EditRuleDialog({ target, onClose }: { target: RuleTarget; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const rules = secretRules.use();
  const before = ruleOf(target, rules);
  const name = targetName(target);
  const value = target.kind === 'secret' && target.secret.kind === 'value';
  const sensitive = target.kind === 'secret' && target.secret.sensitive;
  const kind = target.kind === 'secret' ? scopeKind(target.secret.scope) : target.kind === 'ask' ? 'project' : 'own';
  const context: RuleContext = {
    name, value, sensitive,
    projects: target.kind === 'holder' || kind === 'own' ? null : kind === 'team' ? ACTIVE_PROJECTS.map((project) => project.id) : [target.kind === 'secret' ? target.secret.scope : target.projectId],
    accountRoles: target.kind === 'secret' && kind !== 'own',
    login: target.kind === 'secret' ? target.secret.kind === 'login' : ASKED_LOGINS[target.name] === true,
    site: target.kind === 'secret' ? target.secret.site ?? null : null,
    bot: target.kind === 'secret' ? botOwner(target.secret.scope) : null,
    bound: target.kind === 'holder' ? { rule: askRule(target.projectId, name, rules), projectId: target.projectId } : null,
    forbidReason: whyForbid(viewer.id),
  };
  const steps = context.projects ? ['Who', 'Handle and delivery', 'Review'] : ['Handle and delivery', 'Review'];
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<RuleDraft>(() => draftOf(before, context.site));
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ closed: readonly StepUp[]; released: boolean } | null>(null);
  const refused = whyRuleEdit(viewer.id, target);
  const page = steps[step];
  const after = ruleFromDraft(draft, before);
  const ownerId = target.kind === 'holder' ? target.userId : kind === 'own' && target.kind === 'secret' ? target.secret.scope : null;
  const scope = target.kind === 'secret' ? target.secret.scope : target.kind === 'holder' ? target.userId : target.projectId;
  if (refused) return <FlowDialog id="edit-rule" title={`Rule for ${name}`} wide={false} onClose={onClose} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
    <FlowError>{refused}.</FlowError>
    <Summary rows={[['Rule now', ruleLine(before, { value, ownerId })]]} />
  </FlowDialog>;
  const next = (): void => {
    setError(null);
    if (page === 'Who') { setTried(true); if (rolesError(context, draft)) return; setTried(false); setStep(step + 1); return; }
    if (page === 'Handle and delivery') { setTried(true); if (Object.keys(deliveryErrors(context, draft)).length) return; setTried(false); setStep(step + 1); return; }
    if (JSON.stringify(before) === JSON.stringify(after)) { setError('Nothing changed: change the rule, or cancel.'); return; }
    secretRules.set({ ...secretRules.get(), [ruleKey(target)]: after });
    const closed = stepUps.get().filter((entry) => entry.credential === name && (after.delivery.kind !== 'shell' || (scopeKind(scope) !== 'own' && target.kind === 'secret' && !mayUse(entry.userId, after, scope))));
    if (closed.length) stepUps.set(stepUps.get().filter((entry) => !closed.includes(entry)));
    const waiting = sponsorRequests.get()[ruleKey(target)];
    const released = waiting !== undefined && after.delivery.kind !== 'sponsor';
    if (released) sponsorRequests.set(Object.fromEntries(Object.entries(sponsorRequests.get()).filter(([key]) => key !== ruleKey(target))));
    recordAudit({ actor: viewer.id, kind: 'setting', project: kind === 'project' ? (target.kind === 'secret' ? target.secret.scope : target.projectId) : target.kind === 'holder' ? target.projectId : undefined,
      text: `${target.kind === 'holder' ? 'Narrowed the rule for their own' : 'Changed the rule for'} ${targetWhere(target)} ${name}: ${ruleLine(after, { value, ownerId })}${after.shellForbidden !== before.shellForbidden ? ` · shell delivery ${after.shellForbidden ? 'forbidden' : 'allowed'}` : ''}` });
    say(`Rule saved for ${name}`);
    setSaved({ closed, released });
  };
  const lockedOut = !ownerId && mayUse(viewer.id, before, scope) && !mayUse(viewer.id, after, scope);
  return <FlowDialog id="edit-rule" steps={steps} step={step} done={saved !== null} onClose={onClose}
    title={saved ? `${name}’s rule saved` : target.kind === 'holder' ? `Narrow the rule for your ${name}` : `Edit rule · ${name}`}
    description={saved ? undefined : target.kind === 'holder' ? `${projectName(target.projectId)}’s rule bounds it: you can narrow it for your own value, never widen it.` : `${targetWhere(target)[0]?.toUpperCase() ?? ''}${targetWhere(target).slice(1)} · who may use it and how it reaches their work.`}
    footer={saved ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setError(null); setTried(false); setStep(step - 1); }} onCancel={onClose} next={next} nextLabel={page === 'Review' ? 'Save rule' : 'Next'} />}>
    {saved ? <FlowSuccess title={ruleLine(after, { value, ownerId })}>
      {value ? 'Plain env from each workspace’s next turn.' : deliveryNext(after, ownerId)}
      {saved.closed.length ? ` Closed ${saved.closed.map((entry) => `${userOf(entry.userId).first}’s shell in ${entry.workspaceId}`).join(', ')}.` : ''}{saved.released ? ' The request waiting in Needs you is released under the new rule.' : ''} In the audit log.
    </FlowSuccess> : null}
    {!saved && page === 'Who' ? <RoleFields context={context} draft={draft} setDraft={setDraft} error={tried ? rolesError(context, draft) : null} /> : null}
    {!saved && page === 'Handle and delivery' ? <>
      {context.projects ? null : <Summary rows={[['Who', target.kind === 'holder' ? 'Only you: your own value, for turns you start' : context.bot ? `Only ${context.bot.name}: it’s its own, for turns it starts` : `Only ${principalOf(scope).first}: it’s their own`]]} />}
      <DeliveryFields context={context} draft={draft} setDraft={setDraft} errors={tried ? deliveryErrors(context, draft) : {}} />
    </> : null}
    {!saved && page === 'Review' ? <>
      <Summary rows={[
        ['Who', <Change key="who" from={rolesLine(before, ownerId)} to={rolesLine(after, ownerId)} />],
        ['Handle', <Change key="handle" from={before.whileHolding ? 'Only while holding' : 'Whoever holds'} to={after.whileHolding ? 'Only while holding' : 'Whoever holds'} />],
        ...(value ? [] : [
          ['Delivery', <Change key="delivery" from={deliveryLine(before.delivery, ownerId)} to={deliveryLine(after.delivery, ownerId)} />] as const,
          ...(context.bound || context.bot ? [] : [['Shell delivery', <Change key="shell" from={before.shellForbidden ? 'Forbidden by an Admin' : 'Allowed'} to={after.shellForbidden ? 'Forbidden by an Admin' : 'Allowed'} />] as const]),
        ]),
      ]} />
      {lockedOut ? <FlowError>You won’t be able to use {name} yourself under the new rule.</FlowError> : null}
      {value ? null : <AffectedScripts target={target} before={before} after={after} />}
      {error ? <FlowError>{error}</FlowError> : null}
    </> : null}
  </FlowDialog>;
}
function Change({ from, to }: { from: string; to: string }) {
  if (from === to) return <span className="text-muted-foreground">{to} (unchanged)</span>;
  return <span className="flex flex-col"><span className="text-muted-foreground line-through">{from}</span><span className="font-medium">{to}</span></span>;
}

// ── An Admin forbidding shells on a project secret ──

/** Whether the viewer gets a row's Forbid shell (or Allow shell) action: an Owner or Admin on a project secret whose
 * rule they can't edit (they aren't its Lead). Its Leads, and Admins on team secrets, use the switch in Edit rule. */
export function forbidOnly(viewerId: string, secret: SecretEntry): boolean {
  return scopeKind(secret.scope) === 'project' && secret.kind !== 'value' && whyForbid(viewerId) === null && whyRuleEdit(viewerId, { kind: 'secret', secret }) !== null;
}

/** Forbid (or allow again) shell delivery for a project secret, as an Admin who isn't its Lead. Forbidding a secret
 * delivered in a cleared shell moves it to approved scripts only and closes the shells open with it; the rest of its
 * rule stays its Leads'. */
export function ForbidShellDialog({ secret, onClose }: { secret: SecretEntry; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const rules = secretRules.use();
  const live = stepUps.use();
  useRoles();
  const [done, setDone] = useState<{ moved: boolean; closed: readonly StepUp[] } | null>(null);
  const target: RuleTarget = { kind: 'secret', secret };
  const before = ruleOf(target, rules);
  const forbid = done ? before.shellForbidden : !before.shellForbidden;
  const project = projectName(secret.scope);
  const role = projectRoleIdOf(viewer.id, secret.scope);
  const leads = USERS.filter((user) => projectRoleIdOf(user.id, secret.scope) === 'lead' && user.accountRole !== 'owner').map((user) => user.first);
  const open = live.filter((entry) => entry.credential === secret.name && WORKSPACES.find((workspace) => workspace.id === entry.workspaceId)?.projectId === secret.scope);
  const moves = before.delivery.kind === 'shell';
  const save = (): void => {
    const after: SecretRule = forbid ? { ...before, shellForbidden: true, delivery: moves ? { kind: 'scripts' } : before.delivery } : { ...before, shellForbidden: false };
    secretRules.set({ ...secretRules.get(), [ruleKey(target)]: after });
    if (forbid && open.length) stepUps.set(stepUps.get().filter((entry) => !open.includes(entry)));
    recordAudit({ actor: viewer.id, kind: 'setting', project: secret.scope,
      text: `${forbid ? 'Forbade' : 'Allowed'} shell delivery for ${project} secret ${secret.name} as ${userOf(viewer.id).accountRole === 'owner' ? 'Owner' : 'Admin'} (${role ? `${roleName(role)} in ${project}` : `not in ${project}`})${forbid && moves ? ' · now only to approved scripts' : ''}` });
    say(`${forbid ? 'Shell delivery forbidden' : 'Shell delivery allowed'} for ${secret.name}`);
    setDone({ moved: forbid && moves, closed: forbid ? open : [] });
  };
  return <FlowDialog id="forbid-shell" wide={false} done={done !== null} onClose={onClose}
    title={done ? `${secret.name}: shell delivery ${forbid ? 'forbidden' : 'allowed'}` : `${forbid ? 'Forbid' : 'Allow'} shell delivery for ${secret.name}?`}
    description={done ? undefined : `${project} secret · you’re ${role ? `${roleName(role)} in ${project}, not its Lead` : `not in ${project}`}. As an Admin you may ${forbid ? 'forbid' : 'allow'} cleared shells for it; the rest of its rule is ${leads.length === 1 ? `${leads[0]}’s` : 'its Leads’'} to edit.`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" leadingIcon={glyph(Terminal)} onClick={save}>{forbid ? 'Forbid shell delivery' : 'Allow shell delivery'}</Button></>}>
    {done ? <FlowSuccess title={ruleLine(ruleOf(target, rules))}>
      {forbid ? `Nobody can pick a cleared shell for ${secret.name} until an Owner or Admin allows it again.${done.moved ? ' It now goes only to approved scripts.' : ''}${done.closed.length ? ` Closed ${done.closed.map((entry) => `${userOf(entry.userId).first}’s shell in ${entry.workspaceId}`).join(', ')}.` : ''}` : `${project}’s Leads may pick a cleared shell for it again in Edit rule; its delivery stays as it is until they do.`} ${leads.length ? `${andList(leads)} ${leads.length === 1 ? 'is' : 'are'} told. ` : ''}In the audit log.
    </FlowSuccess> : <>
      <Summary rows={[['Rule now', ruleLine(before)], ['Shell delivery', before.shellForbidden ? 'Forbidden by an Admin' : 'Allowed']]} />
      {forbid && moves ? <FlowError>{secret.name} is delivered in a cleared shell now: forbidding moves it to only approved scripts{open.length ? `, and closes ${open.map((entry) => `${userOf(entry.userId).first}’s shell in ${entry.workspaceId}`).join(', ')}` : ''}.</FlowError> : null}
      {forbid && !moves ? <Hint>It isn’t delivered in a shell now ({deliveryLine(before.delivery)}); forbidding keeps its Leads from picking one.</Hint> : null}
      {forbid && moves ? <AffectedScripts target={target} before={before} after={{ ...before, shellForbidden: true, delivery: { kind: 'scripts' } }} /> : null}
    </>}
  </FlowDialog>;
}

// ── Cleared shells (step-ups) ──

/** A secret a step-up opens: its name, whose it is (its scope: the team, a project, or a person), what it unlocks, and
 * for a person's value a project asks for, that project (its rule bounds the person's). */
export interface ShellTarget { name: string; scope: string; what: string; askedBy?: string }

function shellRule(target: ShellTarget, rules: Readonly<Record<string, SecretRule>>): SecretRule {
  const own = rules[`${target.scope}:${target.name}`];
  if (own) return own;
  return target.askedBy ? askRule(target.askedBy, target.name, rules) : defaultRule(target.scope);
}
/** The project whose workspaces a step-up may open in, or null for any workspace the person holds. */
function shellProject(target: ShellTarget): string | null {
  return target.askedBy ?? (scopeKind(target.scope) === 'project' ? target.scope : null);
}

/** Why `viewerId` may not open a cleared shell with this secret now, or null. */
export function whyNoShell(viewerId: string, target: ShellTarget, rules: Readonly<Record<string, SecretRule>>): string | null {
  const rule = shellRule(target, rules);
  if (rule.shellForbidden) return `An Admin forbade shell delivery for ${target.name}`;
  if (rule.delivery.kind !== 'shell') return `${target.name}’s rule delivers it ${deliveryLine(rule.delivery, scopeKind(target.scope) === 'own' ? target.scope : null)}, not in a shell`;
  if (!mayUse(viewerId, rule, target.scope)) return scopeKind(target.scope) === 'own' ? `Only ${principalOf(target.scope).first} steps up their own ${target.name}, with their passkey` : `Your roles aren’t in ${target.name}’s rule (${rolesLine(rule, null)})`;
  return null;
}

/** Step up: pick a workspace you hold (in the secret's project), confirm with your passkey, and a cleared shell has the
 * secret there for the rule's minutes, for your own turns only. */
export function StepUpDialog({ target, workspaceId, onClose }: { target: ShellTarget; workspaceId?: string; onClose(): void }) {
  const viewer = useViewer();
  const passkey = usePasskey();
  const rules = secretRules.use();
  const live = stepUps.use();
  const project = shellProject(target);
  const held = useHeld()(viewer.id).filter((id) => !project || WORKSPACES.find((workspace) => workspace.id === id)?.projectId === project);
  const [workspace, setWorkspace] = useState(workspaceId ?? held[0] ?? '');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const rule = shellRule(target, rules);
  const minutes = rule.delivery.kind === 'shell' ? rule.delivery.minutes : 0;
  const refused = whyNoShell(viewer.id, target, rules);
  const open = (): void => {
    const already = live.find((entry) => entry.userId === viewer.id && entry.credential === target.name && entry.workspaceId === workspace);
    if (already) { setError(`Already open in ${workspace}, ${already.minutesLeft} min left. Drop it first, or use the one that’s open.`); return; }
    passkey.confirm(() => {
      stepUps.set([...stepUps.get(), { id: `su-${Date.now().toString(36)}`, credential: target.name, userId: viewer.id, workspaceId: workspace, scope: target.what, minutesLeft: minutes }]);
      recordAudit({ actor: viewer.id, kind: 'resource', text: `Stepped up ${target.name} in ${workspace}: cleared shell for ${minutes} min · ${passkeyLabel(viewer.id)}`, project: WORKSPACES.find((entry) => entry.id === workspace)?.projectId });
      setDone(true);
    });
  };
  return <FlowDialog id="step-up-now" title={done ? `${target.name} is open in ${workspace}` : `Step up: ${target.name}`} wide={false} steps={['Workspace', 'Passkey']} step={passkey.waiting ? 1 : 0} done={done} onClose={onClose}
    description={done ? undefined : `${target.what} · in a cleared shell for ${minutes} min with a passkey · only your turns`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" disabled={passkey.waiting} onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={Boolean(refused) || !held.length || passkey.waiting} loading={passkey.waiting} onClick={open}>Unlock with passkey</Button></>}>
    {done ? <FlowSuccess title={`Cleared shell for ${minutes} min`}>Turns you start in {workspace} get {target.name} in a fresh shell with only it added; it closes after {minutes} min. Co-holders’ turns don’t get it. Letting go closes it; so does Drop. In the audit log.</FlowSuccess> : <>
      {refused ? <FlowError>{refused}.</FlowError> : held.length ? <ChoiceCards label="Workspace" value={workspace} onChange={(id) => { setWorkspace(id); setError(null); }} choices={held.map((id) => ({ id, title: id, detail: projectName(WORKSPACES.find((entry) => entry.id === id)?.projectId ?? ''), icon: GitBranch01 }))} />
        : <FlowError>You don’t hold {project ? `a ${projectName(project)} workspace` : 'any workspace'} right now. A step-up works only in a workspace you hold: claim or take one, then step up.</FlowError>}
      {error ? <FlowError>{error}</FlowError> : null}
      {refused ? null : <PasskeyStep userId={viewer.id} what={`unlocking ${target.name}`} waiting={passkey.waiting} />}
    </>}
  </FlowDialog>;
}

/** Closes a cleared shell early. */
export function dropShell(entry: StepUp): void { stepUps.set(stepUps.get().filter((candidate) => candidate.id !== entry.id)); }

// ── The secrets a workspace may use ──

export interface WorkspaceSecret {
  /** The rule's key (`crumb:REDIS_URL`, `maya:NPM_TOKEN`, `rina:STAGING_LOGIN`). */
  key: string;
  name: string;
  /** The team's, the project's, the viewer's own, or the viewer's value the project asks for. */
  from: 'team' | 'project' | 'own' | 'asked';
  detail: string;
  rule: SecretRule;
  /** The rule in one line. */
  line: string;
  /** Why the viewer can't use it in this workspace now, or null. */
  blocked: string | null;
  /** For a cleared-shell secret: what StepUpDialog opens, and the viewer's shell open here now. */
  shell: { target: ShellTarget; open: StepUp | null } | null;
}

/** The secrets a workspace's turns may get for `viewerId`: the team's and its project's (by rule), the viewer's own
 * cleared-shell secrets and the values the project asks them for. Subscribes to every store it reads. */
export function useWorkspaceSecrets(workspaceId: string, viewerId: string): readonly WorkspaceSecret[] {
  const list = secrets.use();
  const rules = secretRules.use();
  const live = stepUps.use();
  const values = valueStates.use();
  const holding = useHeld()(viewerId).includes(workspaceId);
  useRoles();
  const projectId = WORKSPACES.find((workspace) => workspace.id === workspaceId)?.projectId ?? '';
  const shellOf = (name: string, scope: string, what: string, rule: SecretRule, askedBy?: string): WorkspaceSecret['shell'] =>
    rule.delivery.kind === 'shell' && rule.delivery.minutes > 0 ? { target: { name, scope, what, askedBy }, open: live.find((entry) => entry.userId === viewerId && entry.workspaceId === workspaceId && entry.credential === name) ?? null } : null;
  const blockedBy = (rule: SecretRule, scope: string, name: string): string | null =>
    !mayUse(viewerId, rule, scope) ? `Your roles aren’t in ${name}’s rule` : rule.whileHolding && !holding ? 'Only while holding: you don’t hold this workspace' : null;
  const fromSecrets = list.filter((secret) => secret.scope === 'team' || secret.scope === projectId || secret.scope === viewerId).map((secret): WorkspaceSecret => {
    const target: RuleTarget = { kind: 'secret', secret };
    const rule = ruleOf(target, rules);
    const from = secret.scope === 'team' ? 'team' : secret.scope === projectId ? 'project' : 'own';
    return { key: ruleKey(target), name: secret.name, from, detail: secret.detail, rule, line: ruleLine(rule, { value: secret.kind === 'value', ownerId: from === 'own' ? viewerId : null }),
      blocked: blockedBy(rule, secret.scope, secret.name), shell: secret.kind === 'value' ? null : shellOf(secret.name, secret.scope, secret.detail, rule) };
  }).filter((entry) => entry.from !== 'own' || entry.shell !== null);
  const asked = (PERSONAL_VALUES[viewerId] ?? []).filter((value) => value.projectId === projectId).map((value): WorkspaceSecret => {
    const target: RuleTarget = { kind: 'holder', projectId, name: value.name, userId: viewerId };
    const rule = ruleOf(target, rules);
    const set = values[`${viewerId}:${projectId}:${value.name}`]?.set ?? value.set;
    return { key: ruleKey(target), name: value.name, from: 'asked', detail: value.detail, rule, line: ruleLine(rule), blocked: set ? (holding ? null : 'Only while you hold this workspace') : 'You haven’t set it: You › My secrets',
      shell: set ? shellOf(value.name, viewerId, value.detail, rule, projectId) : null };
  });
  return [...fromSecrets, ...asked];
}

// ── What the browser filled, in a workspace's transcript ──

/** Sign-in forms the workspace's browser filled from a secret whose rule has it fill them: the secret, the site, whose
 * value (a holder's own, or the project's), minutes ago. */
const AUTOFILLS: Readonly<Record<string, ReadonlyArray<{ name: string; origin: string; whose: string; minutesAgo: number }>>> = {
  'slot-holds': [{ name: 'STAGING_LOGIN', origin: 'staging.crumb.example', whose: 'rina', minutesAgo: 14 }],
  'kitchen-display-queue': [{ name: 'KDS_PASSKEY', origin: 'kds.crumb.example', whose: 'crumb', minutesAgo: 9 }],
};

/** A transcript line for each sign-in form the browser filled: the agent saw the page signed in, never the value. */
export function AutofillEvents({ workspaceId }: { workspaceId: string }) {
  return <>{(AUTOFILLS[workspaceId] ?? []).map((entry) => <p key={`${entry.name}-${entry.origin}`} data-autofill-event={entry.name} className="flex flex-wrap items-center justify-center gap-1.5 text-[11.5px] text-muted-foreground">
    <span className="h-px w-8 bg-border" />
    <Browser width={13} height={13} strokeWidth={1.75} />
    <span className="text-foreground">Filled <span className="font-mono">{entry.name}</span> on <span className="font-mono">{entry.origin}</span> · value not shown</span>
    <span>· {scopeKind(entry.whose) === 'own' ? `${userOf(entry.whose).first}’s own value` : `${projectName(entry.whose)} secret`} · browser autofill · {new Date(Date.now() - entry.minutesAgo * 60_000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
    <span className="h-px w-8 bg-border" />
  </p>)}</>;
}
