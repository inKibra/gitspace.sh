// Blocks the `blocks` builders make from real data: lines of a file, a command's run, a test run, a change's files.
import type { gitspaceUiCatalog } from '@gitspace/protocol/gitspace-ui';
import { Badge, badgeColors } from '@gitspace/ui';
import { getSharedHighlighter, type ThemedToken } from '@pierre/diffs';
import { ChevronRight } from '@untitledui/icons';
import { useContext, useEffect, useState } from 'react';
import type { z } from 'zod';
import { useDarkScheme } from '../appearance.js';
import { ResourceNavigation } from '../ResourceNavigation.js';

type Props<K extends keyof typeof gitspaceUiCatalog.components> = z.output<(typeof gitspaceUiCatalog.components)[K]['props']>;

/** A repository file's address: `repo://` with each path segment encoded, pinned to a full commit id when given. */
function repoUri(path: string, commit: string | null | undefined): string {
  const pinned = commit && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit) ? `@${commit}` : '';
  return `repo://${path.split('/').map(encodeURIComponent).join('/')}${pinned}`;
}

/** A duration as a person reads it: 850 ms, 3.2 s, 2 min 5 s. */
function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

// ── CodeExcerpt ──

/** The highlighter's language for a file extension; a file whose extension is not here is drawn plain. */
const LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby', sql: 'sql', sh: 'shell', bash: 'shell',
  json: 'json', css: 'css', html: 'html', md: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'toml',
};

export function CodeExcerptView({ path, startLine, lines, commit, highlight, note }: Props<'CodeExcerpt'>) {
  const open = useContext(ResourceNavigation);
  const dark = useDarkScheme();
  const lang = LANGUAGES[path.split('.').at(-1)?.toLowerCase() ?? ''];
  const code = lines.join('\n');
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  useEffect(() => {
    if (!lang) return;
    let live = true;
    const theme = dark ? 'github-dark' : 'github-light';
    getSharedHighlighter({ themes: [theme], langs: [lang] })
      .then((highlighter) => { if (live) setTokens(highlighter.codeToTokens(code, { lang, theme }).tokens); })
      .catch(() => { if (live) setTokens(null); });
    return () => { live = false; };
  }, [code, lang, dark]);
  const marked = new Set(highlight ?? []);
  const last = startLine + lines.length - 1;
  const label = `${path}:${startLine}${last > startLine ? `–${last}` : ''}`;
  return <figure className="overflow-hidden rounded-lg bg-surface-1 shadow-surface-1">
    <figcaption className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-[11.5px] text-muted-foreground">
      {/* Opens the file from the excerpt's first line, at the excerpt's commit when it has one. */}
      {open ? <button type="button" className="truncate text-left hover:text-foreground hover:underline" title={`Open ${path} in the Inspector`} onClick={() => open({ uri: `${repoUri(path, commit)}:${startLine}-` })}>{label}</button> : <span className="truncate">{label}</span>}
      {commit ? <span className="ml-auto shrink-0">{commit.slice(0, 7)}</span> : null}
    </figcaption>
    <div className="overflow-x-auto py-1 font-mono text-[12px] leading-[20px]">
      {lines.map((line, index) => {
        const number = startLine + index;
        const lineTokens = tokens?.[index];
        return <div key={index} data-line={number} className="flex min-w-max whitespace-pre pr-3" style={marked.has(number) ? { background: `color-mix(in oklab, ${badgeColors.amber} 16%, transparent)`, boxShadow: `inset 2px 0 0 ${badgeColors.amber}` } : undefined}>
          <span className="w-12 shrink-0 select-none pr-3 text-right text-muted-foreground/70">{number}</span>
          {lineTokens ? <span>{lineTokens.map((token, tokenIndex) => <span key={tokenIndex} style={{ color: token.color, fontStyle: token.fontStyle === 1 ? 'italic' : undefined }}>{token.content}</span>)}</span> : <span className="text-foreground">{line}</span>}
        </div>;
      })}
    </div>
    {note ? <p className="border-t border-border px-3 py-1.5 text-caption text-muted-foreground">{note}</p> : null}
  </figure>;
}

// ── CommandRun ──

export function CommandRunView({ command, exitCode, durationMs, output, truncated, jobId, cwd }: Props<'CommandRun'>) {
  const [shown, setShown] = useState(false);
  const lineCount = output === '' ? 0 : output.split('\n').length;
  return <figure className="overflow-hidden rounded-lg bg-surface-1 shadow-surface-1">
    <figcaption className="flex flex-wrap items-center gap-2 px-3 py-2">
      <Badge size="compact" variant="dot" color={exitCode === 0 ? 'green' : 'red'}>{exitCode === 0 ? 'passed' : `failed · exit ${exitCode}`}</Badge>
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={command}>{command}</code>
      <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{duration(durationMs)}</span>
    </figcaption>
    {cwd || jobId ? <p className="px-3 pb-1.5 font-mono text-[11px] text-muted-foreground">{[cwd ? `in ${cwd}` : null, jobId].filter(Boolean).join(' · ')}</p> : null}
    {lineCount > 0 ? <>
      <button type="button" aria-expanded={shown} className="flex w-full items-center gap-1 border-t border-border px-3 py-1 text-caption text-muted-foreground hover:text-foreground" onClick={() => setShown(!shown)}>
        <ChevronRight width={13} height={13} className={shown ? 'rotate-90' : undefined} />{shown ? 'Hide output' : `Show output (${truncated ? 'last ' : ''}${lineCount} lines)`}
      </button>
      {shown ? <pre className="max-h-80 overflow-auto border-t border-border bg-surface-3 px-3 py-2 font-mono text-[11.5px] leading-[18px] text-foreground">{output}</pre> : null}
    </> : <p className="border-t border-border px-3 py-1 text-caption text-muted-foreground">No output</p>}
  </figure>;
}

// ── TestReport ──

export function TestReportView({ runner, passed, failed, skipped, durationMs, failures, flaky, note }: Props<'TestReport'>) {
  const counts = [
    { label: 'passed', value: passed, tone: badgeColors.green },
    { label: 'failed', value: failed, tone: badgeColors.red },
    { label: 'skipped', value: skipped, tone: 'var(--muted-foreground)' },
  ];
  const tone = failed === null ? 'var(--border)' : failed > 0 ? badgeColors.red : badgeColors.green;
  return <figure className="flex flex-col gap-2 overflow-hidden rounded-lg bg-surface-1 p-3 shadow-surface-1" style={{ boxShadow: `inset 3px 0 0 ${tone}` }}>
    <figcaption className="flex flex-wrap items-baseline gap-3">
      {counts.map((count) => <span key={count.label} className="flex items-baseline gap-1">
        <span className="text-title font-semibold tabular-nums" style={{ color: count.value ? count.tone : undefined }}>{count.value ?? '—'}</span>
        <span className="text-caption text-muted-foreground">{count.label}</span>
      </span>)}
      <span className="ml-auto text-caption text-muted-foreground">{[runner, durationMs === null || durationMs === undefined ? null : duration(durationMs)].filter(Boolean).join(' · ')}</span>
    </figcaption>
    {failures.length > 0 ? <ol className="flex flex-col gap-1.5">
      {failures.map((failure, index) => <li key={index} className="flex flex-col gap-0.5 rounded bg-surface-2 px-2 py-1.5">
        <span className="text-body font-medium text-foreground">{failure.name}</span>
        {failure.file ? <span className="font-mono text-[11px] text-muted-foreground">{failure.file}</span> : null}
        {failure.message ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-[18px]" style={{ color: badgeColors.red }}>{failure.message}</pre> : null}
      </li>)}
    </ol> : null}
    {flaky?.length ? <p className="flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground"><Badge size="compact" variant="dot" color="amber">flaky</Badge>{flaky.join(', ')}</p> : null}
    {note ? <p className="text-caption text-muted-foreground">{note}</p> : null}
  </figure>;
}

// ── ChangeSet ──

const STATUS: Record<Props<'ChangeSet'>['files'][number]['status'], { mark: string; tone: string }> = {
  added: { mark: 'A', tone: badgeColors.green }, modified: { mark: 'M', tone: badgeColors.amber }, deleted: { mark: 'D', tone: badgeColors.red },
  renamed: { mark: 'R', tone: badgeColors.blue }, conflicted: { mark: 'C', tone: badgeColors.red },
};

export function ChangeSetView({ base, head, files, groups }: Props<'ChangeSet'>) {
  const open = useContext(ResourceNavigation);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const grouped = new Set(groups?.flatMap((group) => group.paths) ?? []);
  const rest = files.filter((file) => !grouped.has(file.path)).map((file) => file.path);
  const areas = [...groups ?? [], ...rest.length > 0 ? [{ name: groups?.length ? 'Other' : 'Files', paths: rest }] : []];
  const total = (paths: readonly string[], key: 'added' | 'removed') => paths.reduce((sum, path) => sum + (byPath.get(path)?.[key] ?? 0), 0);
  const allPaths = files.map((file) => file.path);
  return <figure className="overflow-hidden rounded-lg bg-surface-1 shadow-surface-1">
    <figcaption className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-caption text-muted-foreground">
      <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
      <span className="tabular-nums" style={{ color: badgeColors.green }}>+{total(allPaths, 'added')}</span>
      <span className="tabular-nums" style={{ color: badgeColors.red }}>−{total(allPaths, 'removed')}</span>
      {base || head ? <span className="ml-auto font-mono text-[11px]">{base ?? '…'} → {head ?? 'working copy'}</span> : null}
    </figcaption>
    {areas.map((area) => <section key={area.name} className="py-1">
      <h4 className="flex items-center gap-2 px-3 py-0.5 text-[11px] font-semibold text-muted-foreground">
        <span className="font-mono">{area.name}</span>
        <span className="font-normal tabular-nums">+{total(area.paths, 'added')} −{total(area.paths, 'removed')}</span>
      </h4>
      <ul>{area.paths.flatMap((path) => {
        const file = byPath.get(path);
        if (!file) return [];
        const status = STATUS[file.status];
        const name = <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{path}</span>;
        return [<li key={path} className="flex items-center gap-2 px-3 py-0.5">
          <span className="w-3 shrink-0 text-center font-mono text-[11px] font-semibold" style={{ color: status.tone }} title={file.status}>{status.mark}</span>
          {/* Opens the file's diff in the Inspector. */}
          {open ? <button type="button" className="flex min-w-0 flex-1 text-left text-foreground hover:underline" title={`Open the diff of ${path}`} onClick={() => open({ uri: repoUri(path, null), diff: true })}>{name}</button> : name}
          {file.binary ? <span className="shrink-0 text-[11px] text-muted-foreground">binary</span> : <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span style={{ color: badgeColors.green }}>+{file.added}</span> <span style={{ color: badgeColors.red }}>−{file.removed}</span>
          </span>}
        </li>];
      })}</ul>
    </section>)}
  </figure>;
}
