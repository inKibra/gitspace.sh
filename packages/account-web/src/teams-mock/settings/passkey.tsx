// Creating an identity (sending an invite, creating a bot, connecting a bot's client, making a bot's client secret)
// asks for the creator's passkey; the audit log records whose passkey it was and on which device.
import { ThinkingIndicator } from '@gitspace/ui';
import { Fingerprint01 } from '@untitledui/icons';
import { useState } from 'react';
import { userOf } from '../data.js';
import { DEVICES } from './data.js';

/** "Theo’s passkey (ThinkPad)": the passkey this browser holds for the person. */
export function passkeyLabel(userId: string): string {
  const device = (DEVICES[userId] ?? []).find((entry) => entry.current) ?? DEVICES[userId]?.[0];
  return `${userOf(userId).first}’s passkey${device ? ` (${device.label})` : ''}`;
}

/** Asks for the passkey, then runs `then` once the browser confirms it. */
export function usePasskey(): { waiting: boolean; confirm(then: () => void): void } {
  const [waiting, setWaiting] = useState(false);
  return {
    waiting,
    confirm(then) {
      setWaiting(true);
      window.setTimeout(() => { setWaiting(false); then(); }, 1500);
    },
  };
}

export function PasskeyWaiting({ userId, what }: { userId: string; what: string }) {
  return <div role="status" data-passkey-waiting="" className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-3 text-body text-foreground shadow-[inset_0_0_0_1px_var(--border)]">
    <ThinkingIndicator /><Fingerprint01 width={20} height={20} strokeWidth={1.5} />
    <span>Confirm {what} with {passkeyLabel(userId)}…</span>
  </div>;
}
