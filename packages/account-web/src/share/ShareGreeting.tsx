import { Button, InputField, InputGroup } from '@gitspace/ui';
import type { RuntimeBrowserSharePreview } from '@gitspace/protocol-runtime';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { shareTimeLeft } from './share-format.js';

export interface ShareGreetingProps {
  preview: RuntimeBrowserSharePreview;
  /** This browser holds the account's enrolled device: the visitor joins as the account, without a name to type. */
  asAccount: boolean;
  initialName: string;
  /** Why the greeting is showing again, if it is. */
  notice: string | null;
  /** Joins; answers why it could not (the greeting stays), or null once joined. */
  onJoin(name: string): Promise<string | null>;
}

/** A share page that offers nothing to join (ended, or a link that opens no share): the faded logo, a title and why. */
export function ShareNotice({ title, children }: { title: string; children: ReactNode }) {
  return <main className="flex h-dvh items-center justify-center overflow-y-auto bg-surface-2 px-4 py-8">
    <div className="flex w-full max-w-[420px] flex-col items-center gap-3 rounded-2xl border border-border bg-surface-1 p-8 text-center shadow-xl">
      <img src="/favicon.png" alt="" width={36} height={36} className="rounded-lg opacity-60" />
      <h1 className="text-subtitle font-semibold text-foreground">{title}</h1>
      <p className="text-body text-muted-foreground">{children}</p>
    </div>
  </main>;
}

/** What a visitor sees before joining a share: who shares which page, what they may and may not do, and when it ends. */
export function ShareGreeting({ preview, asAccount, initialName, notice, onJoin }: ShareGreetingProps) {
  const [name, setName] = useState(initialName);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(notice);
  const sharer = preview.sharer || 'Someone';
  const ready = asAccount || name.trim().length > 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || joining) return;
    setJoining(true);
    setError(null);
    const failure = await onJoin(name.trim());
    if (failure !== null) { setError(failure); setJoining(false); }
  };
  return <main className="flex h-dvh overflow-y-auto bg-surface-2 px-4 py-8 sm:items-center sm:justify-center">
    <form onSubmit={(event) => { void submit(event); }} className="mx-auto flex h-fit w-full max-w-[420px] flex-col gap-5 rounded-2xl border border-border bg-surface-1 p-7 shadow-xl">
      <div className="flex items-center gap-2.5"><img src="/favicon.png" alt="" width={28} height={28} className="rounded-lg" /><span className="text-body font-semibold text-foreground">GitSpace</span></div>
      <header className="flex flex-col gap-1">
        <h1 className="text-title font-semibold tracking-tight text-foreground">{sharer} is sharing a tab with you</h1>
        <p className="text-body text-muted-foreground">Live, as it happens in {sharer}&apos;s Chrome.</p>
      </header>
      <section aria-label="Shared page" className="flex min-w-0 flex-col rounded-xl border border-border bg-surface-2 p-3">
        <span className="truncate text-body font-medium text-foreground">{preview.page.title || preview.page.site}</span>
        <span className="truncate font-mono text-caption text-muted-foreground">{preview.page.site}</span>
      </section>
      <ul aria-label="What you can do" className="flex flex-col gap-1.5 text-body text-foreground">
        <li>✓ Watch the tab live</li>
        <li>✓ Point: everyone sees your pointer with your name</li>
        {preview.comment ? <li>✓ Comment on anything on the page</li> : null}
        <li className="text-muted-foreground">✕ Click or type in the page; only {sharer} and their agent can</li>
        {preview.comment ? null : <li className="text-muted-foreground">✕ Comment: this share is view only</li>}
      </ul>
      {asAccount
        ? <p className="rounded-lg bg-surface-2 px-3 py-2 text-caption text-foreground">Joining as <strong>{sharer}</strong> (signed in to GitSpace)</p>
        : <InputGroup className="w-full"><InputField index={0} label="Your name" value={name} onChange={setName} placeholder={preview.comment ? 'Shown on your pointer and comments' : 'Shown on your pointer'} maxLength={60} autoComplete="name" disabled={joining} /></InputGroup>}
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
      <Button type="submit" variant="primary" disabled={!ready || joining}>{joining ? 'Joining…' : 'Join'}</Button>
      <p className="text-caption text-muted-foreground">
        {sharer} sees that you joined. Ends in {shareTimeLeft(preview.expiresAt, Date.now())} or when {sharer} stops sharing.{asAccount ? '' : ' No account needed.'}
      </p>
    </form>
  </main>;
}
