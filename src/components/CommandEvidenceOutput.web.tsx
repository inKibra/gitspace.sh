/** @jsxImportSource react */
import { useMemo, useState, type ReactElement } from 'react';

/**
 * CommandEvidenceOutput — merged, stream-labeled stdout/stderr view for
 * command evidence. Core captures up to 32KB per stream plus exitCode
 * (src/core/goal-validation.ts); this renders BOTH streams with the
 * dominant one first (`bun test` writes its whole report to STDERR), a
 * tail preview when collapsed (test summaries print at the END), and an
 * expand affordance that reveals the full captured text. The core's
 * '...[truncated N chars]' marker renders as-is inside the stream text.
 *
 * Used by ReviewRubric (evidence cards) and GoalDetailPanel (requirements
 * tab evidence view); `variant` matches each pane's styling idiom.
 */

const PREVIEW_TAIL_LINES = 8;

interface Stream {
  label: 'stdout' | 'stderr';
  text: string;
  lines: number;
}

/** Non-empty streams, dominant first: stderr leads when stdout is empty,
 *  or stdout is tiny (< 3 lines) while stderr is longer. */
export function orderStreams(stdout: string, stderr: string): Stream[] {
  const so = stdout.trimEnd();
  const se = stderr.trimEnd();
  const soLines = so === '' ? 0 : so.split('\n').length;
  const seLines = se === '' ? 0 : se.split('\n').length;
  const streams: Stream[] = [];
  if (so !== '') streams.push({ label: 'stdout', text: so, lines: soLines });
  if (se !== '') streams.push({ label: 'stderr', text: se, lines: seLines });
  const stderrLeads = se !== '' && (so === '' || (soLines < 3 && seLines > soLines));
  if (stderrLeads) streams.reverse();
  return streams;
}

function tailOf(text: string, lines: number): { tail: string; hidden: number } {
  const all = text.split('\n');
  if (all.length <= lines) return { tail: text, hidden: 0 };
  return { tail: all.slice(all.length - lines).join('\n'), hidden: all.length - lines };
}

function ExitChip({ exitCode }: { exitCode: number }): ReactElement {
  return (
    <span className={`inline-flex flex-shrink-0 items-center rounded-[var(--gs-chip-radius)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide font-[family-name:var(--gs-font-mono)] ${
      exitCode === 0 ? 'bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]' : 'bg-[var(--gs-chip-red-bg)] text-[var(--gs-chip-red-text)]'
    }`}>
      exit {exitCode}
    </span>
  );
}

export function CommandEvidenceOutput({ command, stdout, stderr, exitCode, variant }: {
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** 'rubric' = square/black (ReviewRubric idiom); 'detail' = rounded card (GoalDetailPanel idiom). */
  variant: 'rubric' | 'detail';
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const streams = useMemo(() => orderStreams(stdout ?? '', stderr ?? ''), [stdout, stderr]);
  const lead = streams[0];
  const rest = streams.slice(1);
  const preview = lead ? tailOf(lead.text, PREVIEW_TAIL_LINES) : null;
  const collapsible = Boolean(preview && (preview.hidden > 0 || rest.length > 0));

  const copyAll = () => {
    const combined = [
      command ? `$ ${command}` : null,
      ...streams.map((s) => `── ${s.label} ──\n${s.text}`),
      typeof exitCode === 'number' ? `(exit ${exitCode})` : null,
    ].filter(Boolean).join('\n');
    void navigator.clipboard?.writeText(combined).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => undefined);
  };

  const rounded = variant === 'detail' ? 'rounded-[var(--gs-card-radius)] overflow-hidden' : '';
  const mono = 'font-[family-name:var(--gs-font-mono)]';
  const preCls = `m-0 whitespace-pre-wrap break-words px-2.5 pb-2 text-[11px] leading-[1.6] text-[var(--gs-text)] ${mono}`;
  const labelCls = `px-2.5 pt-2 text-[9px] uppercase tracking-[0.08em] text-[var(--gs-text-ghost)] ${mono}`;

  const streamLabel = (s: Stream): ReactElement => (
    <div className={labelCls}>
      {s.label} <span className="normal-case tracking-normal">· {s.lines} {s.lines === 1 ? 'line' : 'lines'}</span>
    </div>
  );

  return (
    <div className={`border border-[var(--gs-border)] bg-black ${rounded}`}>
      {/* command + exit chip + copy — mirrors the rubric's CommandRow header */}
      <div className="flex items-start gap-2 border-b border-[var(--gs-border-muted)] px-2.5 py-1.5">
        <code className={`min-w-0 flex-1 whitespace-pre-wrap break-all text-[11px] leading-[1.5] text-[var(--gs-text)] ${mono}`}>
          {command ? `$ ${command}` : '(command output)'}
        </code>
        {typeof exitCode === 'number' && <ExitChip exitCode={exitCode} />}
        <button
          type="button"
          onClick={copyAll}
          title="Copy full combined output"
          className="flex-shrink-0 border border-[var(--gs-border)] px-1.5 py-px text-[10px] text-[var(--gs-text-dim)] transition-[border-color,color] duration-150 hover:border-[var(--gs-border-active)] hover:text-[var(--gs-text)]"
        >
          {copied ? '✓ copied' : '⧉ copy'}
        </button>
      </div>

      {streams.length === 0 ? (
        <div className={`px-2.5 py-2 text-[11px] italic text-[var(--gs-text-ghost)] ${mono}`}>(no output captured)</div>
      ) : expanded ? (
        <>
          <div className="max-h-[320px] overflow-auto">
            {streams.map((s) => (
              <div key={s.label}>
                {streamLabel(s)}
                <pre className={preCls}>{s.text}</pre>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="block w-full border-t border-[var(--gs-border-muted)] px-2.5 py-1 text-left text-[10px] text-[var(--gs-text-dim)] transition-[color] duration-150 hover:text-[var(--gs-text)]"
          >
            ▾ collapse
          </button>
        </>
      ) : (
        <>
          {lead && streamLabel(lead)}
          {preview && preview.hidden > 0 && (
            <div className={`px-2.5 pt-1 text-[10px] text-[var(--gs-text-ghost)] ${mono}`}>… {preview.hidden} earlier {preview.hidden === 1 ? 'line' : 'lines'}</div>
          )}
          {preview && <pre className={preCls}>{preview.tail}</pre>}
          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="block w-full border-t border-[var(--gs-border-muted)] px-2.5 py-1 text-left text-[10px] text-[var(--gs-text-dim)] transition-[color] duration-150 hover:text-[var(--gs-text)]"
            >
              ▸ expand full output
              {preview && preview.hidden > 0 ? ` · ${preview.hidden} more ${preview.hidden === 1 ? 'line' : 'lines'} of ${lead!.label}` : ''}
              {rest.length > 0 ? ` · + ${rest.map((s) => `${s.label} (${s.lines})`).join(', ')}` : ''}
            </button>
          )}
        </>
      )}
    </div>
  );
}
