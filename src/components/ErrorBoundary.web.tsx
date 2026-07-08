/** @jsxImportSource react */
/**
 * Top-level error boundary (docs/REPORT-A-PROBLEM.md, stage 1).
 *
 * Without this, a render throw unmounts the whole tree to a blank page — the
 * exact "the app goes blank" symptom, with no trace. This catches the throw,
 * records it in the diagnostics ring, and shows a dark recovery panel with the
 * real message so the user can reload (and, later, report it in one click).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { pushDiagnostic } from '../lib/client-diagnostics.web.js';

interface Props {
  children: ReactNode;
  /** Optional label so the ring/panel names which surface failed. */
  surface?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
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

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24,
        background: '#050505', color: '#ddd',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', textAlign: 'center',
      }}>
        <div style={{ fontSize: 15, color: '#fff' }}>GitSpace hit an error and stopped rendering.</div>
        <div style={{ fontSize: 12, color: '#9a9a9a', maxWidth: 560, wordBreak: 'break-word' }}>{error.message}</div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: 4, padding: '5px 12px', fontSize: 12, cursor: 'pointer',
            background: 'transparent', color: '#ddd', border: '1px solid #333',
          }}
        >
          Reload
        </button>
        <div style={{ fontSize: 10, color: '#555', maxWidth: 560 }}>
          The error was recorded. A "report a problem" flow will let you send it with recent logs.
        </div>
      </div>
    );
  }
}
