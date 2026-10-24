import { Button, InputField, InputGroup } from '@gitspace/ui';
import type { RuntimeBrowserSharePreview } from '@gitspace/protocol-runtime';
import { Check, XClose } from '@untitledui/icons';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { shareEndsText } from './share-format.js';

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
  const may = [
    'Watch the tab live',
    'Point at things: everyone watching sees your pointer and name',
    ...(preview.comment ? [`Comment on what you point at: ${sharer} gets your comments`] : []),
  ];
  const mayNot = [`Click or type in the tab: it stays in ${sharer}'s hands`, ...(preview.comment ? [] : ['Comment: this share is view only'])];
  return <main className="flex h-dvh overflow-y-auto bg-background px-4 py-8 sm:items-center sm:justify-center">
    <form onSubmit={(event) => { void submit(event); }} className="mx-auto flex w-full max-w-md flex-col gap-6">
      <header className="flex flex-col gap-1">
        <span className="text-caption text-muted-foreground">Shared tab · GitSpace</span>
        <h1 className="text-title font-semibold text-foreground">{sharer} is sharing a tab with you</h1>
      </header>
      <section aria-label="Shared page" className="flex flex-col gap-0.5 rounded-xl border border-border bg-card px-4 py-3">
        <span className="truncate text-body font-medium text-foreground">{preview.page.title || preview.page.site}</span>
        <span className="truncate text-caption text-muted-foreground">{preview.page.site}</span>
      </section>
      <section aria-label="What you can do" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-caption font-medium text-muted-foreground">You can</h2>
          <ul className="flex flex-col gap-1.5">
            {may.map(text => <li key={text} className="flex gap-2 text-body text-foreground"><Check aria-hidden className="mt-0.5 size-4 shrink-0 text-green-600" />{text}</li>)}
          </ul>
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-caption font-medium text-muted-foreground">You can't</h2>
          <ul className="flex flex-col gap-1.5">
            {mayNot.map(text => <li key={text} className="flex gap-2 text-body text-muted-foreground"><XClose aria-hidden className="mt-0.5 size-4 shrink-0" />{text}</li>)}
          </ul>
        </div>
        <p className="text-caption text-muted-foreground">Ends {shareEndsText(preview.expiresAt, Date.now())}.</p>
      </section>
      <section className="flex flex-col gap-3">
        {asAccount
          ? <p className="text-body text-foreground">Joining as {sharer}</p>
          : <InputGroup className="w-full"><InputField index={0} label="Your name" value={name} onChange={setName} placeholder="Shown on your pointer" maxLength={60} autoComplete="name" disabled={joining} /></InputGroup>}
        {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
        <Button type="submit" variant="primary" disabled={!ready || joining}>{joining ? 'Joining…' : 'Join'}</Button>
      </section>
    </form>
  </main>;
}
