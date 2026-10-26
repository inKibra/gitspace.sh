import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BROWSER_POWER_LABELS, BROWSER_POWERS, browserEverythingLabel, type BrowserPower, type RuntimeBrowserOverview } from '@gitspace/protocol-runtime';
import { Badge, Button, Switch } from '@gitspace/ui';

type Chrome = RuntimeBrowserOverview['chromes'][number];

/** Each power as a Chrome card's header names it. */
const POWER_BADGES: Record<BrowserPower, string> = { record: 'Video', debug: 'Debug', storage: 'Storage' };

/** The powers this project gives agents on a Chrome, as small badges for its card's header. */
export function ChromePowerBadges({ powers }: { powers: readonly BrowserPower[] }) {
  return <>{powers.map(power => <Badge key={power} size="compact" color="blue">{POWER_BADGES[power]}</Badge>)}</>;
}

/** A Chrome card's powers (turned on per project, stored on its approval) and Everything for this workspace: allowed
 * for an hour from here, counted down to its signed expiry, and ended early with End now. `pending` is the Browser
 * tab's action in progress, if any. `onExpire` runs once at the exact expiry. */
export function ChromePowers({ chrome, pending, onPower, onEverything, onExpire }: { chrome: Chrome; pending: string | null; onPower(power: BrowserPower, on: boolean): void; onEverything(on: boolean): void; onExpire(): void }) {
  const everything = chrome.everything;
  return <div className="flex flex-col gap-2">
    {everything ? <EverythingLeft expiresAt={everything.expiresAt} onExpire={onExpire}>
      <Button variant="secondary" size="compact" disabled={pending !== null} loading={pending === `everything:${chrome.pairingId}`} onClick={() => onEverything(false)}>End now</Button>
    </EverythingLeft> : null}
    <div role="group" aria-label={`Powers on ${chrome.name}`} className="flex flex-wrap items-center gap-x-1">
      <span className="mr-1 text-caption font-medium">Powers</span>
      {BROWSER_POWERS.map(power => <Switch key={power} size="compact" aria-label={`${BROWSER_POWER_LABELS[power]} on ${chrome.name}`} label={BROWSER_POWER_LABELS[power]} checked={chrome.powers.includes(power)} disabled={pending !== null} onToggle={() => onPower(power, !chrome.powers.includes(power))} />)}
    </div>
    {!chrome.connected ? null : !chrome.powersSupported
      ? <p className="text-caption text-[#b45309]">Update the extension in this Chrome to 5.11 for powers and Everything to work. The powers you turn on are kept, but this version cannot enforce them.</p>
      : everything ? null : <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="compact" disabled={pending !== null} loading={pending === `everything:${chrome.pairingId}`} onClick={() => onEverything(true)}>Allow everything for 1 hour</Button>
        <span className="text-caption text-muted-foreground">For the main agent only: any web page in this group and every power. Never other extensions, Chrome&apos;s own pages or tabs outside the group.</span>
      </div>}
  </div>;
}

/** `Everything · 52 min left`, redrawn as each minute passes; `onExpire` runs at `expiresAt`. */
function EverythingLeft({ expiresAt, onExpire, children }: { expiresAt: string; onExpire(): void; children: ReactNode }) {
  const [now, setNow] = useState(Date.now);
  const expire = useRef(onExpire);
  expire.current = onExpire;
  // The label rounds up to the minute, so it changes exactly when the time left crosses a whole minute.
  useEffect(() => {
    const end = Date.parse(expiresAt);
    let timer = 0;
    const redraw = () => {
      const left = end - Date.now();
      setNow(Date.now());
      if (left > 0) timer = window.setTimeout(redraw, left % 60_000 || 60_000);
    };
    redraw();
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  useEffect(() => {
    const timer = setTimeout(() => expire.current(), Math.max(0, Date.parse(expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return <section aria-label="Everything" className="flex flex-wrap items-center gap-2 rounded-lg border border-[#f59e0b]/50 bg-[#f59e0b]/10 px-2.5 py-2">
    <span className="text-body font-medium tabular-nums">{browserEverythingLabel(expiresAt, now)}</span>
    <span className="min-w-0 flex-1 text-caption text-muted-foreground">The main agent can open any web page in this group and use every power.</span>
    {children}
  </section>;
}
