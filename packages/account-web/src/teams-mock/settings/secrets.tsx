// Secrets, drawn the same on every page that keeps them: the team's (Crumb & Co › Secrets), each project's (its
// settings › Secrets, with the values it asks of each holder), each person's own (You › My secrets, the old step-up
// credentials) and each bot's own (its secrets page: its sponsor, Owners and Admins manage them). Every row shows its
// rule in one line (who may use it, only while holding, how it's delivered) with Edit rule, Rotate or Replace (Edit for
// a value), for a cleared-shell secret Step up, with the shells open now and Drop, and for an Admin who isn't a project
// secret's Lead, Forbid shell. Values are write-only except plain values.
import { glyph } from '../../glyph.js';
import { Button, InputField, InputGroup } from '@gitspace/ui';
import { Cloud01, Fingerprint01, Key01, Lock01, Passcode, Plus, Terminal, Users01 } from '@untitledui/icons';
import type { IconComponent } from '@gitspace/ui';
import { useState } from 'react';
import { actorLabel, bots, stepUps, USERS, userOf, type Bot, type Principal, type StepUp } from '../data.js';
import { sponsorRequests } from '../flows/bots-data.js';
import { secretRules, type SecretRule } from '../flows/env-model.js';
import { ChoiceCards, FlowDialog, FlowSuccess, Hint, PasskeyStep, StepButtons, Summary } from '../flows/kit.js';
import { AddOwnSecretFlow, ConfirmFlow } from '../flows/resources.js';
import { botOwner, EditRuleDialog, ForbidShellDialog, forbidOnly, ruleLine, ruleOf, RuleSummary, scopeKind, sponsorOf, StepUpDialog, useRuleStep, whyManageBot, whyNoShell, whyRuleEdit, type RuleTarget, type ShellTarget } from '../flows/secret-rules.js';
import { AddTeamSecretFlow, RotateSecretDialog } from '../flows/team.js';
import { secrets } from '../flows/team-data.js';
import { valueStates } from '../flows/you-data.js';
import { revokeIn, revokeOnly, type ScopeInfo } from '../scope.js';
import { useMock, useViewer } from '../viewer.js';
import { PERSONAL_VALUES, recordAudit, SECRET_KIND_LABEL, type SecretEntry, type SecretKind } from './data.js';
import { Act, Note, Pill, Section, SettingRow, SettingRows } from './parts.js';
import { passkeyLabel, usePasskey } from './passkey.js';
import { useRoles, whyAccount } from './roles.js';

const KIND_ICON: Readonly<Record<SecretKind, IconComponent>> = { value: glyph(Key01), secret: glyph(Lock01), token: glyph(Terminal), login: glyph(Passcode), session: glyph(Cloud01) };

type RowFlow = { kind: 'rule'; target: RuleTarget } | { kind: 'rotate'; secret: SecretEntry } | { kind: 'step-up'; target: ShellTarget } | { kind: 'drop'; entry: StepUp } | { kind: 'forbid'; secret: SecretEntry } | { kind: 'remove'; secret: SecretEntry };

/** The secrets of one scope (`team`, a project's id, or a person's or bot's id) with their rules. `reason` refuses
 * Rotate and Edit (a value) and, for a bot's own, Remove; `info` is set for a person's own, whose open shells an Owner
 * or Admin may drop from their scope. */
export function SecretsList({ scope, reason, info }: { scope: string; reason: string | null; info?: ScopeInfo }) {
  const viewer = useViewer();
  const { say } = useMock();
  const list = secrets.use().filter((secret) => secret.scope === scope);
  const rules = secretRules.use();
  const live = stepUps.use();
  const waiting = sponsorRequests.use();
  useRoles();
  const [flow, setFlow] = useState<RowFlow | null>(null);
  const close = (): void => setFlow(null);
  const own = scopeKind(scope) === 'own';
  const bot = botOwner(scope);
  if (!list.length) return <Note>None yet.</Note>;
  return <>
    <SettingRows label="Secrets">{list.map((secret) => {
      const target: RuleTarget = { kind: 'secret', secret };
      const rule = ruleOf(target, rules);
      const shell = secret.kind !== 'value' && rule.delivery.kind === 'shell' && rule.delivery.minutes > 0;
      const open = live.filter((entry) => entry.credential === secret.name && (!own || entry.userId === scope));
      const shellTarget: ShellTarget = { name: secret.name, scope, what: secret.detail };
      const request = waiting[`${scope}:${secret.name}`];
      return <SettingRow key={secret.id} media={KIND_ICON[secret.kind]}
        title={<span data-secret={secret.name} className="inline-flex flex-wrap items-center gap-2"><span className="font-mono">{secret.name}</span><Pill>{SECRET_KIND_LABEL[secret.kind]}</Pill>
          {secret.sensitive ? <Pill tone="amber">Sensitive</Pill> : null}{secret.failing ? <Pill tone="red">{secret.failing}</Pill> : secret.expires !== null && secret.expires > 0 && secret.expires <= 14 ? <Pill tone="amber">Expires in {secret.expires} days</Pill> : null}
          {secret.kind !== 'value' && rule.delivery.kind === 'autofill' ? <Pill tone="teal">Browser autofill</Pill> : null}
          {rule.delivery.kind === 'sponsor' ? <Pill tone="violet">Sponsor approves each use</Pill> : null}
          {open.map((entry) => <Pill key={entry.id} tone="violet">{own ? '' : `${userOf(entry.userId).first} · `}open in {entry.workspaceId} · {entry.minutesLeft} min left</Pill>)}</span>}
        description={<>{secret.kind === 'value' ? <span className="font-mono">{secret.detail}</span> : <>•••••••• · {secret.detail}</>}{secret.site ? <> · <span className="font-mono">{secret.site}</span></> : null}{secret.username ? ` · ${secret.username}` : ''} · updated {secret.updated} · last used {secret.lastUsed}</>}
        extra={<>
          <RuleSummary target={target} value={secret.kind === 'value'} />
          {request ? <span className="text-caption text-foreground">Asked in {request.workspace} for {request.why} · waiting for {bot ? sponsorOf(bot) : 'its sponsor'} in Needs you</span> : null}
          {secret.rotation ? <span className={`text-caption ${secret.failing ? 'text-destructive' : 'text-muted-foreground'}`}>{secret.rotation}</span> : null}
        </>}>
        {open.filter((entry) => entry.userId === viewer.id || info?.access === 'revoke').map((entry) => <Act key={entry.id} reason={null} variant="ghost" aria-label={`Drop ${secret.name} in ${entry.workspaceId}`} onClick={() => setFlow({ kind: 'drop', entry })}>Drop</Act>)}
        {shell ? <Act reason={whyNoShell(viewer.id, shellTarget, rules) ?? (info ? revokeOnly(info, viewer) : null)} variant="ghost" leadingIcon={glyph(Fingerprint01)} aria-label={`Step up ${secret.name}`} onClick={() => setFlow({ kind: 'step-up', target: shellTarget })}>Step up</Act> : null}
        {forbidOnly(viewer.id, secret) ? <Act reason={null} variant="ghost" leadingIcon={glyph(Terminal)} aria-label={`${rule.shellForbidden ? 'Allow' : 'Forbid'} shell for ${secret.name}`} onClick={() => setFlow({ kind: 'forbid', secret })}>{rule.shellForbidden ? 'Allow shell' : 'Forbid shell'}</Act> : null}
        <Act reason={whyRuleEdit(viewer.id, target)} variant="ghost" aria-label={`Edit rule for ${secret.name}`} onClick={() => setFlow({ kind: 'rule', target })}>Edit rule</Act>
        <Act reason={reason} variant={secret.failing ? 'primary' : 'ghost'} aria-label={`${secret.kind === 'value' ? 'Edit' : secret.failing ? 'Replace' : 'Rotate'} ${secret.name}`} onClick={() => setFlow({ kind: 'rotate', secret })}>{secret.kind === 'value' ? 'Edit' : secret.failing ? 'Replace' : 'Rotate'}</Act>
        {bot ? <Act reason={reason} variant="ghost" aria-label={`Remove ${secret.name}`} onClick={() => setFlow({ kind: 'remove', secret })}>Remove</Act> : null}
      </SettingRow>;
    })}</SettingRows>
    {flow?.kind === 'rule' ? <EditRuleDialog target={flow.target} onClose={close} /> : null}
    {flow?.kind === 'forbid' ? <ForbidShellDialog secret={flow.secret} onClose={close} /> : null}
    {flow?.kind === 'rotate' ? <RotateSecretDialog secret={flow.secret} onClose={close} /> : null}
    {flow?.kind === 'step-up' ? <StepUpDialog target={flow.target} onClose={close} /> : null}
    {flow?.kind === 'remove' && bot ? <ConfirmFlow id="remove-bot-secret" title={`Remove ${flow.secret.name} from ${bot.name}?`} confirmLabel="Remove" onClose={close}
      description={`The value is deleted. Turns ${bot.name} starts stop getting it; a turn that has it now keeps it until it ends.${waiting[`${scope}:${flow.secret.name}`] ? ' The request waiting in Needs you is refused.' : ''}`}
      success={{ title: `${bot.name} no longer has ${flow.secret.name}`, body: `Revoke it where it was made too${flow.secret.site ? ` (${flow.secret.site})` : ''}. In the audit log.` }}
      onConfirm={() => {
        const key = `${scope}:${flow.secret.name}`;
        secrets.set(secrets.get().filter((candidate) => candidate.id !== flow.secret.id));
        secretRules.set(Object.fromEntries(Object.entries(secretRules.get()).filter(([candidate]) => candidate !== key)));
        sponsorRequests.set(Object.fromEntries(Object.entries(sponsorRequests.get()).filter(([candidate]) => candidate !== key)));
        recordAudit({ actor: viewer.id, kind: 'bot', text: `Removed ${actorLabel(bot.id)}’s secret ${flow.secret.name}` });
        say(`Removed ${flow.secret.name} from ${bot.name}`);
      }} /> : null}
    {flow?.kind === 'drop' ? <ConfirmFlow id="drop-step-up" title={`Drop ${flow.entry.credential} in ${flow.entry.workspaceId}?`} confirmLabel="Drop" onClose={close}
      description={flow.entry.userId === viewer.id ? `Its cleared shell closes now, ${flow.entry.minutesLeft} min early. Step up again with your passkey any time.` : `${userOf(flow.entry.userId).first}’s cleared shell in ${flow.entry.workspaceId} closes now. ${userOf(flow.entry.userId).first} is told in their Inbox and it’s in the audit log.`}
      success={{ title: `${flow.entry.credential} dropped`, body: flow.entry.userId === viewer.id ? 'Nothing in that workspace can use it now.' : `${userOf(flow.entry.userId).first} is told; in the audit log.` }}
      onConfirm={() => {
        stepUps.set(stepUps.get().filter((candidate) => candidate.id !== flow.entry.id));
        const holder = USERS.find((user) => user.id === flow.entry.userId) ?? null;
        revokeIn(flow.entry.userId === viewer.id ? { scope: 'mine', access: 'own', target: holder, teamReason: null } : { scope: flow.entry.userId, access: 'revoke', target: holder, teamReason: null }, viewer, flow.entry.id, `cleared shell ${flow.entry.credential} in ${flow.entry.workspaceId}`, 'dropped', say);
      }} /> : null}
  </>;
}

/** Crumb & Co › Secrets: the team's secrets, values, tokens, logins and sessions, each with its rule. */
export function SecretsPage() {
  const viewer = useViewer();
  const [adding, setAdding] = useState(false);
  const edit = whyAccount(viewer.id, 'account.credentials');
  return <>
    <Section title="Team secrets" scope="Team" readOnly={edit} description="Every secret the team keeps: values, secrets, API tokens, logins and cloud sessions. Each row’s rule says who may use it (Owners always count as Admins), whether only while holding the workspace, and how it’s delivered: only to approved scripts, in a cleared shell for some minutes after a passkey, or by the browser filling a login on named sites. A project’s own are in its settings; each person’s and bot’s own on their secrets page."
      actions={<Act reason={edit} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setAdding(true)}>Add</Act>}>
      <SecretsList scope="team" reason={edit} />
    </Section>
    {adding ? <AddTeamSecretFlow onClose={() => setAdding(false)} /> : null}
  </>;
}

/** The values a project asks each holder for (their own staging login, a Figma token), with the rule the project sets
 * for them and who has set theirs. A holder narrows it for their own value under You › My secrets. */
export function AskedValues({ project }: { project: string }) {
  const viewer = useViewer();
  const states = valueStates.use();
  useRoles();
  const [editing, setEditing] = useState<RuleTarget | null>(null);
  const asked = [...new Map(Object.values(PERSONAL_VALUES).flat().filter((value) => value.projectId === project).map((value) => [value.name, value])).values()];
  if (!asked.length) return <Note>This project asks holders for nothing of their own.</Note>;
  return <>
    <SettingRows label="Asked of each holder">{asked.map((value) => {
      const target: RuleTarget = { kind: 'ask', projectId: project, name: value.name };
      const holders = Object.entries(PERSONAL_VALUES).filter(([, values]) => values.some((entry) => entry.projectId === project && entry.name === value.name));
      const set = holders.filter(([userId, values]) => states[`${userId}:${project}:${value.name}`]?.set ?? values.find((entry) => entry.projectId === project && entry.name === value.name)?.set).map(([userId]) => userOf(userId).first);
      const missing = holders.map(([userId]) => userOf(userId).first).filter((first) => !set.includes(first));
      return <SettingRow key={value.name} media={glyph(Users01)}
        title={<span data-asked-value={value.name} className="inline-flex flex-wrap items-center gap-2"><span className="font-mono">{value.name}</span><Pill tone="teal">Each holder’s own</Pill></span>}
        description={`${value.detail.replace(/^Your /, 'Their ')} · set by ${set.length ? set.join(', ') : 'nobody yet'}${missing.length ? ` · missing for ${missing.join(', ')}` : ''}`}
        extra={<RuleSummary target={target} />}>
        <Act reason={whyRuleEdit(viewer.id, target)} variant="ghost" aria-label={`Edit rule for ${value.name}`} onClick={() => setEditing(target)}>Edit rule</Act>
      </SettingRow>;
    })}</SettingRows>
    {editing ? <EditRuleDialog target={editing} onClose={() => setEditing(null)} /> : null}
  </>;
}

/** A principal's own secrets. A person's (You › My secrets, top; People › person for Owners and Admins, drop only):
 * the old step-up credentials, each a cleared shell for some minutes after their passkey, only while holding, for
 * their own turns. A bot's (its secrets page): tokens and logins from its own accounts, for turns it starts, delivered
 * only to approved scripts, by browser autofill, or once its sponsor approves each use; never a shell. Its sponsor,
 * Owners and Admins manage them; anyone else reads them. */
export function OwnSecretsSection({ principal }: { principal: Principal }) {
  const viewer = useViewer();
  const [adding, setAdding] = useState(false);
  bots.use();
  useRoles();
  if (principal.kind === 'bot') {
    const manage = whyManageBot(viewer.id, principal);
    return <Section title={`${principal.name}’s secrets`} readOnly={manage}
      description={`${principal.name}’s own, from its own accounts: used only by turns it starts, in the projects it’s a member of. Values are write-only: nobody sees them again, not even whoever added them. Each one’s rule picks how it’s delivered: only to approved scripts its turns run, by browser autofill on named sites, or once ${sponsorOf(principal)} approves each use with a passkey in Needs you. Never a cleared shell: a bot has no passkey. Its sponsor, Owners and Admins manage them.`}
      actions={<Act reason={manage} variant="primary" leadingIcon={glyph(Plus)} onClick={() => setAdding(true)}>Add secret</Act>}>
      <SecretsList scope={principal.id} reason={manage} />
      {adding ? <AddBotSecretFlow bot={principal} onClose={() => setAdding(false)} /> : null}
    </Section>;
  }
  const own = principal.id === viewer.id;
  if (!own && viewer.accountRole !== 'owner' && viewer.accountRole !== 'admin') return <Note>Only {principal.first}, Owners and Admins see {principal.first}’s own secrets.</Note>;
  const info: ScopeInfo = own ? { scope: 'mine', access: 'own', target: principal, teamReason: null } : { scope: principal.id, access: 'revoke', target: principal, teamReason: null };
  return <Section title={own ? 'My own secrets' : `${principal.first}’s own secrets`} scope="You"
    description={`${own ? 'Yours' : `${principal.first}’s`} alone, from ${own ? 'your' : 'their'} own accounts: an npm publish token, an admin token, a cloud session. Each opens in a cleared shell for some minutes after ${own ? 'your' : 'their'} passkey, in a workspace ${own ? 'you hold' : 'they hold'}, for ${own ? 'your' : 'their'} own turns only; letting go closes it. An approved script ${own ? 'you' : 'they'} approved for ${own ? 'yourself' : 'themselves'} can use one too.`}
    actions={<Act reason={revokeOnly(info, viewer)} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setAdding(true)}>Add</Act>}>
    <SecretsList scope={principal.id} reason={own ? null : `Only ${principal.first} rotates their own secrets`} info={info} />
    {adding ? <AddOwnSecretFlow onClose={() => setAdding(false)} /> : null}
  </Section>;
}

const BOT_SECRET_STEPS = ['Secret', 'Value', 'Delivery', 'Passkey'];

/** Add a secret to a bot (its sponsor, an Owner or an Admin): what it is and unlocks, the value (write-only), its
 * delivery (only to approved scripts, browser autofill for a login, or the sponsor approves each use), then the
 * adder's passkey. */
function AddBotSecretFlow({ bot, onClose }: { bot: Bot; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const passkey = usePasskey();
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<'token' | 'login'>('token');
  const [name, setName] = useState('');
  const [unlocks, setUnlocks] = useState('');
  const [site, setSite] = useState('');
  const [value, setValue] = useState('');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [chosen, setChosen] = useState<SecretRule | null>(null);
  const [done, setDone] = useState(false);
  const typed = name.trim();
  const host = site.trim().replace(/^https:\/\//i, '').toLowerCase();
  const rule = useRuleStep(kind === 'login' && host ? { name: typed, scope: bot.id, kind, sensitive: true, site: host } : { name: typed, scope: bot.id, kind, sensitive: true }, viewer.id);
  const next = (): void => {
    const found: Record<string, string> = {};
    if (step === 0) {
      if (!typed) found.name = 'Name the variable it lands in, like NPM_PUBLISH_TOKEN';
      else if (!/^[A-Z][A-Z0-9_]*$/.test(typed)) found.name = 'UPPER_SNAKE_CASE: capital letters, digits and underscores';
      else if (secrets.get().some((entry) => entry.scope === bot.id && entry.name === typed)) found.name = `${bot.name} already has ${typed}: rotate it from its row, or pick another name`;
      if (!unlocks.trim()) found.unlocks = `Say what it unlocks: ${sponsorOf(bot)} reads this when approving a use`;
      if (kind === 'login' && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) found.site = 'The site it signs in to, like dashboard.stripe.com';
    }
    if (step === 1) {
      if (!value) found.value = kind === 'login' ? 'Paste the password' : 'Paste the secret value';
      else if (/\s/.test(value)) found.value = 'It has spaces or line breaks: paste the value alone';
      else if (typed.startsWith('NPM_') && !value.startsWith('npm_')) found.value = 'npm tokens start with npm_. Paste a granular access token from npmjs.com › Access Tokens';
    }
    setErrors(found);
    if (Object.keys(found).length) return;
    if (step === 2) { const valid = rule.validate(); if (!valid) return; setChosen(valid); }
    if (step < 3) { setStep(step + 1); return; }
    passkey.confirm(() => {
      const picked = chosen ?? rule.validate();
      if (!picked) return;
      secrets.set([...secrets.get(), { id: `s-${bot.id}-${Date.now().toString(36)}`, name: typed, scope: bot.id, kind, detail: unlocks.trim(), ...(kind === 'login' ? { site: host } : {}), sensitive: true, expires: null, updated: `just now by ${viewer.first}`, lastUsed: 'never' }]);
      secretRules.set({ ...secretRules.get(), [`${bot.id}:${typed}`]: picked });
      recordAudit({ actor: viewer.id, kind: 'bot', text: `Added ${SECRET_KIND_LABEL[kind].toLowerCase()} ${typed} to ${actorLabel(bot.id)}: ${ruleLine(picked, { ownerId: bot.id })} · confirmed with ${passkeyLabel(viewer.id)}` });
      say(`Added ${typed} to ${bot.name}`);
      setDone(true);
    });
  };
  return <FlowDialog id="bot-secret-add" title={done ? `${typed} is ${bot.name}’s` : `Add a secret to ${bot.name}`} description={done ? undefined : `${bot.name}’s own: write-only once added, used only by turns it starts.`} steps={BOT_SECRET_STEPS} step={step} done={done} onClose={() => { if (!passkey.waiting) onClose(); }}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setErrors({}); setStep(step - 1); }} onCancel={onClose} next={next} busy={passkey.waiting} nextLabel={step === 3 ? 'Add with passkey' : 'Next'} />}>
    {done && chosen ? <FlowSuccess title={ruleLine(chosen, { ownerId: bot.id })}>{chosen.delivery.kind === 'sponsor' ? `Each time a turn ${bot.name} starts asks for ${typed}, ${sponsorOf(bot)} gets a request in Needs you and approves it with their passkey, for that turn only.` : chosen.delivery.kind === 'autofill' ? `The browser fills it on ${chosen.delivery.origins.join(', ')} in workspaces ${bot.name} holds; its agent never sees it.` : `Approved scripts its turns run get it; nothing else in the workspace does.`} In the audit log.</FlowSuccess>
      : step === 0 ? <>
        <ChoiceCards label="Kind" columns={2} value={kind} onChange={(id) => { if (id === 'token' || id === 'login') { setKind(id); setErrors({}); rule.reset(); } }} choices={[
          { id: 'token', title: 'API token or secret', detail: 'A token, key or webhook URL it sends with requests', icon: Terminal },
          { id: 'login', title: 'Site login', detail: 'A username and password the browser can fill on its site', icon: Passcode },
        ]} />
        <InputGroup className="w-full">
          <InputField index={0} label="Variable" placeholder="NPM_PUBLISH_TOKEN" value={name} onChange={(text) => { setName(text); setErrors({}); }} error={errors.name} />
          <InputField index={1} label="What it unlocks" placeholder="npm publish for @crumbco/* packages" value={unlocks} onChange={(text) => { setUnlocks(text); setErrors({}); }} error={errors.unlocks} />
          {kind === 'login' ? <InputField index={2} label="Site" placeholder="dashboard.stripe.com" value={site} onChange={(text) => { setSite(text); setErrors({}); }} error={errors.site} /> : null}
        </InputGroup>
        <Hint>Approved scripts get it as ${typed || 'NAME'}; it never lands in the repository or the transcript.</Hint>
      </> : step === 1 ? <>
        <InputGroup className="w-full"><InputField index={0} type="password" label={kind === 'login' ? 'Password' : 'Secret value'} placeholder={typed.startsWith('NPM_') ? 'npm_…' : '••••••••'} value={value} onChange={(text) => { setValue(text); setErrors({}); }} error={errors.value} /></InputGroup>
        <Hint>Encrypted at rest; nobody sees it again, not even you. Rotate it from its row.</Hint>
      </> : step === 2 ? rule.body
      : <>
        <Summary rows={[['Variable', <span key="name" className="font-mono">{typed}</span>], ['Unlocks', unlocks.trim()], ['Value', '•••••••• (write-only)'], ['Rule', chosen ? ruleLine(chosen, { ownerId: bot.id }) : '']]} />
        <PasskeyStep userId={viewer.id} what={`adding ${typed} to ${bot.name}`} waiting={passkey.waiting} />
      </>}
  </FlowDialog>;
}
