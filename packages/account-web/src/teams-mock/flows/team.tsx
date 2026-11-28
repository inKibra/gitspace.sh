// The team Settings pages' dialogs and wizards, drawn with the flow kit: inviting people (addresses checked against
// the allowed email domains, account role, project roles, passkey), allowed domains, a pending invite's Resend, Revoke
// and link, account-role changes (promotion with a passkey; demotion handing an Admin's bots to another Admin or Owner
// or blocking them), removing a person (handles, bots, personal resources, passkey), project roles (new, delete),
// secrets (add with its rule, rotate, replace, edit a value), custom domains (add with DNS checks, verify,
// remove), releases (channel, roll back, return to latest), the GitHub App (create from a manifest, install on an
// organization, change repositories, uninstall) and the audit log's export. Each ends in a success state, updates the
// mock's stores and records what an Owner or Admin did in the audit log.
import { glyph } from '../../glyph.js';
import { Button, InputCopy, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger, Switch, ThinkingIndicator } from '@gitspace/ui';
import { Building02, Check, ClockRewind, Download01, Fingerprint01, GitBranch01, Globe04, Link01, Mail01, SearchMd, ShieldTick, UserCircle, XClose } from '@untitledui/icons';
import { useState, type ReactNode } from 'react';
import { actorLabel, bots, findPrincipal, memberships, projectRoleIdOf, TEAM, USERS, userOf, visibleProjects, WORKSPACES, type Bot, type User } from '../data.js';
import { useMock, useViewer } from '../viewer.js';
import {
  accountRoleChanges, ACCOUNT_NAME, ACTIVE_PROJECTS, AGENT_PERMISSIONS, BROWSERS, DEVICES, GITHUB_ACCOUNTS, MACHINES, MCP_GRANTS, MODEL_CREDENTIALS, PLUGINS, projectName, projectSettings, recordAudit,
  removedUsers, revoked, SECRET_KIND_LABEL, type AuditEntry, type Invite, type SecretEntry,
} from '../settings/data.js';
import { useHeld } from '../settings/parts.js';
import { passkeyLabel, usePasskey } from '../settings/passkey.js';
import {
  ACCOUNT_PERMISSIONS, ACCOUNT_ROLES, accountRoleById, addCustomRole, deleteRole, roleName, useRoles, whyAccount, type AccountRole, type AccountRoleId, type ProjectRole,
} from '../settings/roles.js';
import { secretRules } from './env-model.js';
import { ChoiceCards, ChipPicker, DnsRecord, FlowDialog, FlowError, FlowSuccess, Hint, PasskeyStep, StepButtons, Summary, TextArea } from './kit.js';
import { botOwner, ruleLine, ruleOf, scopeKind, useRuleStep } from './secret-rules.js';
import {
  allowedDomains, APP_EVENTS, APP_PERMISSIONS, AUDIT_TODAY, customDomains, DOMAIN_NAME, ENV_NAME, GITHUB_ORGS, githubApp, invites, PUBLIC_EMAIL_DOMAINS, release, RELEASES, secrets, SHORT_SCOPED_TOKENS,
  TOKEN_SERVICES, type CustomDomain, type GitHubOrg,
} from './team-data.js';

/** One labelled text field, as account-web's dialogs draw them. */
export function Field({ label, value, onChange, error, placeholder, type, hint, onEnter }: {
  label: string; value: string; onChange(value: string): void; error?: string | null; placeholder?: string; type?: string; hint?: ReactNode; onEnter?(): void;
}) {
  return <div className="flex flex-col gap-1.5">
    <InputGroup className="w-full"><InputField index={0} label={label} value={value} onChange={onChange} error={error ?? undefined} placeholder={placeholder} type={type}
      onKeyDown={onEnter ? (event) => { if (event.key === 'Enter') { event.preventDefault(); onEnter(); } } : undefined} /></InputGroup>
    {hint ? <Hint>{hint}</Hint> : null}
  </div>;
}

/** A titled list of facts: what a change does, what someone holds. */
export function Facts({ title, items }: { title: string; items: readonly ReactNode[] }) {
  return <div className="flex flex-col gap-1">
    <span className="text-body font-medium text-foreground">{title}</span>
    <ul className="flex flex-col gap-0.5 pl-4 text-caption text-muted-foreground [text-wrap:pretty] [&>li]:list-disc">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
  </div>;
}

const done = (onClose: () => void) => <Button variant="primary" onClick={onClose}>Done</Button>;
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

// ── Invites ──

const EMAIL = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/;

/** Why an address can't be invited, or null: not an address, already a user, already invited, or outside the allowed
 * email domains (with who adds a domain and where). */
function addressProblem(email: string, domains: readonly string[]): string | null {
  const match = EMAIL.exec(email);
  if (!match) return `“${email}” isn’t an email address: check it for a typo.`;
  const domain = (match[1] ?? '').toLowerCase();
  const member = USERS.find((user) => user.email.toLowerCase() === email.toLowerCase() && !removedUsers.get().has(user.id));
  if (member) return `${member.name} is already in ${ACCOUNT_NAME}: change their projects under People instead.`;
  const pending = invites.get().find((invite) => invite.how === 'email' && invite.to.toLowerCase() === email.toLowerCase());
  if (pending) return `${email} already has a pending invite from ${userOf(pending.by).first} (expires ${pending.expires}): Resend it from Pending invites instead.`;
  if (!domains.includes(domain)) return `@${domain} isn’t an allowed domain for ${ACCOUNT_NAME} (allowed: ${domains.map((entry) => `@${entry}`).join(', ')}). An Owner or Admin adds it under People & roles → Invites → Allowed email domains; then invite this address again.`;
  return null;
}

const INVITE_STEPS = ['Who', 'Account role', 'Projects', 'Review'] as const;

/** Invite people: addresses (several, as chips, each checked) or a link → account role → a project role in each project
 * the viewer manages → review and passkey → the invites, pending for 7 days. */
export function InviteFlow({ projects, onClose }: { projects: readonly string[]; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const domains = allowedDomains.use();
  invites.use();
  const roles = useRoles();
  const passkey = usePasskey();
  const ownerReason = whyAccount(viewer.id, 'account.owners');
  const hidden = ACTIVE_PROJECTS.filter((project) => !visibleProjects(viewer.id).has(project.id));
  const [step, setStep] = useState(0);
  const [sent, setSent] = useState<readonly Invite[] | null>(null);
  const [how, setHow] = useState('email');
  const [addresses, setAddresses] = useState<readonly string[]>(() => (new URLSearchParams(window.location.search).get('invite') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean));
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [uses, setUses] = useState('1');
  const [accountRole, setAccountRole] = useState<AccountRoleId>('member');
  const [picked, setPicked] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(projects.includes('crumb') ? [['crumb', 'contributor']] : []));
  const [error, setError] = useState<string | null>(null);
  const problems = addresses.map((email) => ({ email, problem: addressProblem(email, domains) })).filter((entry) => entry.problem !== null);
  const add = (): void => {
    const parts = [...new Set(draft.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean))];
    if (!parts.length) { setDraftError('Type an address, then press Enter or Add'); return; }
    const twice = parts.find((entry) => addresses.some((address) => address.toLowerCase() === entry.toLowerCase()));
    if (twice) { setDraftError(`${twice} is already in the list`); return; }
    setAddresses([...addresses, ...parts]); setDraft(''); setDraftError(null); setError(null);
  };
  const projectLine = accountRole === 'owner' ? 'Lead in every project (Owner)' : Object.entries(picked).map(([projectId, roleId]) => `${roleName(roleId)} in ${projectName(projectId)}`).join(' · ');
  const send = (): void => passkey.confirm(() => {
    const base = { how: how === 'link' ? 'link' as const : 'email' as const, accountRole, projects: accountRole === 'owner' ? [] : Object.entries(picked).map(([projectId, roleId]) => ({ projectId, roleId })), by: viewer.id, expires: 'in 7 days' };
    const made: readonly Invite[] = how === 'link'
      ? [{ ...base, id: `inv-${Date.now()}`, to: `Anyone at ${domains.join(' or ')} with the link`, uses: `0 of ${uses} used` }]
      : addresses.map((to, index) => ({ ...base, id: `inv-${Date.now()}-${index}`, to }));
    invites.set([...made, ...invites.get()]);
    recordAudit({ actor: viewer.id, kind: 'team', text: `Invited ${how === 'link' ? `anyone at ${domains.join(' or ')} with a link (${plural(Number(uses), 'use')})` : addresses.join(', ')} with account role ${accountRoleById(accountRole)?.name} · ${projectLine} · confirmed with ${passkeyLabel(viewer.id)}` });
    say(how === 'link' ? 'Invite link created · confirmed with your passkey' : `${plural(made.length, 'invite')} sent · confirmed with your passkey`);
    setSent(made);
  });
  const next = (): void => {
    setError(null);
    if (step === 0 && how === 'email' && !addresses.length) { setError(draft.trim() ? 'Press Add (or Enter) to put the address in the list.' : 'Add at least one address.'); return; }
    if (step === 0 && how === 'email' && problems.length) { setError(`Remove or fix the ${plural(problems.length, 'address', 'addresses')} marked in red before going on.`); return; }
    if (step === 2 && accountRole !== 'owner' && !Object.keys(picked).length) { setError('Pick a project role in at least one project: a Member in no project sees nothing in GitSpace.'); return; }
    if (step === 3) { send(); return; }
    setStep(step + 1);
  };
  const link = `https://crumbco.gitspace.sh/join/7Fq2-kX9p-${accountRole}`;
  return <FlowDialog id="invite" title={sent ? (how === 'link' ? 'Invite link ready' : `${plural(sent.length, 'invite')} sent`) : `Invite to ${ACCOUNT_NAME}`}
    description={`They join as new users of this team, with their own passkeys and devices. Only addresses at ${domains.map((entry) => `@${entry}`).join(', ')} can be invited.`}
    steps={INVITE_STEPS} step={step} done={sent !== null} onClose={onClose}
    footer={sent ? done(onClose) : <StepButtons step={step} onBack={() => { setError(null); setStep(step - 1); }} onCancel={onClose} next={next} busy={passkey.waiting}
      nextLabel={step === 3 ? (how === 'link' ? 'Create link with passkey' : `Send ${plural(addresses.length, 'invite')} with passkey`) : 'Next'} />}>
    {sent ? <>
      <FlowSuccess title={how === 'link' ? 'The link is ready' : `Invited ${sent.map((invite) => invite.to).join(', ')}`}>
        {how === 'link' ? `Works ${plural(Number(uses), 'time')} for 7 days, for an address at ${domains.join(' or ')}. Whoever opens it creates a passkey and joins as ${accountRoleById(accountRole)?.name}.` : 'Each gets an email with a link that works once, for 7 days. Accepting creates their user with their own passkey. Pending invites can be resent or revoked.'}
      </FlowSuccess>
      {how === 'link' ? <InputCopy label="Invite link" value={link} /> : <Summary rows={sent.map((invite) => [invite.to, `Pending · ${accountRoleById(invite.accountRole)?.name ?? invite.accountRole} · expires in 7 days`] as const)} />}
    </> : null}
    {!sent && step === 0 ? <>
      <ChoiceCards label="Invite by" columns={2} value={how} onChange={(value) => { setHow(value); setError(null); }} choices={[
        { id: 'email', title: 'By email', detail: 'One invite per address; each works once.', icon: Mail01 },
        { id: 'link', title: 'Invite link', detail: `For anyone at ${domains.join(' or ')}; you choose how many may use it.`, icon: Link01 },
      ]} />
      {how === 'email' ? <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1"><Field label="Email addresses" placeholder={`name@${domains[0] ?? 'example.com'}, another@${domains[0] ?? 'example.com'}`} value={draft} onChange={(value) => { setDraft(value); setDraftError(null); }} error={draftError} onEnter={add}
            hint="Separate several with commas or spaces; Enter adds them." /></div>
          <Button variant="secondary" className="mt-1" onClick={add}>Add</Button>
        </div>
        {addresses.length ? <div role="list" aria-label="Addresses" className="flex flex-wrap gap-1.5">{addresses.map((email) => {
          const problem = problems.find((entry) => entry.email === email);
          return <span key={email} role="listitem" data-address={email} data-invalid={problem ? '' : undefined}
            className={`inline-flex h-7 items-center gap-1 rounded-full pl-2.5 pr-1 text-caption ${problem ? 'bg-[color-mix(in_oklab,var(--destructive)_10%,transparent)] text-destructive shadow-[inset_0_0_0_1px_var(--destructive)]' : 'bg-surface-2 text-foreground shadow-[inset_0_0_0_1px_var(--border)]'}`}>
            {email}<button type="button" aria-label={`Remove ${email}`} className="flex size-5 items-center justify-center rounded-full hover:bg-hover" onClick={() => setAddresses(addresses.filter((entry) => entry !== email))}><XClose width={12} height={12} /></button>
          </span>;
        })}</div> : null}
        {problems.map((entry) => <p key={entry.email} role="alert" data-domain-refusal="" className="text-caption text-destructive [text-wrap:pretty]">{entry.problem}</p>)}
      </div> : <div className="flex items-center justify-between gap-3"><span className="text-body">How many people may use it</span>
        <Select value={uses} onValueChange={setUses}><SelectTrigger aria-label="Uses" /><SelectContent>{['1', '5', '10', '25'].map((count, index) => <SelectItem key={count} value={count} index={index}>{plural(Number(count), 'person', 'people')}</SelectItem>)}</SelectContent></Select>
      </div>}
    </> : null}
    {!sent && step === 1 ? <ChoiceCards label="Account role" value={accountRole} onChange={(value) => { const role = accountRoleById(value); if (role) setAccountRole(role.id); }}
      choices={ACCOUNT_ROLES.map((role) => ({ id: role.id, title: role.name, detail: role.description, badge: role.id === 'member' ? <span className="text-caption font-normal text-muted-foreground">Default</span> : undefined, disabled: role.id === 'owner' && ownerReason ? `${ownerReason}: only Owners invite Owners.` : null }))} /> : null}
    {!sent && step === 2 ? (accountRole === 'owner' ? <Hint>Owners are Lead in every project, including ones made later.</Hint> : <div className="flex flex-col gap-2">
      <Hint>They’ll see only the projects you give them a role in{viewer.accountRole === 'owner' ? '' : ' (only projects you manage are listed)'}.</Hint>
      {projects.map((projectId) => {
        const roleId = picked[projectId];
        return <div key={projectId} data-project-pick={projectId} className="flex flex-col gap-1 rounded-xl px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]">
          <div className="flex items-center justify-between gap-3"><span className="text-body font-medium text-foreground">{projectName(projectId)}</span>
            <Select value={roleId ?? 'none'} onValueChange={(value) => { const map = { ...picked }; if (value === 'none') delete map[projectId]; else map[projectId] = value; setPicked(map); setError(null); }}>
              <SelectTrigger aria-label={`Project role in ${projectName(projectId)}`} />
              <SelectContent><SelectItem value="none" index={0}>Not a member</SelectItem>{roles.map((role, index) => <SelectItem key={role.id} value={role.id} index={index + 1}>{role.name}</SelectItem>)}</SelectContent>
            </Select></div>
          <span className="text-caption text-muted-foreground">{roleId ? roles.find((role) => role.id === roleId)?.description : 'They won’t see this project.'}</span>
        </div>;
      })}
      {hidden.length ? <Hint>You’re not in {hidden.map((project) => project.name).join(', ')}; its Leads add people there.</Hint> : null}
    </div>) : null}
    {!sent && step === 3 ? <>
      <Summary rows={[
        ['To', how === 'link' ? `Anyone at ${domains.join(' or ')} · ${plural(Number(uses), 'use')}` : addresses.join(', ')],
        ['Account role', accountRoleById(accountRole)?.name ?? accountRole],
        ['Projects', projectLine],
        ['Expires', 'In 7 days; pending until then'],
        ['Confirmed with', passkeyLabel(viewer.id)],
      ]} />
      <PasskeyStep userId={viewer.id} what={how === 'link' ? 'the invite link' : `the ${plural(addresses.length, 'invite')}`} waiting={passkey.waiting} />
    </> : null}
    {error ? <FlowError>{error}</FlowError> : null}
  </FlowDialog>;
}

const DOMAIN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** Allow invites to another email domain. */
export function AllowDomainDialog({ onClose }: { onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const domains = allowedDomains.use();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const submit = (): void => {
    const domain = draft.trim().toLowerCase().replace(/^@/, '');
    if (!domain) setError('Enter a domain, like studio.crumbco.example.');
    else if (!DOMAIN.test(domain)) setError(`“${draft}” isn’t a domain: use the part after the @, like studio.crumbco.example.`);
    else if (domains.includes(domain)) setError(`@${domain} is already allowed.`);
    else if (PUBLIC_EMAIL_DOMAINS.includes(domain)) setError(`@${domain} is a public email provider: allowing it would let anyone with a free address be invited. Invite people at their work address, or add your own domain.`);
    else {
      allowedDomains.set([...domains, domain]);
      recordAudit({ actor: viewer.id, kind: 'team', text: `Allowed invites to @${domain}` });
      say(`Invites may now go to addresses at ${domain}`);
      setAdded(domain);
    }
  };
  return <FlowDialog id="allow-domain" wide={false} title={added ? `@${added} allowed` : 'Allow an email domain'} done={added !== null} onClose={onClose}
    description="Invites and invite links accept only addresses at the allowed domains. People already in keep their users whatever the list says."
    footer={added ? done(onClose) : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Allow domain</Button></>}>
    {added ? <FlowSuccess title={`Invites may now go to @${added}`}>Recorded in the audit log. Remove it here whenever invites there should stop.</FlowSuccess>
      : <Field label="Domain" placeholder="studio.crumbco.example" value={draft} onChange={(value) => { setDraft(value); setError(null); }} error={error} onEnter={submit} hint="Your company’s own domain. Public email providers can’t be allowed." />}
  </FlowDialog>;
}

/** Stop allowing an email domain: its pending invites are revoked; people already in keep their users. */
export function RemoveDomainAllowanceDialog({ domain, onClose }: { domain: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const domains = allowedDomains.use();
  const pending = invites.use().filter((invite) => invite.how === 'email' && invite.to.toLowerCase().endsWith(`@${domain}`));
  const [removed, setRemoved] = useState(false);
  const last = domains.length === 1 && !removed;
  const remove = (): void => {
    allowedDomains.set(domains.filter((entry) => entry !== domain));
    invites.set(invites.get().filter((invite) => !pending.includes(invite)));
    recordAudit({ actor: viewer.id, kind: 'team', text: `Stopped allowing invites to @${domain}${pending.length ? `; revoked ${pending.map((invite) => invite.to).join(', ')}` : ''}` });
    say(`Invites to ${domain} stopped`);
    setRemoved(true);
  };
  return <FlowDialog id="remove-allowed-domain" wide={false} title={removed ? `@${domain} removed` : `Stop allowing @${domain}?`} done={removed} onClose={onClose}
    footer={removed ? done(onClose) : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={last} onClick={remove}>Stop allowing @{domain}</Button></>}>
    {removed ? <FlowSuccess title={`Invites to @${domain} stopped`}>{pending.length ? `${plural(pending.length, 'pending invite')} revoked. ` : ''}People already in keep their users.</FlowSuccess> : <>
      <Facts title="What happens" items={[
        pending.length ? `${plural(pending.length, 'pending invite')} to it ${pending.length === 1 ? 'is' : 'are'} revoked: ${pending.map((invite) => invite.to).join(', ')}.` : 'No pending invite goes to it.',
        'Invite links stop accepting its addresses.',
        'People already in with an address there keep their users and passkeys.',
      ]} />
      {last ? <FlowError>Keep at least one domain: with none, nobody could be invited. Allow the new domain first, then remove this one.</FlowError> : null}
    </>}
  </FlowDialog>;
}

/** A pending invite's Resend, Revoke, or its link. */
export function InviteActionDialog({ invite, action, onClose }: { invite: Invite; action: 'resend' | 'revoke' | 'link'; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [finished, setFinished] = useState(false);
  const what = `${invite.to} · ${roleName(invite.accountRole)} · ${invite.projects.map((entry) => `${roleName(entry.roleId)} in ${projectName(entry.projectId)}`).join(', ') || 'every project'}`;
  if (action === 'link') return <FlowDialog id="invite-link" wide={false} title="Invite link" description={`For anyone at the allowed domains · ${invite.uses ?? ''} · expires ${invite.expires}.`} onClose={onClose} footer={done(onClose)}>
    <InputCopy label="Invite link" value={`https://crumbco.gitspace.sh/join/${invite.id}-${invite.accountRole}`} />
    <Summary rows={[['Joins as', roleName(invite.accountRole)], ['Projects', invite.projects.map((entry) => `${roleName(entry.roleId)} in ${projectName(entry.projectId)}`).join(' · ')], ['Made by', userOf(invite.by).name]]} />
    <Hint>Whoever opens it signs in with an address at an allowed domain and creates a passkey. Revoke it to stop it at once.</Hint>
  </FlowDialog>;
  const confirm = (): void => {
    if (action === 'resend') {
      invites.set(invites.get().map((entry) => entry.id === invite.id ? { ...entry, expires: 'in 7 days' } : entry));
      recordAudit({ actor: viewer.id, kind: 'team', text: `Resent the invite to ${invite.to}` });
      say(`Sent again to ${invite.to}`);
    } else {
      invites.set(invites.get().filter((entry) => entry.id !== invite.id));
      recordAudit({ actor: viewer.id, kind: 'team', text: `Revoked the invite to ${invite.to}` });
      say('Invite revoked');
    }
    setFinished(true);
  };
  return <FlowDialog id={`invite-${action}`} wide={false} done={finished} onClose={onClose}
    title={finished ? (action === 'resend' ? 'Invite sent again' : 'Invite revoked') : action === 'resend' ? `Send the invite to ${invite.to} again?` : 'Revoke this invite?'}
    footer={finished ? done(onClose) : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={confirm}>{action === 'resend' ? 'Send again' : 'Revoke invite'}</Button></>}>
    {finished ? <FlowSuccess title={action === 'resend' ? `Sent to ${invite.to}` : `${invite.to} can’t join with it`}>{action === 'resend' ? 'The new link expires in 7 days; the one in the first email no longer works.' : 'Its link stopped working. Invite them again whenever you like.'}</FlowSuccess>
      : <><Summary rows={[['Invite', what], ['Sent by', userOf(invite.by).name], ['Expires', invite.expires]]} />
        <Hint>{action === 'resend' ? 'A new email with a new link; the link in the first email stops working and the 7 days start again.' : 'The link stops working at once. Nothing else changes.'}</Hint></>}
  </FlowDialog>;
}

// ── Account roles ──

const RANK: Readonly<Record<AccountRoleId, number>> = { member: 0, admin: 1, owner: 2 };

/** Blocks the sign-ins of the bots `user` still sponsors (kept, not deleted) until an Admin takes them over; they
 * expire after 30 days. Returns their names. */
export function blockSponsored(user: User, lapse: string): readonly string[] {
  const blocked = bots.get().filter((bot) => bot.sponsor === user.id);
  bots.set(bots.get().map((bot) => bot.sponsor === user.id ? { ...bot, sponsor: null, formerSponsor: user.name, lapse, expires: 'in 30 days' } : bot));
  return blocked.map((bot) => bot.name);
}

/** Changing someone's account role. A promotion says what they gain and needs the viewer's passkey; a demotion says
 * what they lose, and an Admin who sponsors bots and becomes Member hands them to another Admin or Owner (they keep
 * working) or, skipped, has them blocked: a bot's sponsor must be an Admin or Owner; blocked sign-ins expire after 30
 * days. */
export function RoleChangeDialog({ user, from, to, onClose }: { user: User; from: AccountRoleId; to: AccountRole; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const roles = accountRoleChanges.use();
  const passkey = usePasskey();
  const [sponsored] = useState<readonly Bot[]>(() => bots.get().filter((bot) => bot.sponsor === user.id));
  const [line, setLine] = useState<string | null>(null);
  const before = accountRoleById(from) ?? ACCOUNT_ROLES[2]!;
  const promotion = RANK[to.id] > RANK[from];
  const losing = to.id === 'member' && sponsored.length > 0;
  const candidates = USERS.filter((entry) => entry.id !== user.id && !removedUsers.get().has(entry.id) && (roles[entry.id] ?? entry.accountRole) !== 'member');
  const [heir, setHeir] = useState(candidates.some((entry) => entry.id === viewer.id) ? viewer.id : candidates[0]?.id ?? '');
  const gained = ACCOUNT_PERMISSIONS.rows.filter((row) => to.allowed.has(row.action) && !before.allowed.has(row.action)).map((row) => row.label);
  const lost = ACCOUNT_PERMISSIONS.rows.filter((row) => before.allowed.has(row.action) && !to.allowed.has(row.action)).map((row) => row.label);
  const names = sponsored.map((bot) => bot.name).join(', ');
  const one = sponsored.length === 1;
  const apply = (handTo: string | null): void => {
    accountRoleChanges.set({ ...accountRoleChanges.get(), [user.id]: to.id });
    if (losing && handTo) bots.set(bots.get().map((bot) => bot.sponsor === user.id ? { ...bot, sponsor: handTo } : bot));
    const blocked = losing && !handTo ? blockSponsored(user, 'lost Admin') : [];
    const handed = losing && handTo ? `${names} now sponsored by ${userOf(handTo).name}` : '';
    const text = `Changed ${user.name}’s account role to ${to.name} (was ${before.name})${handed ? `; ${handed}` : ''}${blocked.length ? `; ${blocked.join(', ')} blocked until an Admin takes ${blocked.length === 1 ? 'it' : 'them'} over (sign-ins expire in 30 days)` : ''}${promotion ? ` · confirmed with ${passkeyLabel(viewer.id)}` : ''}`;
    recordAudit({ actor: viewer.id, kind: 'team', text });
    say(`${user.first} is now ${to.name}${handed ? ` · ${handed}` : ''}${blocked.length ? ` · ${blocked.join(', ')} can’t sign in until an Admin takes ${blocked.length === 1 ? 'it' : 'them'} over` : ''}`);
    setLine(text);
  };
  return <FlowDialog id={promotion ? 'promote' : 'demote'} wide={false} done={line !== null} onClose={onClose}
    title={line ? `${user.first} is now ${to.name}` : `Change ${user.first} to ${to.name}`}
    description={line ? undefined : promotion ? `${user.name} is ${before.name} now. ${to.name} is an account role: it decides account pages; inside a project, their project role still decides.` : `${user.name} is ${before.name} now.`}
    footer={line ? done(onClose) : promotion
      ? <><Button variant="secondary" onClick={onClose} disabled={passkey.waiting}>Cancel</Button><Button variant="primary" leadingIcon={glyph(Fingerprint01)} loading={passkey.waiting} disabled={passkey.waiting} onClick={() => passkey.confirm(() => apply(null))}>Make {user.first} {to.name} with passkey</Button></>
      : losing
        ? <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="ghost" onClick={() => apply(null)}>Skip and block {one ? 'it' : 'them'}</Button><Button variant="primary" disabled={!heir} onClick={() => apply(heir)}>Change role and hand over</Button></>
        : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => apply(null)}>Change to {to.name}</Button></>}>
    {line ? <FlowSuccess title="Saved and recorded">{line}</FlowSuccess> : <>
      {promotion ? <>
        <Facts title={`What ${user.first} gains`} items={[...gained, ...(to.id === 'owner' ? ['Lead in every project, including ones made later', 'May sponsor bots'] : []), ...(to.id === 'admin' ? ['May sponsor bots', 'Sees only projects they’re a member of; joins others with Join project, which is recorded'] : [])]} />
        <PasskeyStep userId={viewer.id} what={`making ${user.first} ${to.name}`} waiting={passkey.waiting} />
      </> : <>
        <Facts title={`What ${user.first} loses`} items={[...lost, ...(from === 'owner' ? [`Lead in every project: they keep only their own memberships${memberships.get().some((entry) => entry.userId === user.id) ? '' : ' (none, so they’d see no project until added)'}`] : [])]} />
        {losing ? <div className="flex flex-col gap-2" data-demote-dialog="">
          <Hint>{user.first} sponsors {names}. A bot’s sponsor must be an Admin or Owner: hand {one ? 'it' : 'them'} to one now and {one ? 'it keeps' : 'they keep'} working. Skip, and {one ? 'its' : 'their'} sign-ins are blocked until an Admin takes {one ? 'it' : 'them'} over; blocked sign-ins expire after 30 days.</Hint>
          <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-body">New sponsor for {names}</span>
            <Select value={heir} onValueChange={setHeir}><SelectTrigger aria-label="New sponsor" /><SelectContent>
              {candidates.map((entry, index) => <SelectItem key={entry.id} value={entry.id} index={index}>{`${entry.name}${entry.id === viewer.id ? ' (you)' : ''} · ${accountRoleById(roles[entry.id] ?? entry.accountRole)?.name ?? ''}`}</SelectItem>)}
            </SelectContent></Select>
          </div>
          {candidates.length ? null : <FlowError>There’s no other Admin or Owner to take {one ? 'it' : 'them'}: make someone Admin first, or skip and block {one ? 'it' : 'them'}.</FlowError>}
        </div> : null}
      </>}
    </>}
  </FlowDialog>;
}

// ── Removing a person ──

const REMOVE_STEPS = ['Handles', 'Bots', 'Personal resources', 'Confirm'] as const;

/** Remove a person from the team: hand each workspace handle they hold to someone in its project (or leave it free),
 * hand each bot they sponsor to an Admin or Owner (or block it), see the personal resources that are revoked, then
 * confirm with a passkey. Their row leaves the People list when the success state is closed (the dialog lives in it). */
export function RemovePersonFlow({ user, onClose }: { user: User; onClose(): void }) {
  const viewer = useViewer();
  const { say, state, assign } = useMock();
  const passkey = usePasskey();
  const roles = accountRoleChanges.use();
  const heldBy = useHeld();
  const [held] = useState(() => heldBy(user.id));
  const [sponsored] = useState<readonly Bot[]>(() => bots.get().filter((bot) => bot.sponsor === user.id));
  const gone = removedUsers.get();
  const othersOn = (workspaceId: string): readonly string[] => (state.holders[workspaceId] ?? WORKSPACES.find((entry) => entry.id === workspaceId)?.holders ?? []).filter((id) => id !== user.id);
  const heirs = USERS.filter((entry) => entry.id !== user.id && !gone.has(entry.id) && (roles[entry.id] ?? entry.accountRole) !== 'member');
  const [step, setStep] = useState(0);
  const [handles, setHandles] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(held.map((id) => [id, othersOn(id).length ? 'keep' : 'free'])));
  const [botPlan, setBotPlan] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(sponsored.map((bot) => [bot.id, heirs.some((entry) => entry.id === viewer.id) ? viewer.id : heirs[0]?.id ?? 'block'])));
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const mine = (owner: { scope: string; userId?: string }): boolean => owner.scope === 'user' && owner.userId === user.id;
  const devices = DEVICES[user.id] ?? [];
  const resources: ReadonlyArray<{ title: string; items: ReadonlyArray<{ id: string; label: string }> }> = [
    { title: 'Model providers', items: MODEL_CREDENTIALS.filter((entry) => mine(entry.owner)).map((entry) => ({ id: entry.id, label: entry.label })) },
    { title: 'Machines', items: MACHINES.filter((entry) => mine(entry.owner)).map((entry) => ({ id: entry.id, label: entry.label })) },
    { title: 'Browsers', items: BROWSERS.filter((entry) => mine(entry.owner) && !entry.builtIn).map((entry) => ({ id: entry.id, label: entry.label })) },
    { title: 'Plugins', items: PLUGINS.filter((entry) => mine(entry.owner)).map((entry) => ({ id: entry.id, label: `${entry.name} (${entry.auth})` })) },
    { title: 'MCP clients', items: MCP_GRANTS.filter((entry) => entry.userId === user.id).map((entry) => ({ id: entry.id, label: `${entry.client} · ${entry.host}` })) },
    { title: 'Passkeys and devices', items: devices.map((entry) => ({ id: entry.id, label: `${entry.label} · ${entry.kind}` })) },
  ];
  const told = AGENT_PERMISSIONS.filter((entry) => entry.grantedBy === user.id);
  const workspaceName = (id: string): string => WORKSPACES.find((entry) => entry.id === id)?.name ?? id;
  const projectOf = (id: string): string => WORKSPACES.find((entry) => entry.id === id)?.projectId ?? '';
  const handleLine = (id: string): string => { const plan = handles[id] ?? 'free'; return plan === 'keep' ? `stays with ${othersOn(id).map((other) => userOf(other).first).join(' and ')}` : plan === 'free' ? 'becomes free' : `handed to ${userOf(plan).first}`; };
  const botLine = (bot: Bot): string => { const plan = botPlan[bot.id] ?? 'block'; return plan === 'block' ? 'blocked until an Admin takes it over (expires in 30 days)' : `now sponsored by ${userOf(plan).first}`; };
  const remove = (): void => passkey.confirm(() => {
    memberships.set(memberships.get().filter((entry) => entry.userId !== user.id));
    bots.set(bots.get().map((bot) => { const plan = botPlan[bot.id]; return bot.sponsor === user.id && plan && plan !== 'block' ? { ...bot, sponsor: plan } : bot; }));
    const blocked = blockSponsored(user, 'left the team');
    for (const id of held) { const plan = handles[id]; if (plan && plan !== 'keep' && plan !== 'free') assign(id, plan); }
    revoked.set(new Set([...revoked.get(), ...resources.flatMap((group) => group.items.map((item) => item.id))]));
    const count = resources.reduce((sum, group) => sum + group.items.length, 0);
    const text = `Removed ${user.name}: ${plural(devices.length, 'passkey and device', 'passkeys and devices')} deleted, ${plural(count - devices.length, 'personal resource')} revoked${held.length ? `; ${held.map((id) => `${workspaceName(id)} ${handleLine(id)}`).join(', ')}` : ''}${sponsored.length ? `; ${sponsored.map((bot) => `${bot.name} ${blocked.includes(bot.name) ? 'blocked until an Admin takes it over' : botLine(bot)}`).join(', ')}` : ''} · confirmed with ${passkeyLabel(viewer.id)}. History keeps the name.`;
    recordAudit({ actor: viewer.id, kind: 'team', text });
    say(`Removed ${user.name}. History keeps their name.`);
    setLine(text);
  });
  const next = (): void => {
    setError(null);
    if (step === 3) {
      if (typed.trim().toLowerCase() !== user.first.toLowerCase()) { setError(`Type ${user.first} to confirm.`); return; }
      remove();
      return;
    }
    setStep(step + 1);
  };
  const close = (): void => { if (line) removedUsers.set(new Set([...removedUsers.get(), user.id])); onClose(); };
  return <FlowDialog id="remove-person" steps={REMOVE_STEPS} step={step} done={line !== null} onClose={close}
    title={line ? `${user.name} removed` : `Remove ${user.name} from ${ACCOUNT_NAME}`}
    description={line ? undefined : 'Their user in this team ends. If they’re in other teams, those users are untouched.'}
    footer={line ? done(close) : <StepButtons step={step} onBack={() => { setError(null); setStep(step - 1); }} onCancel={onClose} next={next} busy={passkey.waiting} nextLabel={step === 3 ? `Remove ${user.first} with passkey` : 'Next'} />}>
    {line ? <FlowSuccess title="Removed and recorded in the audit log">{line}</FlowSuccess> : null}
    {!line && step === 0 ? (held.length ? <div className="flex flex-col gap-2">
      <Hint>{user.first} holds {plural(held.length, 'handle')}. Hand each to someone in its project, or leave it: a workspace with no holder left becomes free for anyone in the project to claim. {user.first}’s cleared shells close either way.</Hint>
      {held.map((id) => {
        const others = othersOn(id);
        const candidates = USERS.filter((entry) => entry.id !== user.id && !gone.has(entry.id) && !others.includes(entry.id) && projectRoleIdOf(entry.id, projectOf(id)) !== null);
        return <div key={id} data-handle={id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]">
          <span className="flex min-w-0 flex-col"><span className="font-mono text-body text-foreground">{workspaceName(id)}</span><span className="text-caption text-muted-foreground">{projectName(projectOf(id))}{others.length ? ` · also held by ${others.map((other) => userOf(other).first).join(', ')}` : ' · only holder'}</span></span>
          <Select value={handles[id] ?? 'free'} onValueChange={(value) => setHandles({ ...handles, [id]: value })}><SelectTrigger aria-label={`Handle of ${workspaceName(id)}`} /><SelectContent>
            {[...(others.length ? [{ id: 'keep', label: `Leave it with ${others.map((other) => userOf(other).first).join(' and ')}` }] : []), { id: 'free', label: others.length ? 'Leave it (no one added)' : 'Leave it free' }, ...candidates.map((entry) => ({ id: entry.id, label: `Hand to ${entry.name}` }))]
              .map((option, index) => <SelectItem key={option.id} value={option.id} index={index}>{option.label}</SelectItem>)}
          </SelectContent></Select>
        </div>;
      })}
    </div> : <Hint>{user.first} holds no handle in the projects you’re in.</Hint>) : null}
    {!line && step === 1 ? (sponsored.length ? <div className="flex flex-col gap-2">
      <Hint>{user.first} sponsors {plural(sponsored.length, 'bot')}. A bot’s sponsor must be an Admin or Owner: hand it to one and it keeps working, or block it: its sign-ins are kept, not deleted, until an Admin takes it over, and expire after 30 days.</Hint>
      {sponsored.map((bot) => <div key={bot.id} data-bot-plan={bot.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]">
        <span className="flex min-w-0 flex-col"><span className="text-body text-foreground">{bot.name}</span><span className="text-caption text-muted-foreground">{bot.description}</span></span>
        <Select value={botPlan[bot.id] ?? 'block'} onValueChange={(value) => setBotPlan({ ...botPlan, [bot.id]: value })}><SelectTrigger aria-label={`Sponsor for ${bot.name}`} /><SelectContent>
          {[...heirs.map((entry) => ({ id: entry.id, label: `Hand to ${entry.name}${entry.id === viewer.id ? ' (you)' : ''}` })), { id: 'block', label: 'Block its sign-ins' }].map((option, index) => <SelectItem key={option.id} value={option.id} index={index}>{option.label}</SelectItem>)}
        </SelectContent></Select>
      </div>)}
    </div> : <Hint>{user.first} sponsors no bot.</Hint>) : null}
    {!line && step === 2 ? <div className="flex flex-col gap-3">
      <Hint>Everything below is {user.first}’s own and is revoked: it joined workspaces only while {user.first} held the handle. Processes they started keep running, detached, until someone stops them.</Hint>
      <div className="grid gap-3 sm:grid-cols-2">{resources.map((group) => <div key={group.title} data-resource-group={group.title} className="flex flex-col gap-1 rounded-xl px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]">
        <span className="text-caption font-medium text-foreground">{group.title} · {group.items.length}</span>
        {group.items.length ? group.items.map((item) => <span key={item.id} className="text-caption text-muted-foreground line-through decoration-muted-foreground/60">{item.label}</span>) : <span className="text-caption text-muted-foreground">None</span>}
      </div>)}</div>
      {told.length ? <Facts title="Agent permissions they gave by talking stop applying" items={told.map((entry) => `“${entry.text}” · ${entry.scope}`)} /> : null}
    </div> : null}
    {!line && step === 3 ? <>
      <Summary rows={[
        ['Handles', held.length ? held.map((id) => `${workspaceName(id)} ${handleLine(id)}`).join(' · ') : 'None'],
        ['Bots', sponsored.length ? sponsored.map((bot) => `${bot.name} ${botLine(bot)}`).join(' · ') : 'None'],
        ['Revoked', resources.filter((group) => group.items.length).map((group) => `${group.items.length} ${group.title.toLowerCase()}`).join(' · ') || 'Nothing'],
        ['Memberships', 'Every project membership ends'],
        ['History', 'Prompts, comments, approvals, commits and the audit log keep their name'],
      ]} />
      <Field label={`Type ${user.first} to confirm`} value={typed} onChange={(value) => { setTyped(value); setError(null); }} placeholder={user.first} />
      <PasskeyStep userId={viewer.id} what={`removing ${user.first}`} waiting={passkey.waiting} />
    </> : null}
    {error ? <FlowError>{error}</FlowError> : null}
  </FlowDialog>;
}

// ── Project roles ──

/** A new project role, started from an existing one. */
export function NewRoleFlow({ onClose }: { onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const roles = useRoles();
  const [name, setName] = useState('');
  const [from, setFrom] = useState('contributor');
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const create = (): void => {
    const trimmed = name.trim();
    const taken = [...roles.map((role) => role.name), ...ACCOUNT_ROLES.map((role) => role.name)].find((entry) => entry.toLowerCase() === trimmed.toLowerCase());
    if (!trimmed) setError('Name the role, like QA or Support.');
    else if (trimmed.length > 24) setError('Keep it to 24 characters: it shows on every member row.');
    else if (taken) setError(`${taken} is already ${ACCOUNT_ROLES.some((role) => role.name === taken) ? 'an account role: project roles and account roles never share names' : 'a project role'}. Pick another name.`);
    else {
      addCustomRole(trimmed, from);
      recordAudit({ actor: viewer.id, kind: 'team', text: `Created project role ${trimmed} from ${roleName(from)}` });
      say(`Created ${trimmed} from ${roleName(from)}`);
      setMade(trimmed);
    }
  };
  return <FlowDialog id="new-role" wide={false} title={made ? `${made} created` : 'New project role'} done={made !== null} onClose={onClose}
    description={made ? undefined : 'Start from an existing project role, then adjust its column. It can be given in any project.'}
    footer={made ? done(onClose) : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={create}>Create role</Button></>}>
    {made ? <FlowSuccess title={`${made} has ${roleName(from)}’s permissions`}>Its column is in the matrix now: change any permission there, and give it to people from their Projects.</FlowSuccess> : <>
      <Field label="Name" placeholder="QA, Support, Reviewer" value={name} onChange={(value) => { setName(value); setError(null); }} error={error} onEnter={create} />
      <div className="flex items-center justify-between gap-3"><span className="text-body">Start from</span>
        <Select value={from} onValueChange={setFrom}><SelectTrigger aria-label="Start from" /><SelectContent>{roles.map((role, position) => <SelectItem key={role.id} value={role.id} index={position}>{role.name}</SelectItem>)}</SelectContent></Select>
      </div>
      <Hint>{roles.find((role) => role.id === from)?.description}</Hint>
    </>}
  </FlowDialog>;
}

/** Delete a custom project role: refused while anyone holds it. */
export function DeleteRoleDialog({ role, onClose }: { role: ProjectRole; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const live = memberships.use();
  const [deleted, setDeleted] = useState(false);
  const holding = live.filter((entry) => entry.roleId === role.id);
  return <FlowDialog id="delete-role" wide={false} title={deleted ? `${role.name} deleted` : `Delete ${role.name}?`} done={deleted} onClose={onClose}
    footer={deleted ? done(onClose) : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={holding.length > 0} onClick={() => {
      deleteRole(role.id); recordAudit({ actor: viewer.id, kind: 'team', text: `Deleted project role ${role.name}` }); say(`Deleted ${role.name}`); setDeleted(true);
    }}>Delete role</Button></>}>
    {deleted ? <FlowSuccess title={`${role.name} is gone`}>No one held it; its column left the matrix.</FlowSuccess> : holding.length
      ? <FlowError>{plural(holding.length, 'member has', 'members have')} {role.name} ({holding.map((entry) => `${actorLabel(entry.userId)} in ${projectName(entry.projectId)}`).join(', ')}). Give them another project role first, from Projects on their row, then delete it.</FlowError>
      : <Hint>No one holds it. Its column leaves the matrix; the audit log keeps who made and deleted it.</Hint>}
  </FlowDialog>;
}

// ── Secrets ──

type AddKind = 'secret' | 'token' | 'login';
const SECRET_STEPS = ['Kind', 'Name and value', 'Rule'] as const;
const SITE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;

/** Add a team secret, service token or login: kind → name and value (checked) → its rule (who may use it, the handle,
 * delivery), starting from the default for its sensitivity. */
export function AddTeamSecretFlow({ onClose }: { onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const allSecrets = secrets.use();
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<AddKind>('secret');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [plain, setPlain] = useState(false);
  const [sensitive, setSensitive] = useState(true);
  const [site, setSite] = useState('');
  const [username, setUsername] = useState('');
  const [otp, setOtp] = useState('');
  const [service, setService] = useState(TOKEN_SERVICES[0]?.id ?? '');
  const [check, setCheck] = useState<'idle' | 'checking' | 'missing' | 'ok'>('idle');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [added, setAdded] = useState<{ name: string; line: string } | null>(null);
  const svc = TOKEN_SERVICES.find((entry) => entry.id === service) ?? TOKEN_SERVICES[0]!;
  const host = kind === 'token' ? svc.host : site.trim().replace(/^https?:\/\//, '').split('/')[0] ?? '';
  const secretKind = kind === 'secret' ? (plain ? 'value' : 'secret') : kind;
  const rule = useRuleStep({ name, scope: 'team', kind: secretKind, sensitive: !plain && sensitive }, viewer.id);
  const nameProblem = (): string | null => {
    if (!name.trim()) return 'Required: the name agents and scripts ask for it by.';
    if (!ENV_NAME.test(name)) return `Use UPPER_SNAKE_CASE: capitals, digits and single underscores, starting with a letter (like ${kind === 'token' ? 'CLOUDFLARE_API_TOKEN' : kind === 'login' ? 'APPLE_DEVELOPER' : 'SENTRY_DSN'}).`;
    if (allSecrets.some((entry) => entry.scope === 'team' && entry.name === name)) return `${name} already exists in the team’s secrets: rotate it from its row instead.`;
    return null;
  };
  const tokenProblem = (): string | null => !value ? 'Paste the token.' : value.startsWith(svc.prefix) ? null : `A ${svc.label} token starts with ${svc.prefix}: this looks like a different kind of key.`;
  const checkToken = (): void => {
    const problem = tokenProblem();
    if (problem) { setErrors({ value: problem }); return; }
    setErrors({}); setCheck('checking');
    window.setTimeout(() => setCheck(SHORT_SCOPED_TOKENS[value] ? 'missing' : 'ok'), 1200);
  };
  const validateDetails = (): Readonly<Record<string, string>> => {
    const found: Record<string, string> = {};
    const problem = nameProblem(); if (problem) found.name = problem;
    if (kind === 'secret' && !value) found.value = 'Required. It’s write-only once saved.';
    if (kind === 'login') {
      if (!SITE.test(site.trim())) found.site = site.trim() ? `“${site}” isn’t a site: use its address, like developer.apple.com.` : 'Required: the site it signs in to.';
      if (!username.trim()) found.username = 'Required for a login.';
      if (!value) found.value = 'Required.';
      if (otp.trim() && !/^[A-Z2-7]+=*$/.test(otp.replace(/\s/g, '').toUpperCase())) found.otp = 'One-time code secrets are base32 (A–Z and 2–7): the text under the site’s “can’t scan?” link.';
    }
    if (kind === 'token') {
      const token = tokenProblem(); if (token) found.value = token;
      else if (check === 'idle') found.check = 'Check the token first: GitSpace reads its scopes from the service.';
      else if (check === 'missing') found.check = `It’s missing ${SHORT_SCOPED_TOKENS[value] ?? 'a scope'}.`;
    }
    return found;
  };
  const save = (): void => {
    const chosen = rule.validate();
    if (!chosen) return;
    const entry: SecretEntry = {
      id: `added-${Date.now()}`, name, scope: 'team', kind: secretKind, sensitive: !plain && sensitive, expires: null, updated: `today by ${viewer.first}`, lastUsed: 'never',
      detail: kind === 'secret' ? (plain ? value : 'Team secret') : kind === 'token' ? `${svc.label} · scopes checked: ${svc.needs.join(', ')}` : `${host} login${otp.trim() ? ' · password and one-time code' : ''}`,
      site: host || undefined, username: kind === 'login' ? username.trim() : undefined,
    };
    secrets.set([...allSecrets, entry]);
    secretRules.set({ ...secretRules.get(), [`team:${name}`]: chosen });
    const line = ruleLine(chosen, { value: plain && kind === 'secret' });
    recordAudit({ actor: viewer.id, kind: 'resource', text: `Added team ${SECRET_KIND_LABEL[secretKind].toLowerCase()} ${name} · ${line}` });
    say(`Added ${name}`);
    setAdded({ name, line });
  };
  const next = (): void => {
    if (step === 1) { const found = validateDetails(); setErrors(found); if (Object.keys(found).length) return; }
    if (step === 2) { save(); return; }
    setErrors({}); setStep(step + 1);
  };
  return <FlowDialog id="add-team-secret" steps={SECRET_STEPS} step={step} done={added !== null} onClose={onClose}
    title={added ? `${added.name} added` : 'Add a team secret'} description={added ? undefined : 'Values are write-only: once saved, nobody sees them again, here or in a workspace’s files.'}
    footer={added ? done(onClose) : <StepButtons step={step} onBack={() => { setErrors({}); rule.reset(); setStep(step - 1); }} onCancel={onClose} next={next} nextLabel={step === 2 ? `Add ${name}` : 'Next'} />}>
    {added ? <FlowSuccess title={added.line}>Agents get it under this rule from their next request; open cleared shells keep their old environment until they close. It shows on this page: rotate it or edit its rule from its row.</FlowSuccess> : null}
    {!added && step === 0 ? <ChoiceCards label="Kind" value={kind} onChange={(id) => { if (id === 'secret' || id === 'token' || id === 'login') { setKind(id); setErrors({}); setCheck('idle'); setSensitive(id !== 'login'); if (id === 'token' && !name) setName('CLOUDFLARE_API_TOKEN'); } }} choices={[
      { id: 'secret', title: 'Secret or value', detail: 'A secret string, like SENTRY_DSN; or a plain value that isn’t secret, like AWS_REGION.', icon: ShieldTick },
      { id: 'token', title: 'Service token', detail: 'An API token for Cloudflare, Stripe or Sentry. GitSpace checks its scopes with the service before saving.', icon: Building02 },
      { id: 'login', title: 'Login', detail: 'A username and password (and one-time code) for a site. Only approved scripts (a sign-in step, a smoke test) or a cleared shell get it; agents never see it.', icon: UserCircle },
    ]} /> : null}
    {!added && step === 1 ? <>
      {kind === 'token' ? <div className="flex items-center justify-between gap-3"><span className="text-body">Service</span>
        <Select value={service} onValueChange={(next) => { setService(next); setCheck('idle'); setErrors({}); }}><SelectTrigger aria-label="Service" /><SelectContent>
          {TOKEN_SERVICES.map((entry, index) => <SelectItem key={entry.id} value={entry.id} index={index}>{entry.label}</SelectItem>)}
        </SelectContent></Select></div> : null}
      <Field label="Name" placeholder={kind === 'token' ? 'CLOUDFLARE_API_TOKEN' : kind === 'login' ? 'APPLE_DEVELOPER' : 'SENTRY_DSN'} value={name} onChange={(next) => { setName(next); setErrors({}); }} error={errors.name} hint="Agents and approved scripts ask for it by this name." />
      {kind === 'login' ? <>
        <Field label="Site" placeholder="developer.apple.com" value={site} onChange={(next) => { setSite(next); setErrors({}); }} error={errors.site} />
        <Field label="Username" placeholder="dev@crumbco.example" value={username} onChange={(next) => { setUsername(next); setErrors({}); }} error={errors.username} />
      </> : null}
      {kind === 'token' ? <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1"><Field label="Token" type="password" placeholder={svc.example} value={value} onChange={(next) => { setValue(next); setCheck('idle'); setErrors({}); }} error={errors.value} hint={`Needs ${svc.needs.join(' and ')}.`} /></div>
        <Button variant="secondary" className="mt-1" loading={check === 'checking'} disabled={check === 'checking'} onClick={checkToken}>Check token</Button>
      </div> : <Field label={kind === 'login' ? 'Password' : 'Value'} type={plain && kind === 'secret' ? 'text' : 'password'} value={value} onChange={(next) => { setValue(next); setErrors({}); }} error={errors.value} />}
      {kind === 'login' ? <Field label="One-time code secret (optional)" value={otp} onChange={(next) => { setOtp(next); setErrors({}); }} error={errors.otp} /> : null}
      {kind === 'secret' ? <Switch label="Not secret: show the value on this page (a region, a feature flag)" checked={plain} onToggle={() => setPlain(!plain)} /> : null}
      {plain && kind === 'secret' ? null : <Switch label="Sensitive: production, money or admin (starts as only to approved scripts)" checked={sensitive} onToggle={() => setSensitive(!sensitive)} />}
      {kind === 'token' && check === 'checking' ? <div role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator />Asking {svc.label} which scopes the token has…</div> : null}
      {kind === 'token' && check === 'ok' ? <FlowSuccess title="Token works">{svc.label} reports {svc.needs.join(' and ')}: everything workspaces need.</FlowSuccess> : null}
      {kind === 'token' && check === 'missing' ? <FlowError>{svc.label} says this token lacks {SHORT_SCOPED_TOKENS[value]}, which deploys need. Add it at {svc.where}, then paste the new token and check again.</FlowError> : null}
      {errors.check && check !== 'missing' ? <FlowError>{errors.check}</FlowError> : null}
    </> : null}
    {!added && step === 2 ? rule.body : null}
  </FlowDialog>;
}

/** Rotate or replace a secret (team, project or a person's own), or edit a value: a new value typed twice and checked
 * with its site, or a new sign-in for a session or a site passkey; then what picks it up, by its rule's delivery. */
export function RotateSecretDialog({ secret, onClose }: { secret: SecretEntry; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const rules = secretRules.use();
  const isValue = secret.kind === 'value';
  const [first, setFirst] = useState(isValue ? secret.detail : '');
  const [again, setAgain] = useState('');
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const replacing = Boolean(secret.failing);
  const verb = isValue ? 'Edit' : replacing ? 'Replace' : 'Rotate';
  const owner = botOwner(secret.scope);
  const whose = scopeKind(secret.scope) === 'team' ? 'team' : scopeKind(secret.scope) === 'project' ? projectName(secret.scope) : owner ? `${owner.name}’s` : 'own';
  const rule = ruleOf({ kind: 'secret', secret }, rules);
  const minimum = secret.kind === 'token' ? 20 : 12;
  const pickup = isValue ? 'Every shell that may use it gets the new value at its next turn.'
    : rule.delivery.kind === 'shell' ? 'The next cleared shell gets it; shells open now keep the old value until they close.'
    : rule.delivery.kind === 'autofill' ? `Approved scripts, and the browser’s next fill on ${rule.delivery.origins.join(', ')}, get the new value.`
    : 'Approved scripts get the new value at their next run.';
  const save = (): void => {
    const found: Record<string, string> = {};
    if (isValue) {
      if (!first) found.first = 'A value can’t be empty.';
      else if (first === secret.detail) found.first = 'That’s the current value: change it, or cancel.';
    } else if (!secret.signIn) {
      if (!first) found.first = 'Paste the new value.';
      else if (first.length < minimum) found.first = `That’s ${first.length} characters; ${secret.kind === 'token' ? 'a token' : 'a secret'}${secret.site ? ` for ${secret.site}` : ''} is at least ${minimum}. Copy the whole value.`;
      if (first && again !== first) found.again = 'The two values differ: paste the same value in both.';
    }
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      secrets.set(secrets.get().map((entry) => entry.id === secret.id ? { ...entry, detail: isValue ? first : entry.detail, failing: undefined, expires: secret.expires === null ? null : 90, rotation: isValue ? entry.rotation : `${replacing ? 'Replaced' : 'Rotated'} just now by ${viewer.first}`, updated: `just now by ${viewer.first}` } : entry));
      recordAudit({ actor: viewer.id, kind: 'resource', text: `${isValue ? 'Changed' : replacing ? 'Replaced' : 'Rotated'} ${whose === 'own' ? 'their own' : whose} ${SECRET_KIND_LABEL[secret.kind].toLowerCase()} ${secret.name}`, project: scopeKind(secret.scope) === 'project' ? secret.scope : undefined });
      say(`${isValue ? 'Saved' : replacing ? 'Replaced' : 'Rotated'} ${secret.name}`);
      setSaved(true);
    }, isValue ? 0 : 1300);
  };
  return <FlowDialog id="rotate-secret" wide={false} done={saved} onClose={onClose}
    title={saved ? `${secret.name} ${isValue ? 'saved' : replacing ? 'replaced' : 'rotated'}` : `${verb} ${secret.name}`}
    description={saved ? undefined : `${SECRET_KIND_LABEL[secret.kind]}${secret.site ? ` · ${secret.site}` : ''}${secret.username ? ` · ${secret.username}` : ''} · ${isValue ? 'plain value' : 'the current value can’t be shown'}`}
    footer={saved ? done(onClose) : <><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} disabled={busy} onClick={save}>{isValue ? 'Save value' : secret.signIn ? 'Sign in again' : `${verb} and check`}</Button></>}>
    {saved ? <FlowSuccess title={isValue ? `${secret.name} is ${first}` : `${secret.site ?? 'The service'} accepted the new ${secret.signIn ? 'sign-in' : 'value'}`}>{pickup}{isValue || !secret.site ? '' : ` Revoke the old one at ${secret.site} once nothing uses it.`}</FlowSuccess> : <>
      {replacing ? <FlowError>{secret.failing}: {secret.rotation ?? 'nothing can use it'}. Make a new one{secret.site ? ` at ${secret.site}` : ''}, then paste it here.</FlowError> : null}
      {isValue ? <Field label="Value" value={first} onChange={(next) => { setFirst(next); setErrors({}); }} error={errors.first} onEnter={save} />
        : secret.signIn ? <Hint>{secret.kind === 'session' ? `Opens ${secret.site} in the cloud browser: sign in there and GitSpace keeps the new session.` : `Opens ${secret.site} in the cloud browser to register a new site passkey; the old one stops working when you delete it there.`}</Hint> : <>
        <Field label="New value" type="password" value={first} onChange={(next) => { setFirst(next); setErrors({}); }} error={errors.first} />
        <Field label="New value again" type="password" value={again} onChange={(next) => { setAgain(next); setErrors({}); }} error={errors.again} onEnter={save} />
      </>}
      {busy ? <div role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator />Checking with {secret.site ?? 'the service'}…</div> : null}
      <Hint>{pickup} Its rule stays: {ruleLine(rule, { value: isValue, ownerId: scopeKind(secret.scope) === 'own' ? secret.scope : null })}.</Hint>
    </>}
  </FlowDialog>;
}

// ── Domains ──

const DOMAIN_STEPS = ['Domain', 'DNS records', 'Certificate'] as const;
const CHALLENGE = 'gitspace-verify=crumbco-7Fq2kX9p';

/** The two records a custom domain needs: a TXT proving the team owns it, a CNAME sending it to GitSpace. */
function recordsFor(domain: string, purpose: CustomDomain['purpose']): { txt: string; cname: string; target: string; zone: string } {
  const base = domain.replace(/^\*\./, '');
  return { txt: `_gitspace-challenge.${base}`, cname: domain, target: purpose === 'previews' ? 'previews.crumbco.gitspace.sh' : TEAM.host, zone: base.split('.').slice(-2).join('.') };
}

/** The DNS step: the records, a Verify button's result, and what to fix. `attempt` 0 is unchecked; 1 found nothing;
 * 2 found the TXT and a CNAME with the zone appended; 3 found both. A check of an already-added domain skips the wrong
 * value (`straight`). */
function DnsCheck({ domain, purpose, attempt, checking, straight = false }: { domain: string; purpose: CustomDomain['purpose']; attempt: number; checking: boolean; straight?: boolean }) {
  const records = recordsFor(domain, purpose);
  const found = attempt >= (straight ? 2 : 3);
  const txt = found || (!straight && attempt === 2) ? 'found' : 'waiting';
  const cname = found ? 'found' : !straight && attempt === 2 ? 'wrong' : 'waiting';
  return <div className="flex flex-col gap-2">
    <Hint>Add these at the DNS provider for {records.zone}, then Verify. GitSpace looks them up from public resolvers.</Hint>
    <DnsRecord type="TXT" name={records.txt} value={CHALLENGE} state={txt} />
    <DnsRecord type="CNAME" name={records.cname} value={cname === 'wrong' ? `${records.target} · found ${records.target}.${records.zone}` : records.target} state={cname} />
    {checking ? <div role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator />Looking up {records.txt} and {records.cname}…</div> : null}
    {!checking && attempt === 1 ? <FlowError>No records found yet for {domain}. DNS changes can take up to an hour to show. Check they’re in the {records.zone} zone at your DNS provider (not a zone for a subdomain), then Check again.</FlowError> : null}
    {!checking && !straight && attempt === 2 ? <FlowError>The TXT record is right, but the CNAME points to {records.target}.{records.zone}: your DNS provider appended the zone name. Enter the target with a trailing dot ({records.target}.), then Check again.</FlowError> : null}
    {!checking && found ? <FlowSuccess title="Both records found">{domain} belongs to {ACCOUNT_NAME}. Keep the TXT record: GitSpace checks it again before each certificate renewal.</FlowSuccess> : null}
  </div>;
}

/** Add a custom domain: what it's for and its name (checked) → the DNS records, verified (not found yet, a wrong
 * value, then found) → its TLS certificate. */
export function AddDomainFlow({ onClose }: { onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const existing = customDomains.use();
  const [step, setStep] = useState(0);
  const [purpose, setPurpose] = useState<CustomDomain['purpose']>('address');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [issued, setIssued] = useState(false);
  const domain = draft.trim().toLowerCase();
  const next = (): void => {
    setError(null);
    if (step === 0) {
      const problem = !domain ? 'Enter the domain.'
        : purpose === 'previews' && !domain.startsWith('*.') ? `Previews need a wildcard, like *.${domain.replace(/^\*\./, '')}: each workspace gets its own name under it.`
        : purpose === 'address' && domain.startsWith('*.') ? 'An account address can’t be a wildcard: enter one name, like gitspace.crumbco.example.'
        : !DOMAIN_NAME.test(domain) ? `“${draft.trim()}” isn’t a domain name: letters, digits and hyphens between dots, like gitspace.crumbco.example.`
        : domain.endsWith('gitspace.sh') ? `${domain} is a GitSpace address: ${TEAM.host} is already yours. Enter a domain your team owns.`
        : existing.some((entry) => entry.name === domain) ? `${domain} is already on this page.` : null;
      if (problem) { setError(problem); return; }
      setStep(1);
      return;
    }
    if (step === 1 && attempt < 3) {
      setChecking(true);
      window.setTimeout(() => { setChecking(false); setAttempt(attempt + 1); }, 1000);
      return;
    }
    setStep(2);
    window.setTimeout(() => {
      customDomains.set([...customDomains.get(), { name: domain, purpose, state: 'verified', detail: `${purpose === 'previews' ? 'Workspace previews' : 'Custom domain'} · CNAME to ${recordsFor(domain, purpose).target} · verified just now` }]);
      recordAudit({ actor: viewer.id, kind: 'setting', text: `Added and verified ${domain} (${purpose === 'previews' ? 'workspace previews' : 'account address'}); TLS certificate issued` });
      say(`${domain} is active`);
      setIssued(true);
    }, 1600);
  };
  return <FlowDialog id="add-domain" steps={DOMAIN_STEPS} step={step} done={issued} onClose={onClose}
    title={issued ? `${domain} is active` : 'Add a custom domain'} description={issued ? undefined : `Another address for ${ACCOUNT_NAME}, or a domain for workspace previews. GitSpace manages its TLS certificate.`}
    footer={issued ? done(onClose) : step === 2 ? <Button variant="primary" loading disabled>Issuing certificate</Button>
      : <StepButtons step={step} onBack={() => { setError(null); setAttempt(0); setStep(step - 1); }} onCancel={onClose} next={next} busy={checking} nextLabel={step === 0 ? 'Next' : attempt === 0 ? 'Verify' : attempt < 3 ? 'Check again' : 'Issue certificate'} />}>
    {issued ? <FlowSuccess title={`https://${domain.replace(/^\*\./, '<workspace>.')} serves ${purpose === 'previews' ? 'workspace previews' : ACCOUNT_NAME}`}>TLS certificate from Let’s Encrypt, issued just now; GitSpace renews it 30 days before it expires (Feb 21, 2027). Keep both DNS records.</FlowSuccess> : null}
    {!issued && step === 0 ? <>
      <ChoiceCards label="Used for" columns={2} value={purpose} onChange={(next) => { if (next === 'address' || next === 'previews') { setPurpose(next); setError(null); } }} choices={[
        { id: 'address', title: 'Account address', detail: `People sign in and open ${ACCOUNT_NAME} there, as at ${TEAM.host}.`, icon: Globe04 },
        { id: 'previews', title: 'Workspace previews', detail: 'A wildcard: each workspace’s services at <workspace>.<your domain>.', icon: Globe04 },
      ]} />
      <Field label="Domain" placeholder={purpose === 'previews' ? '*.preview.crumbco.example' : 'gitspace.crumbco.example'} value={draft} onChange={(next) => { setDraft(next); setError(null); }} error={error} onEnter={next} />
    </> : null}
    {!issued && step === 1 ? <DnsCheck domain={domain} purpose={purpose} attempt={attempt} checking={checking} /> : null}
    {!issued && step === 2 ? <div role="status" className="flex items-center gap-2 text-body text-foreground"><ThinkingIndicator />Asking Let’s Encrypt for a certificate for {domain}…</div> : null}
  </FlowDialog>;
}

/** The DNS records of a domain still pending, with Verify: not found yet, then found and its certificate issued. */
export function DomainDnsDialog({ domain, onClose }: { domain: CustomDomain; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [active, setActive] = useState(false);
  const verify = (): void => {
    setChecking(true);
    window.setTimeout(() => {
      setChecking(false);
      setAttempt(attempt + 1);
      if (attempt + 1 >= 2) {
        customDomains.set(customDomains.get().map((entry) => entry.name === domain.name ? { ...entry, state: 'verified', detail: entry.detail.replace(/ · verified.*$/, '') + ' · verified just now' } : entry));
        recordAudit({ actor: viewer.id, kind: 'setting', text: `Verified ${domain.name}; TLS certificate issued` });
        say(`${domain.name} is active`);
        setActive(true);
      }
    }, 1000);
  };
  return <FlowDialog id="domain-dns" title={active ? `${domain.name} is active` : `DNS records for ${domain.name}`} done={active} onClose={onClose}
    footer={active ? done(onClose) : <><Button variant="secondary" onClick={onClose} disabled={checking}>Close</Button><Button variant="primary" loading={checking} disabled={checking} onClick={verify}>{attempt === 0 ? 'Verify' : 'Check again'}</Button></>}>
    <DnsCheck domain={domain.name} purpose={domain.purpose} attempt={attempt} checking={checking} straight />
    {active ? <FlowSuccess title="Certificate issued">TLS from Let’s Encrypt; GitSpace renews it 30 days before it expires.</FlowSuccess> : null}
  </FlowDialog>;
}

/** Remove a custom domain, typed to confirm. */
export function RemoveCustomDomainDialog({ domain, onClose }: { domain: CustomDomain; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const remove = (): void => {
    if (typed.trim().toLowerCase() !== domain.name) { setError(`Type ${domain.name} exactly to confirm.`); return; }
    customDomains.set(customDomains.get().filter((entry) => entry.name !== domain.name));
    recordAudit({ actor: viewer.id, kind: 'setting', text: `Removed the custom domain ${domain.name}` });
    say(`Removed ${domain.name}`);
    setRemoved(true);
  };
  return <FlowDialog id="remove-domain" wide={false} title={removed ? `${domain.name} removed` : `Remove ${domain.name}?`} done={removed} onClose={onClose}
    footer={removed ? done(onClose) : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={remove}>Remove domain</Button></>}>
    {removed ? <FlowSuccess title={`${ACCOUNT_NAME} no longer answers at ${domain.name}`}>{domain.purpose === 'previews' ? 'Previews are back at <workspace>.crumbco.gitspace.sh.' : `Everyone uses ${TEAM.host}.`} Delete its DNS records at your provider whenever you like.</FlowSuccess> : <>
      <Facts title="What happens" items={domain.purpose === 'previews'
        ? ['Workspace previews move back to <workspace>.crumbco.gitspace.sh; shared preview links at this domain stop working.', 'GitSpace stops renewing its certificate.']
        : [`Links and bookmarks to https://${domain.name} stop working; ${TEAM.host} keeps working.`, `Passkeys made at ${domain.name} work only there: people who made theirs there add one at ${TEAM.host} first.`, 'GitSpace stops renewing its certificate.']} />
      <Field label={`Type ${domain.name} to confirm`} value={typed} onChange={(next) => { setTyped(next); setError(null); }} error={error} onEnter={remove} />
    </>}
  </FlowDialog>;
}

// ── Source and releases ──

/** Switch the release channel. Refused while rolled back: updates are paused until the account returns to latest. */
export function ChannelDialog({ to, onClose }: { to: 'stable' | 'beta'; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const current = release.use();
  const [switched, setSwitched] = useState(false);
  const label = to === 'beta' ? 'Beta' : 'Stable';
  const apply = (): void => {
    release.set({ ...release.get(), channel: to });
    recordAudit({ actor: viewer.id, kind: 'setting', text: `Switched the release channel to ${label}` });
    say(`Release channel: ${label}`);
    setSwitched(true);
  };
  return <FlowDialog id="release-channel" wide={false} title={switched ? `On ${label} now` : `Switch to ${label}?`} done={switched} onClose={onClose}
    footer={switched ? done(onClose) : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!switched && current.rolledBack} onClick={apply}>Switch to {label}</Button></>}>
    {switched ? <FlowSuccess title={to === 'beta' ? 'Next update: 2026.11.4 on Friday' : 'Stable from the next release'}>{to === 'beta' ? 'Updates still wait for the update window and for running turns to finish.' : `${ACCOUNT_NAME} stays on ${current.running} until Stable passes it; nothing is downgraded.`}</FlowSuccess> : <>
      <Facts title="What changes" items={to === 'beta'
        ? ['Each release arrives the day it’s cut, a week before Stable: 2026.11.4 on Friday.', 'Beta builds can have bugs Stable won’t; report them from Help.', 'Everyone in the team gets the same build; there’s no per-person channel.']
        : [`Stays on ${current.running} until Stable reaches or passes it (about a week); nothing is downgraded.`, 'Then updates arrive a week after Beta.']} />
      {current.rolledBack ? <FlowError>Updates are paused after the roll back to {current.running}: Return to latest first, then switch channel.</FlowError> : null}
    </>}
  </FlowDialog>;
}

const ROLLBACK_STEPS = ['Release', 'Impact', 'Confirm'] as const;

/** Roll back to an earlier release: which one (none past an irreversible migration) → what happens and why → passkey →
 * deploying → rolled back, with automatic updates paused. */
export function RollbackFlow({ onClose }: { onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const passkey = usePasskey();
  const current = release.use();
  const earlier = RELEASES.filter((entry) => entry.version !== current.running);
  const [step, setStep] = useState(0);
  const [version, setVersion] = useState(earlier[0]?.version ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [finished, setFinished] = useState(false);
  const target = RELEASES.find((entry) => entry.version === version);
  const next = (): void => {
    setError(null);
    if (step === 1 && reason.trim().length < 8) { setError('Say why in a few words: it goes in the audit log and in the notice everyone in the team gets.'); return; }
    if (step === 2) {
      passkey.confirm(() => {
        setDeploying(true);
        window.setTimeout(() => {
          release.set({ ...release.get(), running: version, rolledBack: true, auto: false });
          recordAudit({ actor: viewer.id, kind: 'setting', text: `Rolled back GitSpace from ${current.running} to ${version}: “${reason.trim()}” · automatic updates paused · confirmed with ${passkeyLabel(viewer.id)}` });
          say(`Rolled back to ${version}`);
          setDeploying(false);
          setFinished(true);
        }, 1800);
      });
      return;
    }
    setStep(step + 1);
  };
  return <FlowDialog id="rollback" steps={ROLLBACK_STEPS} step={step} done={finished} onClose={onClose}
    title={finished ? `Running ${version}` : `Roll back ${ACCOUNT_NAME}`} description={finished ? undefined : `Running ${current.running} now. A roll back is for the whole account.`}
    footer={finished ? done(onClose) : <StepButtons step={step} onBack={() => { setError(null); setStep(step - 1); }} onCancel={onClose} next={next} busy={passkey.waiting || deploying} nextLabel={step === 2 ? 'Roll back with passkey' : 'Next'} />}>
    {finished ? <FlowSuccess title={`${ACCOUNT_NAME} rolled back to ${version}`}>Workspaces reconnected; turns that were running finished on {current.running}. Automatic updates are paused: Return to latest on Source & releases when the problem is fixed.</FlowSuccess> : null}
    {!finished && step === 0 ? <ChoiceCards label="Release" value={version} onChange={setVersion} choices={earlier.map((entry) => ({
      id: entry.version, title: entry.version, detail: `${entry.deployed} · ${entry.notes} · main@${entry.commit}`, icon: ClockRewind,
      disabled: entry.migration ? `Can’t roll back this far: ${entry.migration}.` : null,
    }))} /> : null}
    {!finished && step === 1 ? <>
      <Facts title="What happens" items={[
        'Running turns finish on the current release first; new turns wait a minute.',
        'Every workspace reconnects once; nothing in a workspace is lost.',
        `Features added after ${version} disappear until you return to latest${target ? ` (${RELEASES.filter((entry) => entry.version !== version && RELEASES.indexOf(entry) < RELEASES.indexOf(target)).map((entry) => entry.notes).join('; ')})` : ''}.`,
        'Automatic updates pause until you return to latest.',
        'Everyone in the team sees a notice with your reason.',
      ]} />
      <TextArea label="Why" rows={3} value={reason} onChange={(next) => { setReason(next); setError(null); }} placeholder="The audit export times out since 2026.11.3" error={error ?? undefined} />
    </> : null}
    {!finished && step === 2 ? <>
      <Summary rows={[['From', current.running], ['To', `${version} · ${target?.deployed ?? ''}`], ['Why', reason.trim()], ['Updates', 'Paused until you return to latest']]} />
      {deploying ? <div role="status" className="flex items-center gap-2 text-body text-foreground"><ThinkingIndicator />Deploying {version}: running turns finish first, then workspaces reconnect…</div> : <PasskeyStep userId={viewer.id} what="the roll back" waiting={passkey.waiting} />}
    </> : null}
  </FlowDialog>;
}

/** After a roll back: update to the latest release on the channel and resume automatic updates. */
export function ReturnToLatestDialog({ onClose }: { onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const current = release.use();
  const latest = RELEASES[0]?.version ?? current.running;
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  const go = (): void => {
    setBusy(true);
    window.setTimeout(() => {
      release.set({ ...release.get(), running: latest, rolledBack: false, auto: true });
      recordAudit({ actor: viewer.id, kind: 'setting', text: `Returned GitSpace to ${latest} and resumed automatic updates` });
      say(`Running ${latest}`);
      setBusy(false); setFinished(true);
    }, 1500);
  };
  return <FlowDialog id="return-latest" wide={false} title={finished ? `Running ${latest}` : `Return to ${latest}?`} done={finished} onClose={onClose}
    footer={finished ? done(onClose) : <><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} disabled={busy} onClick={go}>Update to {latest}</Button></>}>
    {finished ? <FlowSuccess title="Up to date">Automatic updates are on again: Sundays 02:00–04:00.</FlowSuccess>
      : <Facts title="What happens" items={[`${ACCOUNT_NAME} updates from ${current.running} to ${latest} now; running turns finish first.`, 'Automatic updates resume.']} />}
  </FlowDialog>;
}

// ── GitHub App ──

const TAKEN_APP_NAMES: readonly string[] = ['gitspace', 'gitspace app', 'crumb'];

/** A stand-in for GitHub's own page in the flow: what GitHub shows and its two buttons. */
function OnGitHub({ url, title, children, action, onAction, onCancel }: { url: string; title: string; children: ReactNode; action: string; onAction(): void; onCancel(): void }) {
  return <div data-github-page="" className="flex flex-col gap-3 rounded-xl bg-surface-1 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
    <span className="flex items-center gap-2 font-mono text-caption text-muted-foreground"><GitBranch01 width={14} height={14} />{url}</span>
    <span className="text-body font-semibold text-foreground">{title}</span>
    <div className="flex flex-col gap-1 text-caption text-muted-foreground">{children}</div>
    <div className="flex gap-2"><Button variant="primary" size="compact" onClick={onAction}>{action}</Button><Button variant="secondary" size="compact" onClick={onCancel}>Cancel</Button></div>
  </div>;
}

const CREATE_APP_STEPS = ['Name', 'Permissions', 'On GitHub'] as const;

/** Create the team's GitHub App from a manifest: its name and owner (checked) → the permissions it asks for → GitHub,
 * where you create it (or cancel) → the App, its private key and webhook secret kept by GitSpace. */
export function CreateAppFlow({ onClose, onInstall }: { onClose(): void; onInstall(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const account = GITHUB_ACCOUNTS[viewer.id] ?? null;
  const orgs = GITHUB_ORGS.filter((org) => org.owners.includes(viewer.id));
  const [step, setStep] = useState(0);
  const [name, setName] = useState(`GitSpace for ${ACCOUNT_NAME}`);
  const [owner, setOwner] = useState(orgs[0]?.login ?? account ?? '');
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'ready' | 'redirecting' | 'github' | 'cancelled' | 'exchanging' | 'made'>('ready');
  const next = (): void => {
    setError(null);
    if (step === 0) {
      const problem = !account ? 'Connect your GitHub account first, under You › Git identity: GitHub creates the App as you.'
        : !name.trim() ? 'Name the App.'
        : name.trim().length > 34 ? `GitHub limits App names to 34 characters; this is ${name.trim().length}.`
        : !/^[A-Za-z0-9 &._-]+$/.test(name.trim()) ? 'GitHub allows letters, digits, spaces and & . _ - in App names.'
        : TAKEN_APP_NAMES.includes(name.trim().toLowerCase()) ? `GitHub says “${name.trim()}” is taken: App names are unique across GitHub. Add your team’s name, like GitSpace for ${ACCOUNT_NAME}.` : null;
      if (problem) { setError(problem); return; }
    }
    if (step === 2) {
      setPhase('redirecting');
      window.setTimeout(() => setPhase('github'), 900);
      return;
    }
    setStep(step + 1);
  };
  const create = (): void => {
    setPhase('exchanging');
    window.setTimeout(() => {
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      githubApp.set({ name: name.trim(), slug, installations: [] });
      recordAudit({ actor: viewer.id, kind: 'setting', text: `Created the GitHub App ${name.trim()} in ${owner} from GitSpace’s manifest` });
      say(`Created ${name.trim()}`);
      setPhase('made');
    }, 1200);
  };
  return <FlowDialog id="create-github-app" steps={CREATE_APP_STEPS} step={step} done={phase === 'made'} onClose={onClose}
    title={phase === 'made' ? `${name.trim()} created` : 'Create the GitHub App'} description={phase === 'made' ? undefined : `One App for ${ACCOUNT_NAME}, installed once per GitHub organization. GitSpace sends GitHub a manifest; you confirm on github.com.`}
    footer={phase === 'made' ? <><Button variant="secondary" onClick={onClose}>Later</Button><Button variant="primary" onClick={onInstall}>Install on an organization</Button></>
      : step === 2 && (phase === 'github' || phase === 'exchanging') ? <Button variant="secondary" onClick={onClose} disabled={phase === 'exchanging'}>Cancel</Button>
      : <StepButtons step={step} onBack={() => { setError(null); setPhase('ready'); setStep(step - 1); }} onCancel={onClose} next={next} busy={phase === 'redirecting'} nextLabel={step === 2 ? 'Continue to GitHub' : 'Next'} />}>
    {phase === 'made' ? <FlowSuccess title={`${name.trim()} belongs to ${owner} on GitHub`}>GitSpace keeps its private key and webhook secret; nobody handles them. Install it on an organization to choose the repositories it reaches.</FlowSuccess> : null}
    {phase !== 'made' && step === 0 ? <>
      <Field label="App name" value={name} onChange={(next) => { setName(next); setError(null); }} error={error} hint="Shown on GitHub next to every commit status, check and pull request it makes." />
      {account ? <ChoiceCards label="Owner on GitHub" value={owner} onChange={setOwner} choices={[
        ...orgs.map((org) => ({ id: org.login, title: org.login, detail: 'Organization you own: other owners can manage the App too.', icon: Building02 })),
        { id: account, title: account, detail: 'Your personal account: only you can manage the App on GitHub.', icon: UserCircle },
      ]} /> : null}
    </> : null}
    {phase !== 'made' && step === 1 ? <>
      <Summary rows={[...APP_PERMISSIONS, ['Events', APP_EVENTS], ['Callback', `https://${TEAM.host}/github/callback`], ['Webhook', `https://${TEAM.host}/github/events`]]} />
      <Hint>Exactly what GitSpace needs to clone, push, open pull requests and run checks. Each installation then limits it to the repositories chosen there.</Hint>
    </> : null}
    {phase !== 'made' && step === 2 ? <>
      {phase === 'ready' || phase === 'redirecting' ? <Hint>GitSpace opens github.com with the manifest filled in. Create the App there and GitHub sends you back here.</Hint> : null}
      {phase === 'github' ? <OnGitHub url={`github.com/${owner === account ? 'settings' : `organizations/${owner}/settings`}/apps/new`} title={`Create GitHub App for ${owner}`} action="Create GitHub App" onAction={create} onCancel={() => setPhase('cancelled')}>
        <span>Name: {name.trim()}</span><span>Permissions: {APP_PERMISSIONS.length} (as listed in GitSpace)</span><span>Webhook: https://{TEAM.host}/github/events</span>
      </OnGitHub> : null}
      {phase === 'cancelled' ? <FlowError>You came back from GitHub without creating the App. Nothing was made, on GitHub or here: Continue to GitHub again when ready.</FlowError> : null}
      {phase === 'exchanging' ? <div role="status" className="flex items-center gap-2 text-body text-foreground"><ThinkingIndicator />Exchanging GitHub’s one-time code for the App’s private key and webhook secret…</div> : null}
    </> : null}
  </FlowDialog>;
}

/** Repositories in an organization, with a search: toggles for the selected ones. */
function RepoPicker({ org, picked, onChange }: { org: GitHubOrg; picked: ReadonlySet<string>; onChange(next: ReadonlySet<string>): void }) {
  const [query, setQuery] = useState('');
  const shown = org.repositories.filter((repository) => repository.includes(query.trim().toLowerCase()));
  return <div className="flex flex-col gap-2">
    <InputGroup className="w-full"><InputField index={0} label="Search repositories" labelHidden icon={glyph(SearchMd)} placeholder={`Search ${org.login}`} value={query} onChange={setQuery} /></InputGroup>
    <div role="group" aria-label="Repositories" className="flex max-h-60 flex-col overflow-y-auto rounded-xl shadow-[inset_0_0_0_1px_var(--border)]">
      {shown.map((repository) => {
        const on = picked.has(repository);
        return <button key={repository} type="button" role="checkbox" aria-checked={on} data-repo={repository} className="flex items-center gap-2 px-3 py-2 text-left text-body hover:bg-hover"
          onClick={() => { const nextSet = new Set(picked); if (on) nextSet.delete(repository); else nextSet.add(repository); onChange(nextSet); }}>
          <span aria-hidden className={`flex size-4 shrink-0 items-center justify-center rounded ${on ? 'bg-[#6B97FF] text-white' : 'shadow-[inset_0_0_0_1.5px_var(--border)]'}`}>{on ? <Check width={12} height={12} strokeWidth={3} /> : null}</span>
          <span className="font-mono text-foreground">{org.login}/{repository}</span>
        </button>;
      })}
      {shown.length ? null : <span className="px-3 py-2 text-caption text-muted-foreground">No repository in {org.login} matches “{query}”.</span>}
    </div>
    <Hint>{plural(picked.size, 'repository', 'repositories')} selected of {org.repositories.length}.</Hint>
  </div>;
}

const INSTALL_STEPS = ['Organization', 'Repositories', 'On GitHub'] as const;

/** Install the App on another organization: pick one (an owner installs; a member sends owners a request) → all or
 * selected repositories → confirm on GitHub → installed. */
export function InstallAppFlow({ onClose }: { onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const app = githubApp.use();
  const installed = new Set((app?.installations ?? []).map((entry) => entry.org));
  const orgs = GITHUB_ORGS.filter((org) => org.owners.includes(viewer.id) || org.members.includes(viewer.id));
  const [step, setStep] = useState(0);
  const [org, setOrg] = useState(orgs.find((entry) => !installed.has(entry.login))?.login ?? '');
  const [selection, setSelection] = useState<'all' | 'selected'>('selected');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [needsOwner, setNeedsOwner] = useState(false);
  const [phase, setPhase] = useState<'ready' | 'github' | 'cancelled' | 'installing' | 'installed' | 'requested'>('ready');
  const chosen = GITHUB_ORGS.find((entry) => entry.login === org);
  const appName = app?.name ?? 'the App';
  const next = (): void => {
    setError(null);
    if (step === 0) {
      if (!chosen) { setError('Pick an organization.'); return; }
      if (!chosen.owners.includes(viewer.id)) { setNeedsOwner(true); return; }
      setPicked(new Set());
    }
    if (step === 1 && selection === 'selected' && !picked.size) { setError('Pick at least one repository, or choose All repositories.'); return; }
    if (step === 2) { setPhase('github'); return; }
    setStep(step + 1);
  };
  const install = (): void => {
    if (!chosen || !app) return;
    setPhase('installing');
    window.setTimeout(() => {
      const repositories = (selection === 'all' ? chosen.repositories : chosen.repositories.filter((repository) => picked.has(repository))).map((repository) => `github.com/${chosen.login}/${repository}`);
      githubApp.set({ ...app, installations: [...app.installations, { org: chosen.login, installed: 'just now', by: viewer.id, selection, repositories }] });
      recordAudit({ actor: viewer.id, kind: 'setting', text: `Installed ${app.name} on ${chosen.login} · ${selection === 'all' ? 'all repositories' : repositories.map((repository) => repository.split('/').slice(-1)[0]).join(', ')}` });
      say(`Installed on ${chosen.login}`);
      setPhase('installed');
    }, 1200);
  };
  const request = (): void => {
    recordAudit({ actor: viewer.id, kind: 'setting', text: `Asked the owners of ${org} on GitHub to install ${appName}` });
    say(`Request sent to ${org}’s owners`);
    setPhase('requested');
  };
  const finished = phase === 'installed' || phase === 'requested';
  return <FlowDialog id="install-github-app" steps={INSTALL_STEPS} step={step} done={finished} onClose={onClose}
    title={phase === 'installed' ? `Installed on ${org}` : phase === 'requested' ? `Request sent to ${org}` : `Install ${appName}`}
    description={finished ? undefined : 'Once per GitHub organization. The installation decides which of its repositories GitSpace reaches.'}
    footer={finished ? done(onClose) : needsOwner ? <><Button variant="ghost" onClick={() => setNeedsOwner(false)}>Pick another</Button><Button variant="primary" onClick={request}>Send request to an owner</Button></>
      : phase === 'github' || phase === 'installing' ? <Button variant="secondary" disabled={phase === 'installing'} onClick={onClose}>Cancel</Button>
      : <StepButtons step={step} onBack={() => { setError(null); setPhase('ready'); setStep(step - 1); }} onCancel={onClose} next={next} nextLabel={step === 2 ? 'Continue to GitHub' : 'Next'} />}>
    {phase === 'installed' ? <FlowSuccess title={`${appName} reaches ${selection === 'all' ? `every repository in ${org}, including new ones` : `${plural(picked.size, 'repository', 'repositories')} in ${org}`}`}>Projects using them get App tokens on every machine from their next turn. Change the repositories on this page any time.</FlowSuccess> : null}
    {phase === 'requested' ? <FlowSuccess title={`GitHub emailed ${chosen?.owners.join(', ') ?? 'the owners'}`}>When one approves, the installation shows on this page. They approve at github.com/organizations/{org}/settings/installations → Pending GitHub Apps installation requests → {appName} → Review → choose the repositories → Install.</FlowSuccess> : null}
    {!finished && step === 0 ? <>
      <ChoiceCards label="Organization" value={org} onChange={(next) => { setOrg(next); setNeedsOwner(false); setError(null); }} choices={orgs.map((entry) => ({
        id: entry.login, title: entry.login, icon: Building02, detail: `${entry.repositories.length} repositories · owners: ${entry.owners.join(', ')}`,
        badge: <span className="text-caption font-normal text-muted-foreground">{entry.owners.includes(viewer.id) ? 'You’re an owner' : 'You’re a member'}</span>,
        disabled: installed.has(entry.login) ? 'Already installed: change its repositories on this page instead.' : null,
      }))} />
      {needsOwner ? <FlowError>You’re a member of {org}, not an owner: GitHub lets only an organization’s owners install Apps. Ask {chosen?.owners.join(' or ')} to install it, or send a request: GitHub emails the owners, and the installation shows here when one approves.</FlowError> : null}
    </> : null}
    {!finished && step === 1 && chosen ? <>
      <ChoiceCards label="Repository access" columns={2} value={selection} onChange={(next) => { if (next === 'all' || next === 'selected') { setSelection(next); setError(null); } }} choices={[
        { id: 'all', title: 'All repositories', detail: `Every repository in ${chosen.login}, including ones made later.` },
        { id: 'selected', title: 'Only selected repositories', detail: 'Just the ones you pick; add more later.' },
      ]} />
      {selection === 'selected' ? <RepoPicker org={chosen} picked={picked} onChange={(next) => { setPicked(next); setError(null); }} /> : null}
    </> : null}
    {!finished && step === 2 && chosen ? <>
      {phase === 'ready' ? <Summary rows={[['Organization', chosen.login], ['Repositories', selection === 'all' ? 'All, including new ones' : [...picked].join(', ')], ['Permissions', APP_PERMISSIONS.map(([key, value]) => `${key}: ${value.toLowerCase()}`).join(' · ')]]} /> : null}
      {phase === 'github' ? <OnGitHub url={`github.com/apps/${app?.slug ?? 'gitspace'}/installations/new`} title={`Install & Authorize ${appName} on ${chosen.login}`} action="Install & Authorize" onAction={install} onCancel={() => setPhase('cancelled')}>
        <span>for {selection === 'all' ? 'all repositories' : `these repositories: ${[...picked].join(', ')}`}</span><span>with permissions: {APP_PERMISSIONS.map(([key]) => key).join(', ')}</span>
      </OnGitHub> : null}
      {phase === 'cancelled' ? <FlowError>You cancelled on GitHub, so nothing was installed. Continue to GitHub again when ready.</FlowError> : null}
      {phase === 'installing' ? <div role="status" className="flex items-center gap-2 text-body text-foreground"><ThinkingIndicator />Waiting for GitHub’s installation event…</div> : null}
    </> : null}
    {error ? <FlowError>{error}</FlowError> : null}
  </FlowDialog>;
}

/** Change which repositories an installation covers. Taking away one a project uses needs saying so. */
export function ChangeReposDialog({ org, onClose }: { org: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const app = githubApp.use();
  const settings = projectSettings.use();
  const installation = app?.installations.find((entry) => entry.org === org);
  const known = GITHUB_ORGS.find((entry) => entry.login === org);
  const full = (repository: string): string => `github.com/${org}/${repository}`;
  const [selection, setSelection] = useState<'all' | 'selected'>(installation?.selection ?? 'selected');
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set((installation?.repositories ?? []).map((repository) => repository.split('/').slice(-1)[0] ?? '')));
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!app || !installation || !known) return null;
  const losing = selection === 'all' ? [] : installation.repositories.filter((repository) => !picked.has(repository.split('/').slice(-1)[0] ?? ''));
  const used = losing.flatMap((repository) => Object.entries(settings).filter(([, entry]) => entry.repositories.includes(repository)).map(([id]) => `${projectName(id)} uses ${repository.replace('github.com/', '')}`));
  const save = (): void => {
    if (selection === 'selected' && !picked.size) { setError(`Pick at least one repository. To stop covering ${org} entirely, uninstall the App instead.`); return; }
    if (used.length && !ack) { setError(`${used.join('; ')}. Without the App its workspaces fall back to the machine’s SSH key, which may not reach it. Confirm below to remove it anyway.`); return; }
    const repositories = (selection === 'all' ? known.repositories : known.repositories.filter((repository) => picked.has(repository))).map(full);
    githubApp.set({ ...app, installations: app.installations.map((entry) => entry.org === org ? { ...entry, selection, repositories } : entry) });
    recordAudit({ actor: viewer.id, kind: 'setting', text: `Changed ${app.name}’s repositories on ${org}: ${selection === 'all' ? 'all repositories' : repositories.map((repository) => repository.split('/').slice(-1)[0]).join(', ')}` });
    say(`Saved ${org}’s repositories`);
    setSaved(true);
  };
  return <FlowDialog id="change-repos" title={saved ? `${org} updated on GitHub` : `Repositories ${app.name} reaches in ${org}`} done={saved} onClose={onClose}
    footer={saved ? done(onClose) : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save on GitHub</Button></>}>
    {saved ? <FlowSuccess title={selection === 'all' ? `Every repository in ${org}` : `${plural(picked.size, 'repository', 'repositories')} in ${org}`}>GitHub has the new list. Workspaces get App tokens for these from their next turn{losing.length ? `; ${losing.map((repository) => repository.replace('github.com/', '')).join(', ')} now use${losing.length === 1 ? 's' : ''} the machine’s SSH key` : ''}.</FlowSuccess> : <>
      <ChoiceCards label="Repository access" columns={2} value={selection} onChange={(next) => { if (next === 'all' || next === 'selected') { setSelection(next); setError(null); } }} choices={[
        { id: 'all', title: 'All repositories', detail: `Every repository in ${org}, including ones made later.` },
        { id: 'selected', title: 'Only selected repositories', detail: 'Just the ones picked below.' },
      ]} />
      {selection === 'selected' ? <RepoPicker org={known} picked={picked} onChange={(next) => { setPicked(next); setError(null); setAck(false); }} /> : null}
      {error ? <FlowError>{error}</FlowError> : null}
      {used.length ? <Switch label="Remove anyway: those projects lose App tokens for it" checked={ack} onToggle={() => { setAck(!ack); setError(null); }} /> : null}
    </>}
  </FlowDialog>;
}

/** Uninstall the App from an organization, typed to confirm. */
export function UninstallAppDialog({ org, onClose }: { org: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const app = githubApp.use();
  const settings = projectSettings.use();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const installation = app?.installations.find((entry) => entry.org === org);
  const users = Object.entries(settings).filter(([, entry]) => entry.repositories.some((repository) => repository.startsWith(`github.com/${org}/`))).map(([id]) => projectName(id));
  const remove = (): void => {
    if (!app) return;
    if (typed.trim() !== org) { setError(`Type ${org} exactly to confirm.`); return; }
    githubApp.set({ ...app, installations: app.installations.filter((entry) => entry.org !== org) });
    recordAudit({ actor: viewer.id, kind: 'setting', text: `Uninstalled ${app.name} from ${org}` });
    say(`Uninstalled from ${org}`);
    setRemoved(true);
  };
  return <FlowDialog id="uninstall-github-app" wide={false} title={removed ? `Uninstalled from ${org}` : `Uninstall ${app?.name ?? 'the App'} from ${org}?`} done={removed} onClose={onClose}
    description={removed ? undefined : `This removes the App from ${org} on GitHub, for the whole organization. An owner can install it again later.`}
    footer={removed ? done(onClose) : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={remove}>Uninstall from {org}</Button></>}>
    {removed ? <FlowSuccess title={`GitSpace no longer reaches ${org}`}>Workspaces keep their copies and branches; nothing is deleted. Install again from this page whenever you like.</FlowSuccess> : <>
      <Facts title={`What stops${users.length ? ` for ${users.join(', ')}` : ''}`} items={[
        `App tokens for ${installation ? plural(installation.repositories.length, 'repository', 'repositories') : 'its repositories'}: workspaces fall back to the machine’s SSH key`,
        'Pushes, pull requests and checks GitSpace makes as the App',
        'GitHub events for automations',
      ]} />
      <Field label={`Type ${org} to confirm`} value={typed} onChange={(next) => { setTyped(next); setError(null); }} error={error} onEnter={remove} />
    </>}
  </FlowDialog>;
}

// ── Audit log export ──

const EXPORT_STEPS = ['Format', 'Range and contents', 'Download'] as const;
const EXTRA_COLUMNS: ReadonlyArray<{ id: string; label: string }> = [{ id: 'client', label: 'MCP client' }, { id: 'sponsor', label: 'Bot’s sponsor' }, { id: 'project', label: 'Project' }];

/** Export the audit log: CSV or JSON → the filtered view or a period, and which columns → preparing → a download. */
export function ExportAuditFlow({ filtered, all, filters, onClose }: { filtered: readonly AuditEntry[]; all: readonly AuditEntry[]; filters: string; onClose(): void }) {
  const viewer = useViewer();
  const { say } = useMock();
  const [step, setStep] = useState(0);
  const [format, setFormat] = useState('csv');
  const [range, setRange] = useState('filtered');
  const [columns, setColumns] = useState<ReadonlySet<string>>(new Set(EXTRA_COLUMNS.map((entry) => entry.id)));
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<{ name: string; url: string; size: number } | null>(null);
  const rows = range === 'filtered' ? filtered : all;
  const sponsor = (id: string): string => { const principal = findPrincipal(id); return principal?.kind === 'bot' && principal.sponsor ? userOf(principal.sponsor).name : ''; };
  const build = (): string => {
    const records = rows.map((entry) => ({
      time: entry.time, actor: actorLabel(entry.actor), kind: entry.kind, text: entry.text,
      ...(columns.has('client') ? { client: entry.client ?? '' } : {}), ...(columns.has('sponsor') ? { sponsor: sponsor(entry.actor) } : {}), ...(columns.has('project') ? { project: entry.project ? projectName(entry.project) : '' } : {}),
    }));
    if (format === 'json') return JSON.stringify(records, null, 2);
    const head = Object.keys(records[0] ?? { time: '', actor: '', kind: '', text: '' });
    return [head.join(','), ...records.map((record) => Object.values(record).map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))].join('\n');
  };
  const next = (): void => {
    setError(null);
    if (step === 1) {
      if (!rows.length) { setError('Nothing to export: the filters match no entries. Clear a filter, or export the last 30 days instead.'); return; }
      setStep(2);
      window.setTimeout(() => {
        const content = build();
        const name = `crumbco-audit-2026-11-${AUDIT_TODAY}${range === 'filtered' ? '-filtered' : ''}.${format}`;
        setFile({ name, url: URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv' })), size: content.length });
        recordAudit({ actor: viewer.id, kind: 'setting', text: `Exported ${plural(rows.length, 'audit entry', 'audit entries')} as ${format.toUpperCase()} (${range === 'filtered' ? `filtered: ${filters}` : range === '30d' ? 'last 30 days' : 'the whole year'})` });
        say(`${name} is ready`);
      }, 1500);
      return;
    }
    setStep(step + 1);
  };
  return <FlowDialog id="export-audit" steps={EXPORT_STEPS} step={step} done={file !== null} onClose={onClose}
    title={file ? 'Export ready' : 'Export the audit log'} description={file ? undefined : 'Exports are recorded in the audit log too.'}
    footer={file ? done(onClose) : step === 2 ? <Button variant="primary" loading disabled>Preparing</Button> : <StepButtons step={step} onBack={() => { setError(null); setStep(step - 1); }} onCancel={onClose} next={next} nextLabel={step === 1 ? `Export ${plural(rows.length, 'entry', 'entries')}` : 'Next'} />}>
    {file ? <>
      <FlowSuccess title={`${plural(rows.length, 'entry', 'entries')} · ${file.name}`}>The download link works for 24 hours, only for you. Removed people keep their names in it; bots carry their sponsor.</FlowSuccess>
      <a href={file.url} download={file.name} data-download="" className="inline-flex w-fit items-center gap-2 rounded-xl bg-foreground px-3 py-2 text-body font-medium text-background hover:opacity-90"><Download01 width={16} height={16} />Download {file.name} · {Math.max(1, Math.round(file.size / 1024))} KB</a>
    </> : null}
    {!file && step === 0 ? <ChoiceCards label="Format" columns={2} value={format} onChange={setFormat} choices={[
      { id: 'csv', title: 'CSV', detail: 'One row per entry; opens in a spreadsheet.' },
      { id: 'json', title: 'JSON', detail: 'An array of objects, for scripts and SIEM imports.' },
    ]} /> : null}
    {!file && step === 1 ? <>
      <ChoiceCards label="Range" value={range} onChange={(next) => { setRange(next); setError(null); }} choices={[
        { id: 'filtered', title: 'What the page shows', detail: `${plural(filtered.length, 'entry', 'entries')} · ${filters}` },
        { id: '30d', title: 'Last 30 days', detail: `${plural(all.length, 'entry', 'entries')}, every person and bot` },
        { id: 'year', title: 'The whole year', detail: `${plural(all.length, 'entry', 'entries')}; the log keeps a year` },
      ]} />
      <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Also include</span>
        <ChipPicker label="Columns" options={EXTRA_COLUMNS} picked={columns} onChange={setColumns} />
        <Hint>Time, who, kind and what are always included.</Hint></div>
      {error ? <FlowError>{error}</FlowError> : null}
    </> : null}
    {!file && step === 2 ? <div role="status" className="flex items-center gap-2 text-body text-foreground"><ThinkingIndicator />Preparing {plural(rows.length, 'entry', 'entries')} as {format.toUpperCase()}…</div> : null}
  </FlowDialog>;
}
