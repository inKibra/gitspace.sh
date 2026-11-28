// The You pages' dialogs and wizards: profile and leaving the team, commit author, GitHub account, SSH key and
// signing, passkeys and devices, MCP clients (connect, edit slice, revoke), the values projects ask you for, and a
// confirmation for revoking someone else's things. Each walks to a success state that writes the stores in
// ./you-data.ts. Steps that wait on something outside this browser (GitHub, the browser's passkey prompt, an MCP
// client, a machine) show a dashed "Mock" row whose buttons pick what happens next, so every outcome can be drawn.
import { Badge, Button, InputCopy, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger, Switch, ThinkingIndicator } from '@gitspace/ui';
import { Laptop01, Phone01, Terminal, UsbFlashDrive } from '@untitledui/icons';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState, type ReactNode } from 'react';
import { bots, PROJECTS, TEAM, userOf, visibleProjects, WORKSPACES } from '../data.js';
import { ACCOUNT_NAME, CAPABILITIES, MACHINES, PERSONAL_VALUES, projectName, recordAudit, revoked, type Capability, type McpGrant } from '../settings/data.js';
import { usePasskey } from '../settings/passkey.js';
import { useHeld } from '../settings/parts.js';
import { projectRoleOf, why } from '../settings/roles.js';
import { useMock } from '../viewer.js';
import { ChipPicker, ChoiceCards, FlowDialog, FlowError, FlowSuccess, Hint, PasskeyStep, StepButtons, Summary, TextArea } from './kit.js';
import {
  addedDevices, addedMachines, authors, AVATAR_COLORS, CAPABILITY_ACTION, deviceNames, EXPIRIES, fakeCode, fakeFingerprint, GITHUB_IDENTITIES, githubLinks, MCP_CLIENTS, mcpGrants,
  ownKeys, profiles, publicKeyOf, signing, sshKeys, VALUE_KINDS, valueStates, type Device,
} from './you-data.js';

// ── Shared pieces ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The mock's stand-in for something outside the browser: a dashed row whose buttons pick what happens next. */
export function MockOutcome({ what, outcomes, onPick }: { what: string; outcomes: ReadonlyArray<{ id: string; label: string }>; onPick(id: string): void }) {
  return <div data-mock-outcome="" className="flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-caption text-muted-foreground">
    <Badge size="compact" color="gray">Mock</Badge><span>{what}</span>
    {outcomes.map((outcome) => <Button key={outcome.id} size="compact" variant="ghost" data-outcome={outcome.id} onClick={() => onPick(outcome.id)}>{outcome.label}</Button>)}
  </div>;
}

/** "Waiting for …" with the thinking dots. */
export function Waiting({ children }: { children: ReactNode }) {
  return <div aria-live="polite" className="flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator className="px-0 py-0" />{children}</div>;
}

/** Counts down from `seconds` while `key` is set (a new key restarts it); "14:59". */
export function useCountdown(seconds: number, key: string | null): string {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    if (!key) return;
    const timer = window.setInterval(() => setLeft((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [key, seconds]);
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** "MO" from "Maya Okafor". */
export function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
}

/** A person's avatar as their profile has it now (name and colour from the profile store). */
export function ProfileAvatar({ userId, size = 28 }: { userId: string; size?: number }) {
  const profile = profiles.use()[userId];
  return <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white" style={{ width: size, height: size, fontSize: size * 0.42, background: profile?.color ?? '#888' }}>{initialsOf(profile?.name ?? '')}</span>;
}

/** The person's passkeys now: the seed's and any added here, renamed here, without removed ones. */
export function useDevices(userId: string, seed: readonly Device[]): readonly Device[] {
  const gone = revoked.use();
  const added = addedDevices.use()[userId] ?? [];
  const names = deviceNames.use();
  return [...seed, ...added].filter((device) => !gone.has(device.id)).map((device) => ({ ...device, label: names[device.id] ?? device.label }));
}

/** The person's own machines (seed and added here) that aren't revoked. */
function personalMachines(userId: string, gone: ReadonlySet<string>): ReadonlyArray<{ id: string; label: string; kind: string }> {
  return [...MACHINES, ...addedMachines.get()].filter((machine) => !gone.has(machine.id) && machine.owner.scope === 'user' && machine.owner.userId === userId);
}

/** Copies `text` to the clipboard and says so (or says the browser refused). */
export function copyText(text: string, what: string, say: (message: string) => void): void {
  navigator.clipboard.writeText(text).then(() => say(`${what} copied`), () => say(`The browser blocked the clipboard: select the ${what.toLowerCase()} and copy it`));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Confirmations ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A confirmation that ends in a success state: what happens, an optional passkey step, then done. With `refusal`, the
 * action can't go ahead: the reason shows as an error and only Close (and `refusalAction`) remain.
 */
export function ConfirmFlow({ id, title, description, children, confirmLabel, passkey, refusal, refusalAction, onConfirm, success, onClose }: {
  id: string; title: string; description?: ReactNode; children?: ReactNode; confirmLabel: string;
  passkey?: { userId: string; what: string }; refusal?: string | null; refusalAction?: ReactNode;
  onConfirm(): void; success: { title: string; body?: ReactNode }; onClose(): void;
}) {
  const [done, setDone] = useState(false);
  const check = usePasskey();
  const go = (): void => {
    const finish = (): void => { onConfirm(); setDone(true); };
    if (passkey) check.confirm(finish); else finish();
  };
  return <FlowDialog id={id} title={title} description={done ? undefined : description} done={done} wide={false} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button>
      : refusal ? <><Button variant="secondary" onClick={onClose}>Close</Button>{refusalAction}</>
      : <><Button variant="secondary" onClick={onClose} disabled={check.waiting}>Cancel</Button><Button variant="primary" onClick={go} loading={check.waiting} disabled={check.waiting}>{confirmLabel}</Button></>}>
    {done ? <FlowSuccess title={success.title}>{success.body}</FlowSuccess> : <>
      {children}
      {refusal ? <FlowError>{refusal}</FlowError> : null}
      {passkey && !refusal ? <PasskeyStep userId={passkey.userId} what={passkey.what} waiting={check.waiting} /> : null}
    </>}
  </FlowDialog>;
}

// ── Profile ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function ProfileEditFlow({ userId, onClose }: { userId: string; onClose(): void }) {
  const { say } = useMock();
  const current = profiles.use()[userId] ?? { name: userOf(userId).name, color: userOf(userId).color };
  const [name, setName] = useState(current.name);
  const [color, setColor] = useState(current.color);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const trimmed = name.trim();
  const error = !trimmed ? 'Enter your name' : trimmed.length < 2 ? 'At least 2 characters' : trimmed.length > 60 ? 'At most 60 characters' : null;
  const save = (): void => {
    setTried(true);
    if (error) return;
    profiles.set({ ...profiles.get(), [userId]: { name: trimmed, color } });
    setDone(true);
    say('Profile saved');
  };
  return <FlowDialog id="profile-edit" title="Edit profile" description={done ? undefined : `How you show in ${ACCOUNT_NAME}: People, holders, Chatter and the audit log.`} done={done} wide={false} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
    {done ? <FlowSuccess title="Profile saved"><span className="inline-flex items-center gap-2"><ProfileAvatar userId={userId} size={22} />{trimmed} · teammates see it now; history keeps the name each entry was made under.</span></FlowSuccess> : <>
      <InputGroup className="w-full"><InputField index={0} label="Name" value={name} onChange={setName} error={tried && error ? error : undefined} autoComplete="name" /></InputGroup>
      <div className="flex flex-col gap-2">
        <span className="text-caption font-medium text-foreground">Avatar</span>
        <div className="flex items-center gap-3">
          <span aria-hidden className="inline-flex size-12 shrink-0 items-center justify-center rounded-full text-[18px] font-semibold text-white" style={{ background: color }}>{initialsOf(name)}</span>
          <div role="radiogroup" aria-label="Avatar colour" className="flex flex-wrap gap-1.5">
            {AVATAR_COLORS.map((swatch) => <button key={swatch} type="button" role="radio" aria-checked={swatch === color} aria-label={swatch} onClick={() => setColor(swatch)}
              className={`size-7 rounded-full ${swatch === color ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : ''}`} style={{ background: swatch }} />)}
          </div>
        </div>
        <Hint>Your initials on a colour; the initials follow your name.</Hint>
      </div>
    </>}
  </FlowDialog>;
}

export function LeaveTeamFlow({ userId, onClose }: { userId: string; onClose(): void }) {
  const person = userOf(userId);
  const held = useHeld()(userId);
  const gone = revoked.use();
  const sponsored = bots.use().filter((bot) => bot.sponsor === userId);
  const grants = mcpGrants.use().filter((grant) => grant.userId === userId && !gone.has(grant.id));
  const machines = personalMachines(userId, gone);
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState('');
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const check = usePasskey();
  const mismatch = typed.trim() !== ACCOUNT_NAME;
  const leave = (): void => {
    setTried(true);
    if (mismatch) return;
    check.confirm(() => { recordAudit({ actor: userId, kind: 'team', text: `Left ${ACCOUNT_NAME}` }); setDone(true); });
  };
  return <FlowDialog id="leave-team" title={`Leave ${ACCOUNT_NAME}`} steps={['What goes', 'Confirm']} step={step} done={done} onClose={onClose}
    description={done ? undefined : 'Your user here is deleted. Your account in any other team is untouched.'}
    footer={done ? <Button variant="primary" onClick={onClose}>Close</Button> : step === 0
      ? <StepButtons step={0} onBack={() => undefined} onCancel={onClose} next={() => setStep(1)} nextLabel="Continue" />
      : <StepButtons step={1} onBack={() => setStep(0)} onCancel={onClose} next={leave} nextLabel={`Leave ${ACCOUNT_NAME}`} busy={check.waiting} />}>
    {done ? <FlowSuccess title={`You left ${ACCOUNT_NAME}`}>This browser is signed out of {TEAM.host}. An Owner can invite you again; you’d start with no projects.</FlowSuccess>
      : step === 0 ? <Summary rows={[
        ['Passkeys', 'Deleted from this team; they can’t sign in here again'],
        ['MCP clients', grants.length ? `${grants.map((grant) => grant.client).join(', ')}: revoked` : 'None'],
        ['Your machines', machines.length ? `${machines.map((machine) => machine.label).join(', ')}: unpaired` : 'None'],
        ['Handles', held.length ? `${held.join(', ')}: released; processes you started keep running, detached` : 'You hold none'],
        ['Bots you sponsor', sponsored.length ? `${sponsored.map((bot) => bot.name).join(', ')}: sign-ins blocked until an Admin takes them over` : 'None'],
        ['History', 'Keeps your name on what you did'],
      ]} />
      : <>
        <InputGroup className="w-full"><InputField index={0} label={`Type ${ACCOUNT_NAME} to confirm`} value={typed} onChange={setTyped} placeholder={ACCOUNT_NAME} error={tried && mismatch ? `Type ${ACCOUNT_NAME} exactly, as shown` : undefined} /></InputGroup>
        <PasskeyStep userId={userId} what={`leaving ${ACCOUNT_NAME}`} waiting={check.waiting} />
        <Hint>{person.first}, this can’t be undone; your projects’ Leads are told.</Hint>
      </>}
  </FlowDialog>;
}

// ── Git identity ───────────────────────────────────────────────────────────────────────────────────────────────────

export function AuthorFlow({ userId, onClose }: { userId: string; onClose(): void }) {
  const { say } = useMock();
  const current = authors.use()[userId] ?? { name: userOf(userId).name, email: userOf(userId).email };
  const link = githubLinks.use()[userId] ?? null;
  const [name, setName] = useState(current.name);
  const [email, setEmail] = useState(current.email);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const nameError = name.trim() ? null : 'Enter the name commits carry';
  const emailError = !email.trim() ? 'Enter the email commits carry' : EMAIL.test(email.trim()) ? null : 'That isn’t an email address (name@example.com)';
  const identity = link ? (GITHUB_IDENTITIES[userId] ?? []).find((entry) => entry.login === link.login) : undefined;
  const verified = identity?.emails.find((entry) => entry.address === email.trim())?.verified ?? false;
  const save = (): void => {
    setTried(true);
    if (nameError || emailError) return;
    authors.set({ ...authors.get(), [userId]: { name: name.trim(), email: email.trim() } });
    setDone(true);
    say('Commit author saved');
  };
  return <FlowDialog id="commit-author" title="Commit author" description={done ? undefined : 'Commits from turns you start carry this author on every machine. GitSpace is the committer.'} done={done} wide={false} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
    {done ? <FlowSuccess title="Commit author saved"><span className="font-mono">{name.trim()} &lt;{email.trim()}&gt;</span> from your next turn on; earlier commits keep their author.</FlowSuccess> : <>
      <InputGroup className="w-full">
        <InputField index={0} label="Name" value={name} onChange={setName} error={tried && nameError ? nameError : undefined} />
        <InputField index={1} label="Email" type="email" value={email} onChange={setEmail} error={tried && emailError ? emailError : undefined} />
      </InputGroup>
      {link && !emailError && !verified ? <Hint>Not a verified email on @{link.login}: GitHub won’t link these commits to you. Verify it at github.com/settings/emails, or use {identity?.emails.find((entry) => entry.primary)?.address}.</Hint>
        : link && !emailError ? <Hint>Verified on @{link.login}: GitHub links these commits to you.</Hint> : null}
    </>}
  </FlowDialog>;
}

/** Connect (or reconnect) the person's own GitHub account: authorize on GitHub, pick the account and confirm the
 * commit email, then it's connected. */
export function GitHubConnectFlow({ userId, onClose }: { userId: string; onClose(): void }) {
  const { say } = useMock();
  const existing = githubLinks.use()[userId] ?? null;
  const key = sshKeys.use()[userId] ?? null;
  const identities = GITHUB_IDENTITIES[userId] ?? [];
  const [step, setStep] = useState(0);
  const [method, setMethod] = useState('device');
  const [phase, setPhase] = useState<'start' | 'waiting' | 'cancelled'>('start');
  const [attempt, setAttempt] = useState(1);
  const [login, setLogin] = useState(existing?.login ?? identities[0]?.login ?? '');
  const identity = identities.find((entry) => entry.login === login) ?? identities[0];
  const author = authors.use()[userId]?.email ?? userOf(userId).email;
  const [email, setEmail] = useState(identity?.emails.some((entry) => entry.address === author) ? author : identity?.emails.find((entry) => entry.primary)?.address ?? '');
  const [verifiedNow, setVerifiedNow] = useState<ReadonlySet<string>>(new Set());
  const [emailError, setEmailError] = useState<string | null>(null);
  const [addKey, setAddKey] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const code = fakeCode(`${userId}-github-${attempt}`);
  const countdown = useCountdown(900, phase === 'waiting' ? code : null);
  const verified = (address: string): boolean => verifiedNow.has(address) || (identity?.emails.find((entry) => entry.address === address)?.verified ?? false);
  const pickAccount = (next: string): void => {
    setLogin(next);
    const picked = identities.find((entry) => entry.login === next);
    setEmail(picked?.emails.find((entry) => entry.primary)?.address ?? '');
    setEmailError(null);
  };
  const unverifiedMessage = (address: string): string => `${address} isn’t verified on @${identity?.login}. Verify it at github.com/settings/emails (GitHub sends a link), then press Check again, or pick a verified email.`;
  const connect = (): void => {
    if (!email) { setEmailError('Pick the email your commits carry'); return; }
    if (!verified(email)) { setEmailError(unverifiedMessage(email)); return; }
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      githubLinks.set({ ...githubLinks.get(), [userId]: { login, email, keyAdded: addKey && key !== null } });
      authors.set({ ...authors.get(), [userId]: { name: authors.get()[userId]?.name ?? userOf(userId).name, email } });
      setDone(true);
      say(`Connected GitHub as @${login}`);
    }, 900);
  };
  const machines = personalMachines(userId, revoked.get());
  return <FlowDialog id="github-connect" title={existing ? 'Reconnect GitHub' : 'Connect GitHub'} steps={['Authorize on GitHub', 'Account and email']} step={step} done={done} onClose={onClose}
    description={done ? undefined : 'Your own GitHub account, for gh and git on your own machines. Team machines use the team’s GitHub App and SSH key, never this.'}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button>
      : step === 0 ? <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        {phase === 'waiting' ? null : <Button variant="primary" onClick={() => { setAttempt((value) => value + 1); setPhase('waiting'); }}>{phase === 'cancelled' ? 'Start again' : 'Authorize on GitHub'}</Button>}
      </>
      : <StepButtons step={1} onBack={() => { setStep(0); setPhase('start'); }} onCancel={onClose} next={connect} nextLabel="Connect" busy={busy} />}>
    {done ? <FlowSuccess title={`Connected as @${login}`}>
      gh and git on {machines.length ? machines.map((machine) => machine.label).join(', ') : 'your own machines'} sign in as @{login}. Commits carry {email}{addKey && key ? `; your SSH key ${key.fingerprint.slice(0, 20)}… is on @${login} for pushing and as a signing key` : ''}.
    </FlowSuccess>
      : step === 0 ? <>
        {phase === 'start' ? <ChoiceCards label="How to authorize" value={method} onChange={setMethod} choices={[
          { id: 'device', title: 'Enter a code on GitHub', detail: 'Open github.com/login/device on any device and type the code; good when GitHub is signed in elsewhere' },
          { id: 'redirect', title: 'Open GitHub here', detail: 'GitHub opens in a new tab and sends you back when you approve' },
        ]} /> : null}
        {phase === 'waiting' && method === 'device' ? <>
          <InputCopy label="Open on GitHub" value="https://github.com/login/device" />
          <InputCopy label="Your code" value={code} />
          <div className="flex items-center justify-between gap-3 text-caption"><Badge color="amber">Waiting for GitHub</Badge><span className="tabular-nums text-muted-foreground">Code expires in {countdown}</span></div>
        </> : null}
        {phase === 'waiting' && method === 'redirect' ? <Hint>GitHub opened in a new tab. Approve “GitSpace for {ACCOUNT_NAME}” there; this dialog moves on when you do.</Hint> : null}
        {phase === 'waiting' ? <>
          <Waiting>Waiting for you to approve on GitHub…</Waiting>
          <MockOutcome what="On GitHub, you:" outcomes={[{ id: 'approve', label: 'Approve' }, { id: 'cancel', label: 'Cancel' }]} onPick={(outcome) => { if (outcome === 'approve') { setPhase('start'); setStep(1); } else setPhase('cancelled'); }} />
        </> : null}
        {phase === 'cancelled' ? <FlowError>You cancelled on GitHub, so nothing was connected. Press Start again and choose Authorize on GitHub’s page.</FlowError> : null}
        {phase === 'start' ? <Hint>GitSpace asks for repo, read:user, user:email, admin:public_key and admin:ssh_signing_key.</Hint> : null}
      </>
      : <>
        <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Account</span>
          <ChoiceCards label="GitHub account" value={login} onChange={pickAccount} choices={identities.map((entry, index) => ({ id: entry.login, title: `@${entry.login}`, detail: `${entry.name} · ${entry.emails.length} ${entry.emails.length === 1 ? 'email' : 'emails'}`, badge: index === 0 ? <Badge size="compact" color="gray">Signed in on GitHub</Badge> : undefined }))} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-foreground">Commit email</span>
          <Select value={email} onValueChange={(value) => { setEmail(value); setEmailError(null); }}>
            <SelectTrigger aria-label="Commit email" />
            <SelectContent>{(identity?.emails ?? []).map((entry, index) => <SelectItem key={entry.address} value={entry.address} index={index}>{`${entry.address}${verified(entry.address) ? '' : ' (unverified)'}${entry.primary ? ' · primary' : ''}`}</SelectItem>)}</SelectContent>
          </Select>
          <Hint>Must be a verified email on @{identity?.login}, so GitHub links your commits to you. It becomes your commit author email too.</Hint>
          {emailError ? <div className="flex flex-wrap items-center gap-2"><FlowError>{emailError}</FlowError>
            {email && !verified(email) ? <Button size="compact" variant="secondary" onClick={() => { setVerifiedNow(new Set([...verifiedNow, email])); setEmailError(null); }}>Check again</Button> : null}</div> : null}
        </div>
        {key ? <Switch label={`Add my SSH key (${key.fingerprint.slice(0, 20)}…) to @${identity?.login} for pushing and signing`} checked={addKey} onToggle={() => setAddKey((value) => !value)} />
          : <Hint>You have no SSH key yet; add one below and it goes on @{identity?.login}.</Hint>}
      </>}
  </FlowDialog>;
}

export function GitHubDisconnectFlow({ userId, onClose }: { userId: string; onClose(): void }) {
  const link = githubLinks.use()[userId] ?? null;
  const [login] = useState(link?.login ?? '');
  return <ConfirmFlow id="github-disconnect" title={`Disconnect @${login}`} confirmLabel="Disconnect" onClose={onClose}
    description="gh and git on your own machines stop signing in to GitHub as you."
    onConfirm={() => githubLinks.set({ ...githubLinks.get(), [userId]: null })}
    success={{ title: `Disconnected @${login}`, body: 'GitSpace’s token is revoked. Your SSH key stays on GitHub until you remove it at github.com/settings/keys; team machines are unaffected.' }}>
    <Summary rows={[['Stops', 'gh, the credential helper and pushes over HTTPS on your machines'], ['Keeps working', 'Pushes over SSH with your key (it stays on GitHub), the team’s GitHub App everywhere'], ['Commit email', `${link?.email ?? ''}, unchanged`]]} />
  </ConfirmFlow>;
}

/** Add or replace the person's SSH key: generate one or paste a public key, name it, see the old one retired and which
 * machines get the new one, confirm with a passkey. */
export function SshKeyFlow({ userId, onClose }: { userId: string; onClose(): void }) {
  const { say } = useMock();
  const old = sshKeys.use()[userId] ?? null;
  const link = githubLinks.use()[userId] ?? null;
  const own = ownKeys.use()[userId] ?? false;
  const gone = revoked.use();
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<'generated' | 'pasted'>('generated');
  const [name, setName] = useState(`${userId}-gitspace-${old ? '2' : '1'}`);
  const [pasted, setPasted] = useState('');
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const check = usePasskey();
  const generated = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${fakeFingerprint(`${userId}-${name}`).slice(7, 47)} ${name}`;
  const text = source === 'generated' ? generated : pasted.trim();
  const algorithm = text.startsWith('ssh-rsa') ? 'rsa' : text.startsWith('ecdsa') ? 'ecdsa' : 'ed25519';
  const fingerprint = fakeFingerprint(text);
  const nameError = !name.trim() ? 'Name the key so you can tell it apart where you add it' : /^[A-Za-z0-9._@-]+$/.test(name.trim()) ? null : 'Letters, digits, dots, dashes, underscores and @ only';
  const keyError = source === 'generated' ? null
    : !pasted.trim() ? 'Paste the public key: the contents of the .pub file'
    : /PRIVATE KEY/.test(pasted) ? 'That’s a private key; paste the .pub. It’s the file next to it ending in .pub (e.g. ~/.ssh/id_ed25519.pub); never share the private one.'
    : /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]{20,}={0,3}( \S.*)?$/.test(pasted.trim()) ? null
    : 'A public key starts with ssh-ed25519, ssh-rsa or ecdsa-sha2-nistp256, then a space and the key itself.';
  const machines = personalMachines(userId, gone);
  const gets = machines.filter((machine) => !(own && machine.kind === 'computer'));
  const keeps = machines.filter((machine) => own && machine.kind === 'computer');
  const next = (): void => {
    if (step === 0) { setStep(1); return; }
    if (step === 1) { setTried(true); if (!nameError && !keyError) setStep(2); return; }
    check.confirm(() => {
      sshKeys.set({ ...sshKeys.get(), [userId]: { name: name.trim(), fingerprint, algorithm, created: 'Just now', source } });
      recordAudit({ actor: userId, kind: 'resource', text: old ? `Replaced their SSH key (${old.fingerprint.slice(0, 16)}… → ${fingerprint.slice(0, 16)}…)` : `Added an SSH key (${fingerprint.slice(0, 16)}…)` });
      setDone(true);
      say(old ? 'SSH key replaced' : 'SSH key added');
    });
  };
  return <FlowDialog id="ssh-key" title={old ? 'Replace SSH key' : 'Add SSH key'} steps={['Source', 'Key', 'Confirm']} step={step} done={done} onClose={onClose}
    description={done ? undefined : 'For origins the team’s GitHub App doesn’t cover, on your own machines only. Team machines never get it.'}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => setStep(step - 1)} onCancel={onClose} next={next} nextLabel={step === 2 ? 'Confirm with passkey' : 'Continue'} busy={check.waiting} />}>
    {done ? <>
      <FlowSuccess title={`${old ? 'Replaced' : 'Added'}: ${name.trim()}`}><span className="font-mono">{fingerprint}</span>{gets.length ? ` · on ${gets.map((machine) => machine.label).join(', ')} now` : ''}{link ? ` · added to @${link.login}` : ''}. Add it wherever the old one was (GitLab, Bitbucket, servers).</FlowSuccess>
      <InputCopy label="Public key" value={text} />
    </>
      : step === 0 ? <ChoiceCards label="Key source" value={source} onChange={(id) => setSource(id === 'pasted' ? 'pasted' : 'generated')} choices={[
        { id: 'generated', title: 'Generate on this machine', detail: 'This browser makes an ed25519 key; its private half is encrypted to your machines and never shown' },
        { id: 'pasted', title: 'Paste a public key', detail: 'You keep the private key; your machines use it through your SSH agent while you’re connected' },
      ]} />
      : step === 1 ? <>
        <InputGroup className="w-full"><InputField index={0} label="Name" value={name} onChange={setName} error={tried && nameError ? nameError : undefined} /></InputGroup>
        {source === 'generated' ? <><InputCopy label="New public key" value={generated} /><Hint>Fingerprint <span className="font-mono">{fingerprint}</span></Hint></>
          : <TextArea label="Public key (.pub)" value={pasted} onChange={setPasted} mono rows={4} placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… you@laptop" error={tried && keyError ? keyError : undefined} />}
      </>
      : <>
        <Summary rows={[
          ['New key', <span key="new" className="font-mono text-caption">{name.trim()} · {algorithm} · {fingerprint}</span>],
          ['Retired', old ? <span key="old" className="font-mono text-caption text-muted-foreground line-through">{old.name} · {old.fingerprint}</span> : 'Nothing: this is your first key'],
          ['Gets the new key', gets.length ? gets.map((machine) => machine.label).join(', ') : 'None of your machines yet'],
          ...(keeps.length ? [['Keeps its own keys', `${keeps.map((machine) => machine.label).join(', ')} (Use this computer’s own keys is on)`] as const] : []),
          ['GitHub', link ? `Added to @${link.login}${old ? '; the old key is removed there' : ''}` : 'Not connected: add it to GitHub yourself, or connect GitHub'],
        ]} />
        {old ? <Hint>The old key stops working on your machines right away. Elsewhere (GitLab, Bitbucket, servers) it works until you remove it there.</Hint> : null}
        <PasskeyStep userId={userId} what={old ? 'replacing your SSH key' : 'adding your SSH key'} waiting={check.waiting} />
      </>}
  </FlowDialog>;
}

export function SigningFlow({ userId, onClose }: { userId: string; onClose(): void }) {
  const key = sshKeys.use()[userId] ?? null;
  const link = githubLinks.use()[userId] ?? null;
  const [choice, setChoice] = useState(signing.use()[userId] ?? 'ssh');
  const [done, setDone] = useState(false);
  const refusal = choice === 'ssh' && !key ? 'You have no SSH key to sign with: add one first (Add SSH key).' : null;
  return <FlowDialog id="signing" title="Commit signing" description={done ? undefined : 'How commits from turns you start are signed, on every machine.'} done={done} wide={false} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={refusal !== null} onClick={() => { signing.set({ ...signing.get(), [userId]: choice === 'off' ? 'off' : 'ssh' }); setDone(true); }}>Save</Button></>}>
    {done ? <FlowSuccess title={choice === 'off' ? 'Commits aren’t signed' : 'Commits are signed with your SSH key'}>{choice === 'off' ? 'GitHub shows them without Verified.' : link ? `GitHub shows Verified: the key is on @${link.login} as a signing key.` : 'GitHub shows Verified once the key is on your GitHub account as a signing key.'}</FlowSuccess> : <>
      <ChoiceCards label="Signing" value={choice} onChange={(id) => setChoice(id === 'off' ? 'off' : 'ssh')} choices={[
        { id: 'ssh', title: 'Sign with my SSH key', detail: key ? <span className="font-mono">{key.name} · {key.fingerprint.slice(0, 28)}…</span> : 'No SSH key yet' },
        { id: 'off', title: 'Don’t sign', detail: 'GitSpace still commits as you; GitHub shows no Verified badge' },
      ]} />
      {refusal ? <FlowError>{refusal}</FlowError> : null}
      {choice === 'ssh' && key && !link ? <Hint>GitHub isn’t connected: add the key to your GitHub account as a signing key yourself, or connect GitHub, for commits to show Verified.</Hint> : null}
    </>}
  </FlowDialog>;
}

// ── Passkeys and devices ───────────────────────────────────────────────────────────────────────────────────────────

export function PasskeyAddFlow({ userId, devices, onClose }: { userId: string; devices: readonly Device[]; onClose(): void }) {
  const { say } = useMock();
  const here = devices.find((device) => device.current);
  const [step, setStep] = useState(0);
  const [method, setMethod] = useState('key');
  const defaultName = (id: string): string => id === 'device' ? `${here?.label ?? 'This computer'} (Chrome)` : id === 'key' ? 'Security key' : 'Phone';
  const [name, setName] = useState(defaultName('key'));
  const [tried, setTried] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'prompt' | 'cancelled' | 'duplicate'>('idle');
  const [done, setDone] = useState(false);
  const check = usePasskey();
  const trimmed = name.trim();
  const nameError = !trimmed ? 'Name it so you can tell your passkeys apart' : trimmed.length > 40 ? 'At most 40 characters' : devices.some((device) => device.label.toLowerCase() === trimmed.toLowerCase()) ? `You already have a passkey named ${trimmed}` : null;
  const kind = method === 'device' ? 'Touch ID passkey' : method === 'key' ? 'Security key' : 'Phone passkey (hybrid)';
  const add = (): void => {
    const device: Device = { id: `dev-${userId}-new-${(addedDevices.get()[userId] ?? []).length + 1}`, label: trimmed, kind, added: 'Just now', lastUsed: 'just now' };
    addedDevices.set({ ...addedDevices.get(), [userId]: [...(addedDevices.get()[userId] ?? []), device] });
    recordAudit({ actor: userId, kind: 'team', text: `Added a passkey (${trimmed})` });
    setPhase('idle');
    setDone(true);
    say(`Passkey added: ${trimmed}`);
  };
  const next = (): void => {
    if (step === 0) { setName(defaultName(method)); setStep(1); return; }
    if (step === 1) { setTried(true); if (!nameError) setStep(2); return; }
    check.confirm(() => setPhase('prompt'));
  };
  return <FlowDialog id="passkey-add" title="Add a passkey" steps={['Where', 'Name', 'Create']} step={step} done={done} onClose={onClose}
    description={done ? undefined : `Another way to sign in to ${ACCOUNT_NAME}. Yours alone; nobody else can add or use it.`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button>
      : step === 2 && phase === 'prompt' ? <Button variant="secondary" onClick={() => setPhase('cancelled')}>Cancel</Button>
      : <StepButtons step={step} onBack={() => { setPhase('idle'); setStep(step - 1); }} onCancel={onClose} next={next} nextLabel={step < 2 ? 'Continue' : phase === 'idle' ? 'Create passkey' : 'Try again'} busy={check.waiting} />}>
    {done ? <FlowSuccess title={`Passkey added: ${trimmed}`}>{kind} · signs you in to {TEAM.host} from now on. It’s in the audit log.</FlowSuccess>
      : step === 0 ? <ChoiceCards label="Where the passkey lives" value={method} onChange={setMethod} choices={[
        { id: 'device', title: 'This device', detail: `Touch ID on ${here?.label ?? 'this computer'}`, icon: Laptop01, disabled: here?.kind.includes('Touch ID') ? `${here.label} already has a passkey for you; add another device or a security key` : null },
        { id: 'key', title: 'Security key', detail: 'A USB or NFC key, like a YubiKey: good as a recovery key kept somewhere safe', icon: UsbFlashDrive },
        { id: 'phone', title: 'Phone or tablet', detail: 'Scan a QR code with its camera; the passkey lives on the phone', icon: Phone01 },
      ]} />
      : step === 1 ? <InputGroup className="w-full"><InputField index={0} label="Name" value={name} onChange={setName} error={tried && nameError ? nameError : undefined} /></InputGroup>
      : <>
        {phase === 'idle' || check.waiting ? <PasskeyStep userId={userId} what="adding a passkey" waiting={check.waiting} /> : null}
        {phase === 'prompt' && method === 'phone' ? <figure className="flex flex-col items-center gap-2">
          <QRCodeSVG value={`FIDO:/${fakeCode(`${userId}-${trimmed}`).replace('-', '')}0473921058812736401`} size={176} level="M" marginSize={3} title="Scan with your phone to create a passkey" className="rounded-lg bg-white" />
          <figcaption className="text-center text-caption text-muted-foreground">Scan with your phone’s camera, then follow the prompt on the phone. Bluetooth must be on for both.</figcaption>
        </figure> : null}
        {phase === 'prompt' ? <>
          <Waiting>{method === 'phone' ? 'Waiting for your phone…' : method === 'key' ? 'Insert your security key and touch it…' : 'Touch the sensor when your browser asks…'}</Waiting>
          <MockOutcome what="The browser’s prompt:" outcomes={[{ id: 'ok', label: 'Created' }, { id: 'cancel', label: 'Cancelled' }, ...(method === 'key' ? [{ id: 'dup', label: 'Key already registered' }] : [])]}
            onPick={(outcome) => { if (outcome === 'ok') add(); else setPhase(outcome === 'dup' ? 'duplicate' : 'cancelled'); }} />
        </> : null}
        {phase === 'cancelled' ? <FlowError>The passkey prompt was cancelled or timed out, so nothing was added. Press Try again and follow your browser’s prompt.</FlowError> : null}
        {phase === 'duplicate' ? <FlowError>This security key already holds a passkey for you{devices.find((device) => device.kind.startsWith('Security key')) ? ` (${devices.find((device) => device.kind.startsWith('Security key'))?.label})` : ''}. Use a different key, or rename that one instead.</FlowError> : null}
      </>}
  </FlowDialog>;
}

export function DeviceRenameFlow({ userId, device, devices, onClose }: { userId: string; device: Device; devices: readonly Device[]; onClose(): void }) {
  const [name, setName] = useState(device.label);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const trimmed = name.trim();
  const error = !trimmed ? 'Enter a name' : trimmed.length > 40 ? 'At most 40 characters' : devices.some((other) => other.id !== device.id && other.label.toLowerCase() === trimmed.toLowerCase()) ? `You already have a passkey named ${trimmed}` : null;
  return <FlowDialog id="device-rename" title={`Rename ${device.label}`} done={done} wide={false} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => { setTried(true); if (error) return; deviceNames.set({ ...deviceNames.get(), [device.id]: trimmed }); recordAudit({ actor: userId, kind: 'team', text: `Renamed a passkey (${device.label} → ${trimmed})` }); setDone(true); }}>Save</Button></>}>
    {done ? <FlowSuccess title={`Renamed to ${trimmed}`}>{device.kind} · the passkey itself is unchanged.</FlowSuccess>
      : <InputGroup className="w-full"><InputField index={0} label="Name" value={name} onChange={setName} error={tried && error ? error : undefined} /></InputGroup>}
  </FlowDialog>;
}

export function DeviceRemoveFlow({ userId, device, devices, onClose, onAdd }: { userId: string; device: Device; devices: readonly Device[]; onClose(): void; onAdd(): void }) {
  const { say } = useMock();
  const last = devices.length <= 1;
  const others = devices.filter((other) => other.id !== device.id).map((other) => other.label);
  return <ConfirmFlow id="device-remove" title={`Remove ${device.label}`} onClose={onClose}
    description={`${device.kind} · added ${device.added} · last used ${device.lastUsed}`}
    confirmLabel={device.current ? 'Sign out and remove' : 'Remove passkey'}
    passkey={last ? undefined : { userId, what: `removing ${device.label}` }}
    refusal={last ? `It’s your only passkey: without it you couldn’t sign in to ${ACCOUNT_NAME}. Add another passkey first, then remove this one.` : null}
    refusalAction={<Button variant="primary" onClick={onAdd}>Add a passkey</Button>}
    onConfirm={() => { revoked.set(new Set([...revoked.get(), device.id])); recordAudit({ actor: userId, kind: 'team', text: `Removed a passkey (${device.label})` }); say(`Removed ${device.label}`); }}
    success={{ title: `Removed ${device.label}`, body: device.current ? `This browser is signed out. Sign in again with ${others.join(' or ')}.` : `It can’t sign in to ${ACCOUNT_NAME} any more. You still have ${others.join(', ')}.` }}>
    {device.current && !last ? <Hint>You’re using this one. Removing it signs this browser out; sign in again with {others.join(' or ')}.</Hint> : null}
    {!device.current && !last ? <Hint>It can’t sign in to {ACCOUNT_NAME} any more. Your other passkeys: {others.join(', ')}.</Hint> : null}
  </ConfirmFlow>;
}

/** An Owner or Admin revoking something of someone else's (or the person their own, from a page whose action is a
 * revoke): what stops, then done. `onConfirm` does the revoke (and its audit entry and notice). */
export function RevokeFlow({ id, title, body, confirmLabel, onConfirm, success, onClose }: { id: string; title: string; body: ReactNode; confirmLabel: string; onConfirm(): void; success: string; onClose(): void }) {
  return <ConfirmFlow id={id} title={title} confirmLabel={confirmLabel} onConfirm={onConfirm} success={{ title: success }} onClose={onClose}><Hint>{body}</Hint></ConfirmFlow>;
}

// ── MCP clients ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why `userId` can't grant `capability` in any of `projects`, or null if some project's role allows it. */
function capabilityRefusal(userId: string, projects: ReadonlySet<string>, capability: Capability): string | null {
  const action = CAPABILITY_ACTION[capability];
  if (!action || projects.size === 0) return null;
  const reasons = [...projects].map((projectId) => why(userId, projectId, action));
  return reasons.every((reason) => reason !== null) ? reasons.join('; ') : null;
}

/** Projects (yours, with your role there), capabilities (within your roles) and expiry. */
function SlicePicker({ userId, projects, setProjects, capabilities, setCapabilities, expiry, setExpiry, tried }: {
  userId: string; projects: ReadonlySet<string>; setProjects(next: ReadonlySet<string>): void; capabilities: ReadonlySet<string>; setCapabilities(next: ReadonlySet<string>): void;
  expiry: string; setExpiry(next: string): void; tried: boolean;
}) {
  const mine = PROJECTS.filter((project) => !project.archived && visibleProjects(userId).has(project.id));
  const refused = CAPABILITIES.map((capability) => [capability, capabilityRefusal(userId, projects, capability)] as const).filter(([, reason]) => reason !== null);
  return <>
    <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Projects</span>
      <ChipPicker label="Projects" picked={projects} onChange={(next) => { setProjects(next); setCapabilities(new Set(CAPABILITIES.filter((entry) => capabilities.has(entry) && capabilityRefusal(userId, next, entry) === null))); }}
        options={mine.map((project) => ({ id: project.id, label: `${project.name} · ${projectRoleOf(userId, project.id)?.name ?? ''}` }))} />
      <Hint>Only projects you’re in. In each, the client acts with your project role there.</Hint>
      {tried && projects.size === 0 ? <FlowError>Pick at least one project.</FlowError> : null}
    </div>
    <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Capabilities</span>
      <ChipPicker label="Capabilities" picked={capabilities} onChange={setCapabilities} options={CAPABILITIES.map((capability) => ({ id: capability, label: capability, disabled: capabilityRefusal(userId, projects, capability) }))} />
      {refused.length ? <div className="flex flex-col gap-0.5">{refused.map(([capability, reason]) => <Hint key={capability}><span className="font-medium text-foreground">{capability}</span>: {reason}</Hint>)}</div> : <Hint>Each applies only where your project role allows it.</Hint>}
      {tried && capabilities.size === 0 ? <FlowError>Pick at least one capability; read is the least.</FlowError> : null}
    </div>
    <div className="flex flex-col gap-1.5"><span className="text-caption font-medium text-foreground">Expires</span>
      <Select value={expiry} onValueChange={setExpiry}><SelectTrigger aria-label="Expires" /><SelectContent>{EXPIRIES.map((entry, index) => <SelectItem key={entry} value={entry} index={index}>{`In ${entry}`}</SelectItem>)}</SelectContent></Select>
    </div>
  </>;
}

const ENDPOINT = `https://${TEAM.host}/mcp`;
const REDIRECT = /^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/\S*)?$/;

/** Connect an MCP client: pick it, pick its slice, paste the code into it, approve with a passkey. */
export function McpConnectFlow({ userId, onClose }: { userId: string; onClose(): void }) {
  const { say } = useMock();
  const person = userOf(userId);
  const mine = PROJECTS.filter((project) => !project.archived && visibleProjects(userId).has(project.id));
  const [step, setStep] = useState(0);
  const [client, setClient] = useState('claude-code');
  const [otherName, setOtherName] = useState('');
  const [otherUrl, setOtherUrl] = useState('');
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set(mine.slice(0, 1).map((project) => project.id)));
  const [capabilities, setCapabilities] = useState<ReadonlySet<string>>(new Set(['read', 'comment', 'prompt']));
  const [expiry, setExpiry] = useState('30 days');
  const [tried, setTried] = useState(false);
  const [attempt, setAttempt] = useState(1);
  const [phase, setPhase] = useState<'waiting' | 'expired' | 'used'>('waiting');
  const [done, setDone] = useState(false);
  const check = usePasskey();
  const picked = MCP_CLIENTS.find((entry) => entry.id === client) ?? MCP_CLIENTS[0];
  const name = client === 'other' ? otherName.trim() : picked?.name ?? '';
  const host = client === 'other' ? otherUrl.trim().replace(/^https?:\/\//, '').split(/[/:]/)[0] ?? '' : picked?.host ?? '';
  const nameError = client === 'other' && !otherName.trim() ? 'Name the client as you’ll see it in the audit log' : null;
  const urlError = client !== 'other' ? null : !otherUrl.trim() ? 'Enter the client’s OAuth redirect URL' : REDIRECT.test(otherUrl.trim()) ? null : 'The redirect URL must start with https://, or http://localhost for a client on your computer';
  const code = fakeCode(`${userId}-mcp-${attempt}`);
  const countdown = useCountdown(600, step === 2 && phase === 'waiting' ? code : null);
  const command = client === 'claude-code' ? `claude mcp add --transport http crumbco ${ENDPOINT}` : client === 'codex' ? `codex mcp add crumbco --url ${ENDPOINT}` : ENDPOINT;
  const caps = CAPABILITIES.filter((capability) => capabilities.has(capability));
  const approve = (): void => check.confirm(() => {
    const grant: McpGrant = { id: `g-new-${mcpGrants.get().length + 1}`, userId, client: name, via: 'OAuth', projects: [...projects], capabilities: caps, expires: `in ${expiry}`, lastUsed: 'not yet', host };
    mcpGrants.set([...mcpGrants.get(), grant]);
    recordAudit({ actor: userId, kind: 'resource', text: `Connected MCP client ${name} (${[...projects].map(projectName).join(', ')} · ${caps.join(', ')} · ${expiry})` });
    setDone(true);
    say(`${person.first} via ${name} connected`);
  });
  const next = (): void => {
    if (step === 0) { setTried(true); if (!nameError && !urlError) { setTried(false); setStep(1); } return; }
    if (step === 1) { setTried(true); if (projects.size && capabilities.size) { setTried(false); setPhase('waiting'); setStep(2); } return; }
    if (step === 2) { if (phase === 'expired') { setAttempt((value) => value + 1); setPhase('waiting'); } else if (phase === 'used') setStep(3); return; }
    approve();
  };
  return <FlowDialog id="mcp-connect" title="Connect an MCP client" steps={['Client', 'Slice', 'Connect', 'Approve']} step={step} done={done} onClose={onClose}
    description={done ? undefined : `It acts as you within the slice you pick, prompts only in workspaces whose handle you hold, and its actions read “${person.first} via the client”.`}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button>
      : <StepButtons step={step} onBack={() => setStep(step - 1)} onCancel={onClose} next={next} busy={check.waiting} disabled={step === 2 && phase === 'waiting'}
        nextLabel={step === 3 ? 'Approve with passkey' : step === 2 && phase === 'expired' ? 'New code' : 'Continue'} />}>
    {done ? <FlowSuccess title={`${person.first} via ${name}`}>
      Connected · {[...projects].map((id) => `${projectName(id)} (${projectRoleOf(userId, id)?.name ?? ''})`).join(', ')} · {caps.join(', ')} · expires in {expiry}. Change its slice or revoke it here any time.
    </FlowSuccess>
      : step === 0 ? <>
        <ChoiceCards label="Client" value={client} onChange={setClient} columns={2} choices={MCP_CLIENTS.map((entry) => ({ id: entry.id, title: entry.name, detail: entry.detail, icon: Terminal }))} />
        {client === 'other' ? <InputGroup className="w-full">
          <InputField index={0} label="Client name" value={otherName} onChange={setOtherName} placeholder="Zed" error={tried && nameError ? nameError : undefined} />
          <InputField index={1} label="Redirect URL" value={otherUrl} onChange={setOtherUrl} placeholder="https://zed.dev/mcp/oauth/callback" error={tried && urlError ? urlError : undefined} />
        </InputGroup> : null}
      </>
      : step === 1 ? <SlicePicker userId={userId} projects={projects} setProjects={setProjects} capabilities={capabilities} setCapabilities={setCapabilities} expiry={expiry} setExpiry={setExpiry} tried={tried} />
      : step === 2 ? <>
        {phase !== 'expired' ? <>
          <InputCopy label={client === 'claude-code' || client === 'codex' ? `Run in your terminal` : `Paste in ${name} as the server URL`} value={command} />
          <InputCopy label={`When ${name} asks, enter this code`} value={code} />
          {phase === 'waiting' ? <>
            <div className="flex items-center justify-between gap-3 text-caption"><Badge color="amber">Waiting for {name}</Badge><span className="tabular-nums text-muted-foreground">Code expires in {countdown}</span></div>
            <Waiting>Waiting for {name} to use the code…</Waiting>
            <MockOutcome what={`${name}:`} outcomes={[{ id: 'used', label: 'Uses the code' }, { id: 'expired', label: 'Code expires' }]} onPick={(outcome) => setPhase(outcome === 'used' ? 'used' : 'expired')} />
          </> : <p role="status" className="text-caption text-foreground">{name} used the code from {host}. Continue to approve what it may do.</p>}
        </> : <FlowError>The code expired before {name} used it, so nothing was connected. Press New code and enter it in {name} within 10 minutes.</FlowError>}
      </>
      : <>
        <Summary rows={[
          ['Client', `${name} · ${host}`],
          ['Acts as', `${person.first} via ${name}`],
          ['Projects', [...projects].map((id) => `${projectName(id)} (${projectRoleOf(userId, id)?.name ?? ''})`).join(', ')],
          ['Capabilities', caps.join(', ')],
          ['Expires', `In ${expiry}`],
        ]} />
        <PasskeyStep userId={userId} what={`connecting ${name} as you`} waiting={check.waiting} />
      </>}
  </FlowDialog>;
}

/** Change what a connected client may do. Widening it asks for a passkey; narrowing doesn't. */
export function McpEditFlow({ grant, onClose }: { grant: McpGrant; onClose(): void }) {
  const { say } = useMock();
  const [projects, setProjects] = useState<ReadonlySet<string>>(new Set(grant.projects));
  const [capabilities, setCapabilities] = useState<ReadonlySet<string>>(new Set(grant.capabilities));
  const [expiry, setExpiry] = useState(EXPIRIES.find((entry) => grant.expires === `in ${entry}`) ?? '30 days');
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const check = usePasskey();
  const caps = CAPABILITIES.filter((capability) => capabilities.has(capability));
  const widened = [...projects].some((id) => !grant.projects.includes(id)) || caps.some((capability) => !grant.capabilities.includes(capability));
  const save = (): void => {
    setTried(true);
    if (!projects.size || !capabilities.size) return;
    const finish = (): void => {
      mcpGrants.set(mcpGrants.get().map((entry) => entry.id === grant.id ? { ...entry, projects: [...projects], capabilities: caps, expires: `in ${expiry}` } : entry));
      recordAudit({ actor: grant.userId, kind: 'resource', text: `Changed MCP client ${grant.client}’s slice (${[...projects].map(projectName).join(', ')} · ${caps.join(', ')} · ${expiry})` });
      setDone(true);
      say(`${grant.client}’s slice saved`);
    };
    if (widened) check.confirm(finish); else finish();
  };
  return <FlowDialog id="mcp-edit" title={`What ${grant.client} may do`} description={done ? undefined : `${userOf(grant.userId).first} via ${grant.client} · ${grant.host}`} done={done} onClose={onClose}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose} disabled={check.waiting}>Cancel</Button><Button variant="primary" onClick={save} loading={check.waiting} disabled={check.waiting}>{widened ? 'Save with passkey' : 'Save'}</Button></>}>
    {done ? <FlowSuccess title={`${grant.client}’s slice saved`}>{[...projects].map(projectName).join(', ')} · {caps.join(', ')} · expires in {expiry}. It applies from the client’s next call.</FlowSuccess> : <>
      <SlicePicker userId={grant.userId} projects={projects} setProjects={setProjects} capabilities={capabilities} setCapabilities={setCapabilities} expiry={expiry} setExpiry={setExpiry} tried={tried} />
      {widened ? <PasskeyStep userId={grant.userId} what={`widening what ${grant.client} may do`} waiting={check.waiting} /> : null}
    </>}
  </FlowDialog>;
}

// ── Values projects ask you for ────────────────────────────────────────────────────────────────────────────────────

/** Set or replace a value a project asks you for: pick the request, enter the value (checked against its service),
 * see where it reaches, save. */
export function ValueFlow({ userId, start, onClose }: { userId: string; start: string | null; onClose(): void }) {
  const { say } = useMock();
  const states = valueStates.use();
  const held = useHeld()(userId);
  const requests = PERSONAL_VALUES[userId] ?? [];
  const [step, setStep] = useState(start ? 1 : 0);
  const firstMissing = requests.find((request) => !states[`${userId}:${request.projectId}:${request.name}`]?.set) ?? requests[0];
  const [picked, setPicked] = useState(start ?? (firstMissing ? `${firstMissing.projectId}:${firstMissing.name}` : ''));
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [tried, setTried] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const request = requests.find((entry) => `${entry.projectId}:${entry.name}` === picked);
  const kind = request ? VALUE_KINDS[request.name] : undefined;
  const state = request ? states[`${userId}:${request.projectId}:${request.name}`] : undefined;
  const usernameError = kind?.kind !== 'login' ? null : !username.trim() ? 'Enter your staging username' : null;
  const secretError = !secret ? (kind?.kind === 'login' ? 'Enter your staging password' : `Paste your ${kind?.service ?? ''} token`)
    : kind?.kind === 'login' ? (secret.length < 8 ? 'At least 8 characters: staging rejects shorter passwords' : null)
    : kind?.prefix && !secret.startsWith(kind.prefix) ? `${kind.service} personal access tokens start with ${kind.prefix}; this looks like something else`
    : secret.length < 24 ? `That’s too short for a ${kind?.service ?? ''} token; copy the whole thing` : null;
  const reach = request ? held.filter((id) => WORKSPACES.find((workspace) => workspace.id === id)?.projectId === request.projectId) : [];
  const next = (): void => {
    if (step === 0) { setStep(1); return; }
    if (step === 1) {
      setTried(true);
      if (usernameError || secretError || !request || !kind) return;
      setChecking(true);
      setCheckError(null);
      window.setTimeout(() => {
        setChecking(false);
        if (kind.kind === 'token' && secret.includes('old')) { setCheckError(`${kind.service} says this token was revoked or has expired (401). Make a new one at ${kind.how.split(' · ')[0]} and paste it here.`); return; }
        if (kind.kind === 'login' && secret.includes('wrong')) { setCheckError(`${kind.service} refused this username and password. Sign in at ${kind.service} to check them, then enter them again.`); return; }
        setStep(2);
      }, 900);
      return;
    }
    if (!request) return;
    valueStates.set({ ...valueStates.get(), [`${userId}:${request.projectId}:${request.name}`]: { set: true, updated: 'Just now' } });
    setDone(true);
    say(`${request.name} saved for ${projectName(request.projectId)}`);
  };
  return <FlowDialog id="personal-value" title={request && start ? `${state?.set ? 'Replace' : 'Set'} ${request.name}` : 'Add a value a project asks for'} steps={['Request', 'Value', 'Where it reaches']} step={step} done={done} onClose={onClose}
    description={done ? undefined : 'Write-only: nobody sees it again, you included. It reaches a workspace only while you hold its handle, for turns you start.'}
    footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <StepButtons step={step} onBack={() => { setCheckError(null); setStep(step - 1); }} onCancel={onClose} next={next} busy={checking} nextLabel={step === 1 ? `Check with ${kind?.service ?? 'the service'}` : step === 2 ? 'Save value' : 'Continue'} />}>
    {done && request ? <FlowSuccess title={`${request.name} ${state?.set ? 'saved' : 'set'} for ${projectName(request.projectId)}`}>{reach.length ? `Reaches ${reach.join(', ')} from your next turn there` : `Reaches the next ${projectName(request.projectId)} workspace you hold`}; setup steps that need it stop failing.</FlowSuccess>
      : step === 0 ? <ChoiceCards label="Request" value={request ? `${request.projectId}:${request.name}` : ''} onChange={setPicked} choices={requests.map((entry) => {
        const entryState = states[`${userId}:${entry.projectId}:${entry.name}`];
        return { id: `${entry.projectId}:${entry.name}`, title: entry.name, detail: `${projectName(entry.projectId)} asks · ${entry.detail}`, badge: <Badge size="compact" color={entryState?.set ? 'green' : 'amber'}>{entryState?.set ? 'Set' : 'Missing'}</Badge> };
      })} />
      : step === 1 && request && kind ? <>
        <Summary rows={[['Value', <span key="name" className="font-mono">{request.name}</span>], ['Asked by', `${projectName(request.projectId)}’s environment · ${request.detail}`]]} />
        <InputGroup className="w-full">
          {kind.kind === 'login' ? <InputField index={0} label="Username" value={username} onChange={(value) => { setUsername(value); setCheckError(null); }} autoComplete="off" error={tried && usernameError ? usernameError : undefined} /> : null}
          <InputField index={kind.kind === 'login' ? 1 : 0} label={kind.kind === 'login' ? 'Password' : `${kind.service} token`} type="password" value={secret} onChange={(value) => { setSecret(value); setCheckError(null); }} autoComplete="off" placeholder={kind.prefix ? `${kind.prefix}…` : undefined} error={tried && secretError ? secretError : undefined} />
        </InputGroup>
        <Hint>{kind.how}.{state?.set ? ` Replaces the value set ${state.updated}.` : ''}</Hint>
        {checking ? <Waiting>Checking with {kind.service}…</Waiting> : null}
        {checkError ? <FlowError>{checkError}</FlowError> : null}
      </>
      : request ? <>
        <Summary rows={[
          ['Reaches', reach.length ? `${reach.join(', ')}: workspaces in ${projectName(request.projectId)} whose handle you hold` : `No workspace yet: the next one in ${projectName(request.projectId)} whose handle you hold`],
          ['As', kind?.kind === 'login' ? <span key="as" className="font-mono">{request.name}_USER, {request.name}_PASSWORD</span> : <span key="as" className="font-mono">{request.name}</span>],
          ['Only for', 'Turns you start; a co-holder’s turns use their own value'],
          ['Never', 'Other projects, workspaces others hold, bots, the team’s secrets'],
        ]} />
        <Hint>Let go of a handle and the value leaves that workspace with you.</Hint>
      </> : null}
  </FlowDialog>;
}

export function ValueRemoveFlow({ userId, projectId, name, onClose }: { userId: string; projectId: string; name: string; onClose(): void }) {
  const held = useHeld()(userId).filter((id) => WORKSPACES.find((workspace) => workspace.id === id)?.projectId === projectId);
  return <ConfirmFlow id="personal-value-remove" title={`Remove ${name}`} confirmLabel="Remove value" onClose={onClose}
    description={`${projectName(projectId)} asks for it; removing it deletes your value.`}
    onConfirm={() => valueStates.set({ ...valueStates.get(), [`${userId}:${projectId}:${name}`]: { set: false, updated: '—' } })}
    success={{ title: `${name} removed`, body: `Setup steps in ${projectName(projectId)} that need it fail in workspaces you hold until you set it again.` }}>
    <Summary rows={[['Leaves', held.length ? held.join(', ') : 'No workspace: you hold none in this project'], ['Then', 'Setup steps that need it fail there, and say so']]} />
  </ConfirmFlow>;
}
