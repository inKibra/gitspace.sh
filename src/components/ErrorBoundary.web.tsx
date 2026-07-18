/** @jsxImportSource react */
/**
 * Top-level error boundary (docs/REPORT-A-PROBLEM.md, stage 1).
 *
 * Without this, a render throw unmounts the whole tree to a blank page — the
 * exact "the app goes blank" symptom, with no trace. This catches the throw,
 * records it in the diagnostics ring, and shows a dark recovery panel with the
 * real message plus a "Report a problem" button (placed BEFORE Reload so the
 * user reports the crash evidence BEFORE a reload wipes the in-memory ring).
 *
 * The report path here is deliberately self-contained: it does NOT mount the
 * full ReportProblemDialog (which may depend on the crashed app context) and
 * does NOT use a backend RPC (unknown/down here). It captures the ring + DOM
 * snapshot synchronously and submits via relay → local. Everything is wrapped:
 * this is the last line of defense and must never itself throw.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { pushDiagnostic } from '../lib/client-diagnostics.web.js';
import { reportFromBrokenState } from '../lib/report-client.web.js';
import { relayHttpBase } from '../lib/relay-http.web.js';

interface Props {
  children: ReactNode;
  /** Optional label so the ring/panel names which surface failed. */
  surface?: string;
  /** Optional project context to attach to a report (usually unavailable here). */
  projectName?: string;
}
interface State {
  error: Error | null;
  reportPhase: 'idle' | 'sending' | 'done' | 'failed';
  reportMsg: string;
  note: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reportPhase: 'idle', reportMsg: '', note: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    pushDiagnostic({
      kind: 'react',
      message: error.message,
      detail: `${error.stack ?? ''}\n--- component stack ---${info.componentStack ?? ''}`,
      source: this.props.surface ?? 'app',
    });
    void import('../lib/analytics.web.js').then((a) => a.captureException(error, { surface: this.props.surface ?? 'app' }));
  }

  private handleReport = (): void => {
    // Wrap EVERYTHING — a throw from the report button would take down the very
    // panel meant to recover the crash. Capture happens synchronously inside
    // reportFromBrokenState (before any await), so the ring's react entry is
    // snapshotted before a reload can wipe it.
    try {
      this.setState({ reportPhase: 'sending', reportMsg: '' });
      const err = this.state.error;
      const note = this.state.note.trim()
        || `[auto] Render crash on ${this.props.surface ?? 'app'}: ${err?.message ?? 'unknown error'}`;
      let base: string | null = null;
      try { base = relayHttpBase(); } catch { base = null; }
      void reportFromBrokenState(note, { relayHttpBase: base, projectName: this.props.projectName })
        .then((outcome) => {
          const msg = outcome.via === 'local'
            ? `Report downloaded (${outcome.filename}) — send us the file.`
            : outcome.via === 'relay'
              ? 'Captured via relay — thank you.'
              : 'Report sent — thank you.';
          try { this.setState({ reportPhase: 'done', reportMsg: msg }); } catch { /* ignore */ }
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          try { this.setState({ reportPhase: 'failed', reportMsg: msg }); } catch { /* ignore */ }
        });
    } catch (e) {
      try {
        this.setState({ reportPhase: 'failed', reportMsg: e instanceof Error ? e.message : 'Could not start report.' });
      } catch { /* truly last resort — nothing else we can do */ }
    }
  };

  render(): ReactNode {
    const { error, reportPhase, reportMsg, note } = this.state;
    if (!error) return this.props.children;
    const sending = reportPhase === 'sending';
    const done = reportPhase === 'done';
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24,
        background: '#050505', color: '#ddd',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', textAlign: 'center',
      }}>
        <div style={{ fontSize: 15, color: '#fff' }}>GitSpace hit an error and stopped rendering.</div>
        <div style={{ fontSize: 12, color: '#9a9a9a', maxWidth: 560, wordBreak: 'break-word' }}>{error.message}</div>

        {done ? (
          <div data-testid="eb-report-result" style={{ fontSize: 12, color: '#8fd08f', maxWidth: 560 }}>{reportMsg}</div>
        ) : (
          <>
            <textarea
              value={note}
              onChange={(e) => { try { this.setState({ note: e.target.value }); } catch { /* ignore */ } }}
              placeholder="Optional: what were you doing when it broke?"
              rows={2}
              disabled={sending}
              style={{
                marginTop: 4, width: 'min(560px, 90vw)', resize: 'vertical', padding: '6px 8px',
                fontSize: 12, fontFamily: 'inherit', background: '#0a0a0a', color: '#ddd',
                border: '1px solid #333', outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
              {/* Report FIRST and most prominent — capture the crash BEFORE reload wipes the ring. */}
              <button
                type="button"
                data-testid="eb-report-button"
                onClick={this.handleReport}
                disabled={sending}
                style={{
                  padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: sending ? 'default' : 'pointer',
                  background: sending ? '#1a3a1a' : '#1f6f3f', color: '#fff', border: '1px solid #2f8f4f',
                  opacity: sending ? 0.7 : 1,
                }}
              >
                {sending ? 'Sending…' : 'Report a problem'}
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                style={{
                  padding: '5px 12px', fontSize: 12, cursor: 'pointer',
                  background: 'transparent', color: '#ddd', border: '1px solid #333',
                }}
              >
                Reload
              </button>
            </div>
            {reportPhase === 'failed' && (
              <div style={{ fontSize: 11, color: '#d08f8f', maxWidth: 560 }}>Couldn’t send: {reportMsg}</div>
            )}
          </>
        )}

        <div style={{ fontSize: 10, color: '#555', maxWidth: 560 }}>
          The error was recorded. Report it before reloading — a reload clears the recent-error log.
        </div>
      </div>
    );
  }
}
