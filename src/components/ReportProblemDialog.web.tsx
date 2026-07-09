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
import { submitProblemReport } from '../lib/report-client.web.js';
import { VERSION } from '../version.generated.js';

export function ReportProblemDialog({ onClose, report, projectName, onStartFix, relayHttpBase }: {
  onClose: () => void;
  /** Backend sink; undefined when no backend is connected. */
  report?: (note: string, clientBundle: unknown, opts?: { fileIssue?: boolean; projectName?: string }) => Promise<{ path: string; issueUrl?: string; issueNumber?: number }>;
  /** Project whose GitHub repo an issue would be filed against (enables the checkbox). */
  projectName?: string;
  /** 1-click: import the just-filed issue as a fix workspace (Loop 2). */
  onStartFix?: (issueNumber: number) => Promise<void>;
  /** Relay HTTP origin for the fallback POST when the main WS is wedged. */
  relayHttpBase?: string | null;
}): ReactElement {
  const [note, setNote] = useState('');
  const [fileIssue, setFileIssue] = useState<boolean>(Boolean(projectName));
  const [state, setState] = useState<'edit' | 'sending' | 'done' | 'error'>('edit');
  const [result, setResult] = useState<{ via?: 'daemon' | 'relay' | 'local'; path?: string; issueUrl?: string; issueNumber?: number; filename?: string; error?: string }>({});
  const [fixState, setFixState] = useState<'idle' | 'starting' | 'started'>('idle');

  const ring = useMemo(() => getDiagnosticsRing(), []);
  const clientBundle = useMemo(() => {
    // A snapshot of the rendered tree — the single most useful artifact for an
    // agent to reconstruct what the user was looking at. Capped; redacted
    // server-side (redactDeep) before anything is written or filed.
    let domSnapshot = '';
    try { domSnapshot = (document.getElementById('root')?.outerHTML ?? '').slice(0, 250_000); } catch { /* ignore */ }
    // Visible top-level surface hints (open tabs, active view) pulled from the
    // DOM so the report says WHERE the user was, not just the URL.
    let openTabs: string[] = [];
    try {
      openTabs = Array.from(document.querySelectorAll('[role="tab"], .dv-tab'))
        .map((el) => (el.textContent ?? '').trim()).filter(Boolean).slice(0, 40);
    } catch { /* ignore */ }
    return {
      version: VERSION,
      url: window.location.href,
      userAgent: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      ring,
      openTabs,
      domSnapshot,
      capturedAt: new Date().toISOString(),
      // PostHog session/replay link when analytics is on — lets the eventual
      // GitHub issue point at the exact recorded session.
      posthog: getSessionContext(),
    };
  }, [ring]);

  const submit = async (): Promise<void> => {
    setState('sending');
    try {
      // Resilient path: bounded RPC → relay POST → local save. Never hangs on
      // a wedged WS, never loses the report.
      const r = await submitProblemReport({
        note,
        clientBundle,
        opts: { fileIssue: fileIssue && Boolean(projectName), projectName },
        report,
        relayHttpBase,
      });
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
            <div className="mb-1 text-[var(--gs-success)]">
              {result.via === 'local' ? 'Report downloaded.' : result.via === 'relay' ? 'Report captured (via relay).' : 'Report saved.'}
            </div>
            {result.via === 'relay' && <div className="mb-1 text-[var(--gs-warning)]">The machine daemon didn’t respond, so the relay captured it from disk (server logs included).</div>}
            {result.via === 'local' && <div className="mb-1 text-[var(--gs-warning)]">Couldn’t reach the machine or relay — the report was downloaded to your device so it isn’t lost. Send us the file, or retry when you’re reconnected.</div>}
            {result.issueUrl
              ? <div className="mb-1">GitHub issue: <a href={result.issueUrl} target="_blank" rel="noreferrer" className="underline text-[var(--gs-info)]">{result.issueUrl}</a></div>
              : result.via === 'daemon' && fileIssue && projectName && <div className="mb-1 text-[var(--gs-warning)]">Saved locally — couldn't file a GitHub issue (no repo/auth for {projectName}).</div>}
            <div className="font-[family-name:var(--gs-font-mono)] text-[11px] break-all text-[var(--gs-text-dim)]">{result.path ?? result.filename}</div>
            <div className="mt-3 flex items-center gap-2">
              {result.issueNumber !== undefined && onStartFix && fixState !== 'started' && (
                <button
                  type="button"
                  disabled={fixState === 'starting'}
                  onClick={() => { setFixState('starting'); void onStartFix(result.issueNumber!).then(() => setFixState('started')).catch(() => setFixState('idle')); }}
                  className="border border-[var(--gs-border-active)] bg-[var(--gs-bg-active)] px-2.5 py-[3px] text-[11px] text-[var(--gs-text)] disabled:opacity-40"
                >
                  {fixState === 'starting' ? 'Starting…' : `Start a fix workspace for #${result.issueNumber}`}
                </button>
              )}
              {fixState === 'started' && <span className="text-[11px] text-[var(--gs-success)]">Fix workspace created — find it on the board.</span>}
              <button type="button" onClick={onClose} className="ml-auto border border-[var(--gs-border)] px-2 py-[3px] text-[11px] hover:bg-[var(--gs-bg-active)]">Close</button>
            </div>
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
            {projectName && (
              <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--gs-text-muted)]">
                <input type="checkbox" checked={fileIssue} onChange={(e) => setFileIssue(e.target.checked)} />
                Also file a GitHub issue in <span className="font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]">{projectName}</span>’s repo
              </label>
            )}
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
