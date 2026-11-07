// A tool call's text output as numbered log lines: failure lines carry a red edge, passes a green one; a filter narrows
// the lines, Wrap wraps them, Copy copies the whole output.
import { Button, Tooltip, badgeColors, useShape } from '@gitspace/ui';
import { Copy01, SearchMd } from '@untitledui/icons';
import { useState } from 'react';

type LineTone = 'error' | 'ok' | 'plain';

function toneOf(line: string): LineTone {
  if (/\b(error|traceback|canceled|aborted|exception|panicked|failed)\b|^\s*[1-9]\d* fail\b|exit(?: code)?[ =:]+[1-9]/iu.test(line)) return 'error';
  if (/\(pass\)|^\s*\d+ pass\b|SUCCEEDED|^exit[= ]0$/u.test(line)) return 'ok';
  return 'plain';
}

function Marked({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark className="rounded-[2px] bg-[#fde68a] text-inherit dark:bg-[#f59e0b]/40">{text.slice(at, at + query.length)}</mark>{text.slice(at + query.length)}</>;
}

/** `command` (a bash call's) shows first as a `$` line, folded to its first line until clicked. */
export function LogView({ command, text, running, failed }: { command: string | null; text: string; running: boolean; failed: boolean }) {
  const shape = useShape();
  const [query, setQuery] = useState('');
  const [wrap, setWrap] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const lines = text ? text.replace(/\n$/u, '').split('\n') : [];
  const numbered = lines.map((line, index) => ({ line, number: index + 1, tone: toneOf(line) }));
  const shown = query ? numbered.filter((entry) => entry.line.toLowerCase().includes(query.toLowerCase())) : numbered;
  const errors = numbered.filter((entry) => entry.tone === 'error').length;
  return <div className={`min-w-0 overflow-hidden border border-border bg-background ${shape.container}`} data-log-view>
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5 text-caption">
      {running ? <span className="flex items-center gap-1.5 text-foreground"><span className="relative flex size-1.5"><span className="absolute inline-flex size-full animate-ping rounded-full opacity-70" style={{ background: badgeColors.green }} /><span className="relative inline-flex size-1.5 rounded-full" style={{ background: badgeColors.green }} /></span>Live</span> : null}
      <span className="tabular-nums text-muted-foreground">{lines.length} {lines.length === 1 ? 'line' : 'lines'}{errors ? <> · <span style={{ color: badgeColors.red }}>{errors} with errors</span></> : null}</span>
      <label className="relative ml-auto flex min-w-40 max-w-60 flex-1 items-center">
        <SearchMd width={13} height={13} strokeWidth={1.5} className="pointer-events-none absolute left-2 text-muted-foreground" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter lines" aria-label="Filter lines" className="h-7 w-full rounded-md border border-border bg-surface-1 pl-7 pr-2 text-caption text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]" />
      </label>
      <Button variant={wrap ? 'secondary' : 'ghost'} size="compact" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap</Button>
      <Tooltip content="Copy output" side="bottom"><Button variant="ghost" size="icon-compact" aria-label="Copy output" onClick={() => void navigator.clipboard?.writeText(text)}><Copy01 width={14} height={14} strokeWidth={1.5} /></Button></Tooltip>
    </div>
    <div className="max-h-72 overflow-auto py-1 font-mono text-[11.5px] leading-[18px]">
      {command ? <button type="button" onClick={() => setShowCommand(!showCommand)} className={`flex w-full gap-3 px-2 text-left text-muted-foreground hover:bg-surface-1 ${showCommand ? 'whitespace-pre-wrap break-all' : 'truncate whitespace-pre'}`} title={showCommand ? 'Fold the command' : 'Show the whole command'} data-log-command>
        <span className="w-6 shrink-0 select-none text-right opacity-60">$</span><span className="min-w-0">{showCommand ? command : command.split('\n')[0]}</span>
      </button> : null}
      {shown.map((entry) => <div key={entry.number} data-log-line={entry.tone} className={`relative flex gap-3 px-2 ${entry.tone === 'error' ? 'bg-[#ef4444]/[0.07]' : ''}`}>
        {entry.tone !== 'plain' ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5" style={{ background: entry.tone === 'error' ? badgeColors.red : badgeColors.green }} /> : null}
        <span className="w-6 shrink-0 select-none text-right tabular-nums text-muted-foreground opacity-60">{entry.number}</span>
        <span className={`min-w-0 ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'} ${entry.tone === 'plain' ? 'text-muted-foreground' : 'text-foreground'}`}>{query ? <Marked text={entry.line} query={query} /> : entry.line || ' '}</span>
      </div>)}
      {!lines.length && !running ? <p className="px-2 py-1 font-sans text-caption text-muted-foreground">{failed ? 'No output.' : 'The call returned no text.'}</p> : null}
      {running ? <div className="flex gap-3 px-2" aria-hidden><span className="w-6 shrink-0" /><span className="inline-block h-3.5 w-[7px] translate-y-[2px] animate-pulse bg-foreground/40" /></div> : null}
      {query && !shown.length ? <p className="px-2 py-1 font-sans text-caption text-muted-foreground">No line matches “{query}”.</p> : null}
    </div>
  </div>;
}
