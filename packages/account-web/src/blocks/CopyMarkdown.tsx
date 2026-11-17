// "Copy as Markdown" beside a block's expand button: the block as plain Markdown (`blockMarkdown`), to paste into Slack
// or GitHub. The Markdown is made when the button is pressed, from the block as it is then.
import { Button } from '@gitspace/ui';
import { Check, File06 } from '@untitledui/icons';
import { useEffect, useState } from 'react';

/** How long the button shows that the copy succeeded. */
const COPIED_MS = 1500;

/** `markdown` gives the block's Markdown when pressed. */
export function CopyMarkdownButton({ markdown }: { markdown: () => string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <Button variant="secondary" size="icon-compact" type="button" aria-label={copied ? 'Copied as Markdown' : 'Copy as Markdown'} title="Copy as Markdown"
    onClick={() => { void navigator.clipboard.writeText(markdown()).then(() => setCopied(true), () => setCopied(false)); }}>
    {copied ? <Check width={14} height={14} /> : <File06 width={14} height={14} />}
  </Button>;
}
