/** @jsxImportSource react */
/**
 * Report-a-problem dialog (docs/REPORT-A-PROBLEM.md, Loop 1).
 *
 * Collects the user's note, assembles the client diagnostic bundle (the error
 * ring + page context), and sends it to the daemon, which adds server context,
 * redacts everything, and writes a local report. Shows the resulting path.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { getDiagnosticsRing } from '../lib/client-diagnostics.web.js';
import { getSessionContext } from '../lib/analytics.web.js';
import { VERSION } from '../version.generated.js';

export function ReportProblemDialog({ onClose, report }: {
  onClose: () => void;
  /** Backend sink; undefined when no backend is connected. */
  report?: (note: string, clientBundle: unknown) => Promise<{ path: string; issueUrl?: string }>;
}): ReactElement {
  const [note, setNote] = useState('');
  const [state, setState] = useState<'edit' | 'sending' | 'done' | 'error'>('edit');
  const [result, setResult] = useState<{ path?: string; issueUrl?: string; error?: string }>({});

  const ring = useMemo(() => getDiagnosticsRing(), []);
  const clientBundle = useMemo(() => ({
    version: VERSION,
    url: window.location.href,
    userAgent: navigator.userAgent,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    ring,
    // PostHog session/replay link when analytics is on — lets the eventual
    // GitHub issue point at the exact recorded session.
    posthog: getSessionContext(),
  }), [ring]);

  const submit = async (): Promise<void> => {
    if (!report) { setState('error'); setResult({ error: 'No machine connected — cannot file a report right now.' }); return; }
    setState('sending');
    try {
      const r = await report(note, clientBundle);
      setResult(r); setState('done');
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) }); setState('error');
    }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="border border-[var(--gs-border)] bg-[#0a0a0a] text-[var(--gs-text)]"
        style={{ width: 520, maxWidth: '92vw', padding: 16 }}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[13px] font-semibold">Report a problem</span>
          <span className="ml-auto cursor-pointer text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]" onClick={onClose}>✕</span>
        </div>

        {state === 'done' ? (
          <div className="text-[12px] text-[var(--gs-text-muted)]">
            <div className="mb-1 text-[var(--gs-success)]">Report saved.</div>
            <div className="font-[family-name:var(--gs-font-mono)] text-[11px] break-all">{result.path}</div>
            {result.issueUrl && <div className="mt-1">Issue: <a href={result.issueUrl} className="underline">{result.issueUrl}</a></div>}
            <button type="button" onClick={onClose} className="mt-3 border border-[var(--gs-border)] px-2 py-[3px] text-[11px] hover:bg-[var(--gs-bg-active)]">Close</button>
          </div>
        ) : (
          <>
            <p className="mb-2 text-[11px] leading-[1.5] text-[var(--gs-text-dim)]">
              What went wrong? Recent client errors ({ring.length}), the current
              page, and server context are attached and <strong>redacted</strong>
              {' '}(tokens, home paths) before anything is written.
            </p>
            <textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. the transcript pane went blank after I switched workspaces"
              rows={4}
              className="w-full resize-y border border-[var(--gs-border)] bg-black px-2 py-1.5 text-[12px] text-[var(--gs-text)] outline-none focus:border-[var(--gs-border-active)]"
            />
            {state === 'error' && <div className="mt-2 text-[11px] text-[var(--gs-danger)]">{result.error}</div>}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={state === 'sending' || note.trim().length === 0}
                onClick={() => void submit()}
                className="border border-[var(--gs-border-active)] bg-[var(--gs-bg-active)] px-2.5 py-[3px] text-[11px] text-[var(--gs-text)] disabled:opacity-40"
              >
                {state === 'sending' ? 'Sending…' : 'Send report'}
              </button>
              <button type="button" onClick={onClose} className="px-2 py-[3px] text-[11px] text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]">Cancel</button>
              <span className="ml-auto text-[10px] text-[var(--gs-text-ghost)]">v{VERSION}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
