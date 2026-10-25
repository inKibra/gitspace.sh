// The extension's popup (docs/APERTURE-DESIGN.md §6.4; the agreed look is account-web's BrowsersMockExtension
// `Popup`): whether GitSpace is on in this Chrome and connected, the workspaces using it with what their agent is doing,
// and this tab: its share link (copying it makes the share), what people on it may do, who is watching, Capture (your
// click here is what lets Chrome record the tab) and leaving its workspace group. Identity & pairing is a second
// panel. Off, it says so and offers Turn on. It asks the service worker for everything (`popupRequest`).
import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Recording01 } from '@untitledui/icons';
import type { RuntimeBrowserShare } from '@gitspace/protocol-runtime';
import { Button } from '@/components/ui/button';
import { DropdownContent, DropdownMenu, DropdownTrigger } from '@/components/ui/dropdown';
import { InputCopy } from '@/components/ui/input-copy';
import { MenuItem } from '@/components/ui/menu-item';
import { Switch } from '@/components/ui/switch';
import { TooltipProvider } from '@/components/ui/tooltip';
import { IconProvider } from '@/lib/icon-context';
import { ShapeProvider } from '@/lib/shape-context';
import { SizeProvider } from '@/lib/size-context';
import { untitledIcons } from '../../ui/src/icons.js';
import type { RunLogEntry } from './runs.js';
import { SHARE_EXPIRIES_MINUTES } from './share.js';

type Connection = 'connected' | 'connecting' | 'off' | 'update' | 'unpaired';
/** What an agent is doing on a group now: who (`main`) and, in a few words, what. */
type Acting = { agent: string; doing: string };
type Group = { groupId: string; name: string; color: string; project: string | null; tabs: number; acting: Acting | null };
type Recording = { captureId: string; title: string; track: 'video' | 'frames'; startedAt: number; saving: boolean };
/** What the service worker's `popupState` answers. `chrome` (this Chrome's name) and `projects` (those that approved
 * it) are null until the account said. */
type PopupState = {
  enabled: boolean; reenableAt: number | null; account: string; chrome: string | null; connection: Connection;
  projects: string[] | null; fingerprint: string | null; compatibility: string | null; groups: Group[];
  activeTab: { tabId: number; groupId: string; name: string; color: string; capture: { recording: string | null; unavailable: string | null } } | null;
  shareTab: { tabId: number; host: string; grouped: boolean; unavailable: string | null } | null;
  shares: RuntimeBrowserShare[]; recordings: Recording[]; log: RunLogEntry[];
};
type Pairing = { code: string; pairingId: string; generation: number; expiresAt: string; trust: { algorithm: 'Ed25519'; accountId: string; publicKey: string } };
type PopupRequest = { popupState: true } | { setEnabled: { enabled: boolean; minutes?: number } } | { stopGroup: string } | { focusGroup: string }
  | { ungroupTab: number } | { startCapture: number } | { stopCapture: string } | { shareCreate: { tabId: number; comment: boolean; expiresInMinutes: number } }
  | { shareRevoke: { shareId: string } } | { openAccount: true } | { pair: Pairing } | { resetIdentity: true };
/** The service worker answers the popup's next state, `ok` for pairing and reset, or why it refused. */
type Reply = PopupState | { ok: true } | { error: string };
declare const chrome: { runtime: { sendMessage(message: PopupRequest): Promise<Reply> } };

const BLUE = '#1a73e8';
const RED = '#dc2626';
/** Account-web's StatusDot colours (GitSpaceShell). */
type DotColor = 'dim' | 'green' | 'orange' | 'red';
const DOT: Record<DotColor, string> = { dim: 'var(--muted-foreground)', green: '#22c55e', orange: '#f97316', red: '#ef4444' };
/** What people on a share link may do: view always, comment where the tab is in a workspace group. */
const CAPABILITIES: readonly ('view' | 'comment')[] = ['view', 'comment'];
const COMMENT_NEEDS_GROUP = 'Comments need the tab in a workspace group';

async function request(message: PopupRequest): Promise<PopupState | null> {
  const reply = await chrome.runtime.sendMessage(message);
  if ('error' in reply) throw new Error(reply.error);
  return 'ok' in reply ? null : reply;
}
/** Pairing details as GitSpace shows them (Plugins → Browsers → Pair a Chrome), still valid. */
function isPairing(value: unknown): value is Pairing {
  if (typeof value !== 'object' || value === null || !('code' in value) || !('pairingId' in value) || !('generation' in value) || !('expiresAt' in value) || !('trust' in value)) return false;
  const { code, pairingId, generation, expiresAt, trust } = value;
  return typeof code === 'string' && code !== '' && typeof pairingId === 'string' && pairingId !== '' && Number.isSafeInteger(generation) && typeof expiresAt === 'string' && Date.parse(expiresAt) > Date.now()
    && typeof trust === 'object' && trust !== null && 'algorithm' in trust && trust.algorithm === 'Ed25519' && 'accountId' in trust && typeof trust.accountId === 'string' && trust.accountId !== '' && 'publicKey' in trust && typeof trust.publicKey === 'string' && trust.publicKey !== '';
}

/** "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string { return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`; }
/** How long a capture has recorded, as m:ss. */
function clock(startedAt: number): string { const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
/** How long a share has left: "52 min left", "7 h 59 min left". */
function left(expiresAt: string): string { const minutes = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 60000)); return minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''} left` : `${minutes} min left`; }
/** A share's length as the expiry menu names it. */
function lasting(minutes: number): string { return minutes < 60 ? `for ${minutes} minutes` : minutes === 60 ? 'for 1 hour' : `for ${Math.round(minutes / 60)} hours`; }
/** A share link as the field shows it: host, path and the start of the share id. */
function shortLink(link: string): string { const url = new URL(link); return `${url.host}${url.pathname.slice(0, 11)}…`; }
function watching(viewers: RuntimeBrowserShare['viewers']): string {
  const names = viewers.map(viewer => viewer.guest ? `${viewer.name} (guest)` : viewer.name);
  if (!names.length) return 'No one is watching yet';
  const shown = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names;
  return `${listed(shown)} ${names.length === 1 ? 'is' : 'are'} watching`;
}
/** The fingerprint as both GitSpace and this popup show it to compare: its first 16 hex digits in fours. */
function shortFingerprint(fingerprint: string): string { return fingerprint.slice(0, 16).toUpperCase().replace(/(.{4})(?=.)/g, '$1 '); }

/** Account-web's StatusDot: a 6px dot, pulsing while something is live. */
function StatusDot({ color, pulse = false }: { color: DotColor; pulse?: boolean }) {
  return <span className="status-dot" data-pulse={pulse || undefined} style={{ color: DOT[color] }} aria-hidden />;
}
/** GitSpace's mark (the favicon's `>_`), grey while off. */
function Mark({ size, off }: { size: number; off: boolean }) {
  const id = useId();
  return <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden className="shrink-0 rounded-md" style={off ? { filter: 'grayscale(1)' } : undefined}>
    <defs>
      <linearGradient id={`${id}-chevron`} x1="0" y1="85" x2="0" y2="381" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#037935" /><stop offset="1" stopColor="#05e063" /></linearGradient>
      <linearGradient id={`${id}-line`} x1="0" y1="398" x2="0" y2="426" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#037935" /><stop offset="1" stopColor="#06c958" /></linearGradient>
    </defs>
    <path d="M85 106 213 233 85 360" fill="none" stroke={`url(#${id}-chevron)`} strokeWidth="42" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M256 405H426" stroke={`url(#${id}-line)`} strokeWidth="42" strokeLinecap="round" />
  </svg>;
}
function Heading({ children }: { children: ReactNode }) { return <h3 className="text-caption font-semibold text-muted-foreground">{children}</h3>; }

type Act = (message: PopupRequest, success: string) => Promise<PopupState | null>;

/** The connection, in the strip under the header: green when connected, orange when GitSpace needs you. */
function Strip({ state }: { state: PopupState }) {
  if (state.connection === 'connected') {
    const approved = state.projects === null ? '' : state.projects.length ? ` · approved in ${listed(state.projects)}` : ' · no project has approved this Chrome yet';
    return <div className="flex items-center gap-2 bg-[#22c55e]/10 px-4 py-2 text-caption" role="status"><StatusDot color="green" />Connected{approved}</div>;
  }
  const what = state.connection === 'connecting' ? `Connecting to ${state.account}…` : state.connection === 'update' ? 'Update required' : 'Not paired: pair this Chrome from GitSpace, Plugins → Browsers';
  return <div className="flex flex-col gap-0.5 bg-[#f97316]/10 px-4 py-2 text-caption" role="status">
    <span className="flex items-center gap-2"><StatusDot color="orange" pulse={state.connection === 'connecting'} />{what}</span>
    {state.connection === 'update' && state.compatibility ? <span className="text-[11px] text-muted-foreground">{state.compatibility}</span> : null}
  </div>;
}

function GroupRow({ group, act }: { group: Group; act: Act }) {
  const { acting } = group;
  return <div className="flex items-center gap-2.5 rounded-lg px-1 py-1.5 hover:bg-hover">
    <span className="size-2.5 shrink-0 rounded-full" style={{ background: group.color }} />
    <div className="min-w-0 flex-1">
      <p className="truncate text-caption font-medium">{group.name}{group.project ? <> <span className="font-normal text-muted-foreground">· {group.project}</span></> : null}</p>
      <p className={`truncate text-[11px] ${acting ? 'text-foreground' : 'text-muted-foreground'}`}>{acting ? `▶ ${acting.agent} · ${acting.doing.charAt(0).toLowerCase()}${acting.doing.slice(1)}` : `idle · ${group.tabs} ${group.tabs === 1 ? 'tab' : 'tabs'}`}</p>
    </div>
    {acting ? <Button variant="secondary" size="compact" onClick={() => { void act({ stopGroup: group.groupId }, 'Stopped.'); }}>Stop</Button>
      : <Button variant="ghost" size="compact" onClick={() => { void act({ focusGroup: group.groupId }, ''); }}>Show</Button>}
  </div>;
}

/** Capture for a tab in a workspace group, in a row like Remove from group's: the popup is where Chrome lets GitSpace
 * record a tab with its sound (the in-page toolbar's Capture records its frames). */
function Capture({ state, act }: { state: PopupState; act: Act }) {
  const tab = state.activeTab;
  if (!tab) return null;
  const recording = tab.capture.recording ? state.recordings.find(item => item.captureId === tab.capture.recording) : undefined;
  return <div className="flex items-center gap-2">
    <span className="shrink-0 whitespace-nowrap">{recording
      ? <Button variant="ghost" size="compact" disabled={recording.saving} onClick={() => { void act({ stopCapture: recording.captureId }, 'Saved to the workspace’s captures.'); }}>{recording.saving ? 'Saving…' : 'Stop capture'}</Button>
      : <Button variant="ghost" size="compact" disabled={tab.capture.unavailable !== null} onClick={() => { void act({ startCapture: tab.tabId }, 'Recording this tab. Stop it here or in the tab.'); }}><Recording01 width={14} height={14} />Capture</Button>}</span>
    {recording ? <span className="flex items-center gap-1.5 text-[11px] font-medium tabular-nums" style={{ color: RED }}><StatusDot color="red" pulse />REC {clock(recording.startedAt)}{recording.track === 'frames' ? ' · frames · no sound' : ' · with sound'}</span>
      : <span className="text-[11px] text-muted-foreground">{tab.capture.unavailable ?? 'Record this tab with its sound, for the workspace’s captures.'}</span>}
  </div>;
}

/** This tab's one share link. Copying it makes the share when there is none; a live one shows who is watching. */
function ShareLink({ state, act }: { state: PopupState; act: Act }) {
  const tab = state.shareTab;
  const share = state.shares[0];
  const [comment, setComment] = useState(true);
  const [minutes, setMinutes] = useState(60);
  const field = useRef<HTMLDivElement>(null);
  /** Set when a share was just made: the field copies its link once it shows it. */
  const copyMade = useRef(false);
  useEffect(() => {
    if (!share || !copyMade.current) return;
    copyMade.current = false;
    field.current?.querySelector('button')?.click();
  }, [share]);
  if (!tab) return null;
  const comments = share ? share.comment : comment && tab.grouped;
  const make = (event: MouseEvent) => {
    if (share) return;
    event.preventDefault();
    event.stopPropagation();
    copyMade.current = true;
    void act({ shareCreate: { tabId: tab.tabId, comment: comments, expiresInMinutes: minutes } }, '').then(next => { if (!next?.shares.length) copyMade.current = false; });
  };
  const duration = share ? Math.round((Date.parse(share.expiresAt) - Date.parse(share.createdAt)) / 60000) : minutes;
  return <>
    <div ref={field} onClickCapture={make}>
      <InputCopy value={share ? share.link : 'Copy to make this tab’s share link'} displayValue={share ? shortLink(share.link) : `${state.account}/s/…`} disabled={!share && tab.unavailable !== null} aria-label="Share link" />
    </div>
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-muted-foreground">People can</span>
      {CAPABILITIES.map(capability => {
        const on = capability === 'view' || comments;
        const locked = capability === 'view' || Boolean(share) || !tab.grouped;
        return <button key={capability} type="button" disabled={locked} aria-pressed={on} title={capability === 'comment' && !tab.grouped ? COMMENT_NEEDS_GROUP : undefined} onClick={() => setComment(value => !value)}
          className={`rounded-full border px-2 py-0.5 ${on ? 'border-transparent text-white' : 'border-border text-muted-foreground'} ${capability === 'comment' && !tab.grouped ? 'opacity-50' : ''}`} style={on ? { background: BLUE } : undefined}>{on ? '✓ ' : ''}{capability}</button>;
      })}
      {share ? <span className="ml-auto text-muted-foreground">{lasting(duration)}</span> : <DropdownMenu>
        <DropdownTrigger render={<button type="button" className="ml-auto text-muted-foreground hover:text-foreground">{lasting(minutes)} ▾</button>} />
        <DropdownContent align="end" sideOffset={4} checkedIndex={SHARE_EXPIRIES_MINUTES.findIndex(value => value === minutes)}>
          {SHARE_EXPIRIES_MINUTES.map((value, index) => <MenuItem key={value} index={index} label={lasting(value)} checked={value === minutes} onSelect={() => setMinutes(value)} />)}
        </DropdownContent>
      </DropdownMenu>}
    </div>
    {!tab.grouped ? <p className="text-[11px] text-muted-foreground">{COMMENT_NEEDS_GROUP}.</p> : null}
    <p className="text-[11px] text-muted-foreground">Paste it into one of your workspaces to give its agent this tab, or send it to someone to watch and point{comments ? ' and comment' : ''}. Only you and your agent ever click or type. Ends when it expires, when you stop it, or when the tab closes.</p>
    {!share && tab.unavailable ? <p className="text-[11px] text-muted-foreground">{tab.unavailable}</p> : null}
    {share ? <div className="flex items-center gap-2 rounded-lg bg-surface-3 px-2.5 py-1.5 text-caption">
      <StatusDot color={share.viewers.length ? 'green' : 'dim'} pulse={share.viewers.length > 0} />
      <span className="min-w-0 flex-1 truncate">{watching(share.viewers)} · {left(share.expiresAt)}</span>
      <Button variant="ghost" size="compact" onClick={() => { void act({ shareRevoke: { shareId: share.shareId } }, 'Stopped sharing this tab.'); }}>Stop sharing</Button>
    </div> : null}
  </>;
}

function ThisTab({ state, act }: { state: PopupState; act: Act }) {
  const { activeTab: group, shareTab } = state;
  if (!group && !shareTab) return null;
  return <section className="flex flex-col gap-2 border-t border-border px-4 py-3">
    <Heading>This tab{shareTab ? ` · ${shareTab.host}` : ''}{group ? <> · in <span style={{ color: group.color }}>{group.name}</span></> : null}</Heading>
    <ShareLink state={state} act={act} />
    <Capture state={state} act={act} />
    {group ? <div className="flex items-center gap-2">
      <span className="shrink-0 whitespace-nowrap"><Button variant="ghost" size="compact" onClick={() => { void act({ ungroupTab: group.tabId }, 'This tab left the workspace group.'); }}>Remove from group</Button></span>
      <span className="text-[11px] text-muted-foreground">Drag it to another group in Chrome to move it.</span>
    </div> : null}
  </section>;
}

/** Captures recording other tabs; this tab's shows beside its Capture. */
function Recordings({ state, act }: { state: PopupState; act: Act }) {
  const others = state.recordings.filter(item => item.captureId !== state.activeTab?.capture.recording);
  if (!others.length) return null;
  return <section className="flex flex-col gap-1 border-t border-border px-4 py-3">
    <Heading>Recording</Heading>
    {others.map(item => <div key={item.captureId} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5">
      <span className="size-2.5 shrink-0 animate-pulse rounded-full" style={{ background: RED }} />
      <div className="min-w-0 flex-1"><p className="truncate text-caption font-medium">{item.title || 'Untitled tab'}</p><p className="truncate text-[11px] tabular-nums text-muted-foreground">REC {clock(item.startedAt)}{item.track === 'frames' ? ' · frames · no sound' : ' · with sound'}{item.saving ? ' · saving…' : ''}</p></div>
      <Button variant="secondary" size="compact" disabled={item.saving} onClick={() => { void act({ stopCapture: item.captureId }, 'Saved to the workspace’s captures.'); }}>Stop</Button>
    </div>)}
  </section>;
}

function Main({ state, act }: { state: PopupState; act: Act }) {
  return <>
    <Strip state={state} />
    <section className="flex flex-col gap-1 px-4 py-3">
      <Heading>Using this Chrome</Heading>
      {state.groups.length ? state.groups.map(group => <GroupRow key={group.groupId} group={group} act={act} />) : <p className="py-1.5 text-caption text-muted-foreground">No workspace is using this Chrome.</p>}
    </section>
    <ThisTab state={state} act={act} />
    <Recordings state={state} act={act} />
  </>;
}

function Off({ state, act }: { state: PopupState; act: Act }) {
  const until = state.reenableAt === null ? '' : ` It turns back on at ${new Date(state.reenableAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  return <div className="flex flex-col gap-2 px-4 py-4">
    <p className="text-body font-medium">Off: agents can&apos;t use this Chrome</p>
    <p className="text-caption text-muted-foreground">Running scripts were stopped. Tab groups stay; nothing resumes until an agent asks again.{until}</p>
    <div className="flex gap-2">
      <Button variant="primary" size="compact" onClick={() => { void act({ setEnabled: { enabled: true } }, ''); }}>Turn on</Button>
      <Button variant="ghost" size="compact" onClick={() => { void act({ setEnabled: { enabled: false, minutes: 60 } }, 'Off for 1 hour.'); }}>Off for 1 hour</Button>
    </div>
  </div>;
}

/** This Chrome's identity: the fingerprint to compare when pairing, pairing, reset, and the latest scripts. */
function Identity({ state, onBack, onPair, onReset }: { state: PopupState; onBack(): void; onPair(text: string): Promise<boolean>; onReset(): void }) {
  const [details, setDetails] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); void onPair(details).then(paired => { if (paired) setDetails(''); }); };
  return <>
    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
      <Button variant="ghost" size="compact" onClick={onBack}>← Back</Button>
      <p className="text-caption font-semibold">Identity &amp; pairing</p>
    </div>
    <section className="flex flex-col gap-1 px-4 py-3">
      <Heading>This Chrome’s fingerprint</Heading>
      {state.fingerprint ? <>
        <p className="font-mono text-body tracking-wide">{shortFingerprint(state.fingerprint)}</p>
        <p className="break-all font-mono text-[10px] text-muted-foreground">{state.fingerprint}</p>
        <p className="text-[11px] text-muted-foreground">Compare it with the one GitSpace shows when you pair this Chrome, then confirm it there.</p>
      </> : <p className="text-caption text-muted-foreground">No identity yet: pairing makes one.</p>}
    </section>
    <section className="flex flex-col gap-2 border-t border-border px-4 py-3">
      <Heading>Pair</Heading>
      <p className="text-[11px] text-muted-foreground">Paste the pairing details from GitSpace: Plugins → Browsers → Pair a Chrome.</p>
      <form className="flex gap-2" onSubmit={submit}>
        <input value={details} onChange={event => setDetails(event.target.value)} autoComplete="off" required placeholder="Pairing details" aria-label="Pairing details" className="h-7 min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2.5 text-caption outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]" />
        <Button size="compact" type="submit">Pair</Button>
      </form>
    </section>
    <section className="flex flex-col gap-2 border-t border-border px-4 py-3">
      <Heading>Reset identity</Heading>
      <p className="text-[11px] text-muted-foreground">Makes a new key for this Chrome. Forget it in GitSpace afterwards (Plugins → Browsers → Manage Chrome) and pair it again.</p>
      <span><Button variant="secondary" size="compact" className="text-destructive" onClick={onReset}>Reset identity</Button></span>
    </section>
    <section className="flex flex-col gap-1 border-t border-border px-4 py-3">
      <Heading>Recent scripts</Heading>
      {state.log.length ? state.log.map(entry => <p key={entry.attemptId} className="truncate text-[11px] text-muted-foreground" title={entry.scriptSha256}>{new Date(entry.startedAt).toLocaleString()} · {entry.workspace.groupName} · {entry.commands} commands · {entry.endReason}</p>)
        : <p className="text-caption text-muted-foreground">No scripts have run here yet.</p>}
    </section>
  </>;
}

function Popup() {
  const [state, setState] = useState<PopupState | null>(null);
  const [panel, setPanel] = useState<'main' | 'identity'>('main');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const opened = useRef(false);
  useEffect(() => {
    const refresh = () => { request({ popupState: true }).then(next => {
      if (!next) return;
      setState(next);
      // Pairing is the first thing an unpaired Chrome needs.
      if (!opened.current && next.connection === 'unpaired') setPanel('identity');
      opened.current = true;
    }, (error: unknown) => setMessage(error instanceof Error ? error.message : String(error))); };
    refresh();
    // Scripts start and end, and people join shares, while the popup is open.
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, []);
  /** One popup action; while it runs, the popup's buttons wait. */
  const act: Act = async (message, success) => {
    setBusy(true);
    try { const next = await request(message); if (next) setState(next); setMessage(success); return next; }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); return null; }
    finally { setBusy(false); }
  };
  /** Pairing and reset answer `ok`; the popup then reads its state again. */
  const identity = async (message: PopupRequest, success: string) => {
    try { await request(message); setState(await request({ popupState: true })); setMessage(success); return true; }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); return false; }
  };
  const pair = (text: string) => {
    let value: unknown = null;
    try { value = JSON.parse(text); } catch {}
    if (!isPairing(value)) { setMessage('Copy fresh pairing details from GitSpace: Plugins → Browsers → Pair a Chrome'); return Promise.resolve(false); }
    return identity({ pair: value }, 'Compare the fingerprint above with the one GitSpace shows, then confirm it there before agents can use this Chrome.');
  };
  if (!state) return <div className="px-4 py-3 text-caption text-muted-foreground">{message}</div>;
  return <div className="flex flex-col bg-surface-1 text-left" inert={busy}>
    <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
      <Mark size={24} off={!state.enabled} />
      <div className="min-w-0 flex-1"><p className="text-body font-semibold">GitSpace</p><p className="truncate text-caption text-muted-foreground">{state.account}{state.chrome ? ` · ${state.chrome}` : ''}</p></div>
      <Switch checked={state.enabled} label={state.enabled ? 'On' : 'Off'} onToggle={() => { void act({ setEnabled: { enabled: !state.enabled } }, ''); }} />
    </header>
    {!state.enabled ? <Off state={state} act={act} />
      : panel === 'identity' ? <Identity state={state} onBack={() => setPanel('main')} onPair={pair} onReset={() => { void identity({ resetIdentity: true }, 'Identity reset. Forget this Chrome in GitSpace (Plugins → Browsers → Manage Chrome), then pair it again.'); }} />
      : <Main state={state} act={act} />}
    {message ? <p className="border-t border-border px-4 py-2 text-caption text-muted-foreground" role="status">{message}</p> : null}
    {state.enabled && panel === 'main' ? <footer className="flex items-center gap-2 border-t border-border px-4 py-2 text-caption">
      <Button variant="ghost" size="compact" onClick={() => { void act({ openAccount: true }, ''); }}>Open GitSpace</Button>
      <span className="flex-1" />
      <Button variant="ghost" size="compact" onClick={() => setPanel('identity')}>Identity &amp; pairing</Button>
    </footer> : null}
  </div>;
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<ShapeProvider defaultShape="rounded"><SizeProvider defaultSize="default"><IconProvider icons={untitledIcons}><TooltipProvider><Popup /></TooltipProvider></IconProvider></SizeProvider></ShapeProvider>);
