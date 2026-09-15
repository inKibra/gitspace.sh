import { isLifecycleRunActive, lifecycleExecutionOutcome, LifecycleLogReader, type LifecycleRun, type LifecycleRunLog } from '@gitspace/protocol-environment';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@gitspace/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface LifecycleLogDialogProps {
  run: LifecycleRun;
  script: { id: string; label: string };
  /** Accepted environment stream revision; never a polling timer. */
  revision: number;
  loadPage(runId: string, offset: number, signal: AbortSignal): Promise<LifecycleRunLog>;
  onClose(): void;
}

export function LifecycleLogDialog({ run, script, revision, loadPage, onClose }: LifecycleLogDialogProps) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent size="sm">
      <DialogHeader><DialogTitle>{script.label} log</DialogTitle><DialogDescription>{run.phase} · run {run.id}. Output and exit status belong only to this script.</DialogDescription></DialogHeader>
      <ScriptLog key={`${run.id}:${script.id}`} run={run} script={script} revision={revision} loadPage={loadPage} onClose={onClose} />
    </DialogContent>
  </Dialog>;
}

function ScriptLog({ run, script, revision, loadPage, onClose }: LifecycleLogDialogProps) {
  const [, render] = useState(0);
  const [copying, setCopying] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const viewport = useRef<HTMLPreElement>(null);
  const current = useRef({ run, revision, loadPage });
  current.current = { run, revision, loadPage };
  const session = useRef({
    reader: new LifecycleLogReader({ selectedId: script.id }), cursor: 0, exhausted: false,
    readRevision: -1, pending: null as Promise<void> | null, controller: null as AbortController | null,
    error: null as string | null, disposed: false,
  });
  const refresh = useCallback(() => render((value) => value + 1), []);
  const loadMore = useCallback((): Promise<void> => {
    const state = session.current;
    if (state.pending) return state.pending;
    const step = state.reader.results.find((result) => result.id === script.id);
    if (state.disposed || step?.exitCode != null || state.exhausted && state.readRevision === current.current.revision) return Promise.resolve();
    const snapshot = current.current;
    const offset = state.cursor;
    const controller = new AbortController();
    state.controller = controller;
    state.error = null;
    state.pending = (async () => {
      try {
        const page = await snapshot.loadPage(snapshot.run.id, offset, controller.signal);
        if (controller.signal.aborted) return;
        if (!Number.isSafeInteger(page.cursor) || page.cursor < offset || (page.output.length > 0 || page.nextOffset !== null) && page.cursor <= offset || page.nextOffset !== null && page.nextOffset !== page.cursor) throw new Error('The log cursor did not advance safely. Close and reopen the log to retry.');
        state.reader.push(page.output, { final: page.nextOffset === null && !isLifecycleRunActive(snapshot.run) });
        state.cursor = page.cursor;
        state.exhausted = page.nextOffset === null;
        state.readRevision = snapshot.revision;
      } catch (error) {
        if (!controller.signal.aborted) state.error = error instanceof Error ? error.message : String(error);
      } finally {
        state.pending = null;
        if (!state.disposed) refresh();
      }
    })();
    refresh();
    return state.pending;
  }, [refresh, script.id]);
  useEffect(() => {
    const state = session.current;
    state.disposed = false;
    return () => { state.disposed = true; state.controller?.abort(); };
  }, []);
  const state = session.current;
  const decoded = state.reader.results.find((result) => result.id === script.id);
  const recorded = run.results.find((result) => result.id === script.id);
  const complete = decoded?.exitCode != null;
  const caughtUp = state.exhausted && state.readRevision === revision;
  const legacy = !decoded && caughtUp && !isLifecycleRunActive(run) && recorded;
  const output = decoded?.output ?? (legacy ? recorded.output : '');
  const outcome = recorded?.exitCode != null || !decoded ? lifecycleExecutionOutcome(run, script.id) : lifecycleExecutionOutcome({ ...run, results: [decoded] }, script.id);
  const exitCode = decoded?.exitCode ?? recorded?.exitCode;
  useEffect(() => {
    const element = viewport.current;
    if (!state.error && !copying && !complete && (!decoded || element && element.scrollHeight - element.scrollTop - element.clientHeight < 120)) void loadMore();
  }, [revision, state.cursor, state.exhausted, state.pending, complete, decoded, loadMore, copying, state.error]);
  const copy = async (): Promise<void> => {
    setCopying(true); setCopyError(null); setCopyStatus(null);
    try {
      // Finish this script, not the other scripts or an accidentally loaded preview.
      while (!session.current.disposed) {
        const next = session.current;
        const result = next.reader.results.find((entry) => entry.id === script.id);
        if (result?.exitCode != null || next.exhausted && next.readRevision === current.current.revision) break;
        await loadMore();
        if (next.error) throw new Error(next.error);
      }
      if (session.current.disposed) return;
      const result = session.current.reader.results.find((entry) => entry.id === script.id);
      if (!result) throw new Error(recorded ? 'This saved log has no script framing. Only a saved preview is available; select the preview text to copy it explicitly.' : 'This script has no recorded output to copy.');
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable. Use HTTPS or localhost, or select the displayed script output and copy it manually.');
      await navigator.clipboard.writeText(result.output);
      if (session.current.disposed) return;
      setCopyStatus(result.exitCode !== null ? 'Copied the complete script log.' : 'Copied all recorded output for this script so far; no script exit was recorded.');
    } catch (error) {
      setCopyError(`Copy failed: ${error instanceof Error ? error.message : String(error)} Check clipboard permission, or select the displayed output and copy manually.`);
    } finally { if (!session.current.disposed) setCopying(false); }
  };
  return <>
    <p className="break-all text-caption" role="status">{script.label} · {outcome === 'not-started' ? 'Not started' : outcome}{exitCode != null ? ` · exit ${exitCode}` : ' · no recorded exit'}{recorded?.startedAt ? ` · started ${new Date(recorded.startedAt).toLocaleString()}` : ''}{recorded?.finishedAt ? ` · ended ${new Date(recorded.finishedAt).toLocaleString()}` : ''}</p>
    <p className="text-caption text-muted-foreground">{legacy ? 'Saved script preview only: this older log has no recoverable script boundaries. The preview may be truncated.' : complete ? 'Complete script output.' : caughtUp ? 'All recorded output for this script is loaded. New output follows accepted run updates.' : 'Scroll down to load more. Copy loads all remaining output for this script first.'}</p>
    <pre ref={viewport} tabIndex={0} aria-label={`Output for ${script.label}`} aria-busy={state.pending !== null} onScroll={() => { const element = viewport.current; if (element && !state.error && element.scrollHeight - element.scrollTop - element.clientHeight < 120) void loadMore(); }} className="max-h-[45vh] min-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-caption [overflow-anchor:none]">{output || (state.pending ? 'Loading script output…' : 'No output recorded for this script.')}</pre>
    {state.pending ? <p role="status" className="text-caption text-muted-foreground">Loading script output…</p> : null}
    {state.error ? <p role="alert" className="text-caption text-destructive">{state.error}<Button variant="ghost" size="compact" onClick={() => void loadMore()}>Retry log</Button></p> : null}
    {copyStatus ? <p role="status" className="text-caption text-muted-foreground">{copyStatus}</p> : null}
    {copyError ? <p role="alert" className="text-caption text-destructive">{copyError}</p> : null}
    <DialogFooter><Button variant="secondary" onClick={onClose}>Close</Button><Button variant="primary" loading={copying} disabled={!!legacy || caughtUp && !decoded} onClick={() => void copy()}>Copy script log</Button></DialogFooter>
  </>;
}
