/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { PatchDiff } from '@pierre/diffs/react';
import type { SessionBackend } from '../session/backend.js';
import type { ReviewChangedFile } from '../types/review.js';

/**
 * ChangeGuidePane — the '⛓ Change Guide' review dock pane (mock: stages/ReviewStage.tsx).
 * Scrollytelling PR walkthrough: fixed left timeline (scroll-spy via IntersectionObserver),
 * right column of narrative sections with real per-file diffs, mark-complete progress and
 * a progress-gated Approve · n/m foot action.
 *
 * Walkthrough steps are derived from get_changed_files grouped by top-level directory —
 * a heuristic stand-in for an agent-authored guide. Swap `buildWalkSteps` for a richer
 * guide source (e.g. a persisted walkthrough artifact) without touching the rendering.
 */

/* ── Walkthrough step model + derivation ───────────────────────────────────── */

export interface WalkStepFile {
  path: string;
  prevPath?: string;
  changeType: ReviewChangedFile['changeType'];
}

export interface WalkStepComment {
  who: string;
  tone: 'pass' | 'fail' | 'info' | 'warn';
  text: string;
}

export interface WalkStep {
  n: number;
  /** Short uppercase phase label (e.g. 'core', 'docs', 'tests') */
  kind: string;
  title: string;
  /** Narrative: what this phase of the change is */
  what: string;
  /** Narrative: why it matters for the reviewer */
  why: string;
  files: WalkStepFile[];
  /** Optional reviewer comment thread closing the section (mock: ReviewStage .thread). */
  comment?: WalkStepComment;
}

const ROOT_GROUP = '(root)';

/** Tone → who-line color for section comment threads (mock styles.css .thread .who.*). */
const THREAD_TONE: Record<WalkStepComment['tone'], string> = {
  pass: 'text-[var(--gs-accent)]',
  fail: 'text-[var(--gs-danger)]',
  info: 'text-[var(--gs-info)]',
  warn: 'text-[var(--gs-warning)]',
};

function topLevelDir(path: string): string {
  const idx = path.indexOf('/');
  return idx === -1 ? ROOT_GROUP : path.slice(0, idx);
}

function kindForGroup(dir: string): string {
  const d = dir.toLowerCase();
  if (dir === ROOT_GROUP) return 'config';
  if (d === 'docs' || d === 'doc') return 'docs';
  if (d === 'test' || d === 'tests' || d === '__tests__' || d === 'e2e') return 'tests';
  if (d === 'web' || d === 'app' || d === 'ui') return 'surface';
  if (d === 'src' || d === 'lib' || d === 'core') return 'core';
  if (d === 'scripts' || d === 'tools' || d === 'bin') return 'tooling';
  return 'change';
}

const CHANGE_WORD: Record<ReviewChangedFile['changeType'], string> = {
  new: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  modified: 'modified',
};

/**
 * Heuristic guide: group changed files into phases by top-level directory.
 * Replaceable by an agent-authored WalkStep[] source later — keep the shape stable.
 */
export function buildWalkSteps(files: ReviewChangedFile[]): WalkStep[] {
  const groups = new Map<string, WalkStepFile[]>();
  for (const f of files) {
    const dir = topLevelDir(f.filePath);
    const list = groups.get(dir) ?? [];
    list.push({ path: f.filePath, prevPath: f.prevFilePath, changeType: f.changeType });
    groups.set(dir, list);
  }
  const dirs = [...groups.keys()].sort((a, b) => {
    if (a === ROOT_GROUP) return 1;
    if (b === ROOT_GROUP) return -1;
    return a.localeCompare(b);
  });
  return dirs.map((dir, i) => {
    const stepFiles = [...(groups.get(dir) ?? [])].sort((a, b) => a.path.localeCompare(b.path));
    const counts = new Map<string, number>();
    for (const f of stepFiles) counts.set(CHANGE_WORD[f.changeType], (counts.get(CHANGE_WORD[f.changeType]) ?? 0) + 1);
    const breakdown = [...counts.entries()].map(([word, n]) => `${n} ${word}`).join(', ');
    const surface = dir === ROOT_GROUP ? 'the repository root' : `${dir}/`;
    return {
      n: i + 1,
      kind: kindForGroup(dir),
      title: dir === ROOT_GROUP ? 'Repository root' : `${dir}/`,
      what: `${stepFiles.length} file${stepFiles.length === 1 ? '' : 's'} changed under ${surface} — ${breakdown}.`,
      why: `These files share the ${surface} surface and land together as one phase of the change; review them as a unit before moving on.`,
      files: stepFiles,
    };
  });
}

/* ── Per-file diff block (lazy fetch via get_file_diff, rendered with PatchDiff) ── */

function FileDiffBlock({ backend, projectName, workspaceName, file, onOpenFile }: {
  backend: SessionBackend | null;
  projectName: string;
  workspaceName: string;
  file: WalkStepFile;
  onOpenFile?: (path: string) => void;
}): ReactElement {
  const [patch, setPatch] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    setState('loading');
    setPatch(null);
    if (!backend?.sendReviewRequest) { setState('error'); return; }
    void backend
      .sendReviewRequest({ op: 'get_file_diff', projectName, workspaceName, filePath: file.path, prevFilePath: file.prevPath })
      .then((r) => {
        if (!alive) return;
        const text = r.op === 'file_diff' ? r.diff : null;
        if (text && text.trim()) { setPatch(text); setState('ready'); }
        else setState('empty');
      })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [backend, projectName, workspaceName, file.path, file.prevPath]);

  return (
    <div className="border border-[var(--gs-border)]">
      <button
        type="button"
        onClick={() => onOpenFile?.(file.path)}
        title={onOpenFile ? `Open ${file.path}` : file.path}
        className="flex w-full items-center gap-2 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2.5 py-[5px] text-left font-[family-name:var(--gs-font-mono)] text-[10.5px] text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]"
      >
        <span className="min-w-0 flex-1 truncate">
          {file.path}
          {file.changeType !== 'modified' && (
            <span className="ml-2 lowercase text-[var(--gs-text-dim)]">({file.changeType})</span>
          )}
        </span>
      </button>
      <div
        className="overflow-x-auto"
        style={{
          '--diffs-dark-bg': '#000000',
          '--diffs-addition-color-override': 'rgb(0, 255, 102)',
          '--diffs-fg-number-override': 'var(--gs-text-ghost)',
          '--diffs-font-size': '11.5px',
          '--diffs-line-height': '18px',
          '--diffs-font-family': 'var(--gs-font-mono)',
        } as CSSProperties}
      >
        {state === 'loading' ? (
          <div className="px-2 py-2 text-[11px] text-[var(--gs-text-dim)]">Loading diff…</div>
        ) : state === 'error' ? (
          <div className="px-2 py-2 text-[11px] text-[var(--gs-danger)]">Failed to load diff for {file.path}</div>
        ) : state === 'empty' ? (
          <div className="px-2 py-2 text-[11px] text-[var(--gs-text-dim)]">No textual diff (binary or unchanged content).</div>
        ) : patch ? (
          <PatchDiff patch={patch} options={{ diffStyle: 'unified', theme: 'pierre-dark' }} />
        ) : null}
      </div>
    </div>
  );
}

/* ── The pane ──────────────────────────────────────────────────────────────── */

export function ChangeGuidePane({ backend, projectName, workspaceName, onOpenFile, onApprove, onOpenRubric, humanGatePending = 0 }: {
  backend: SessionBackend | null;
  projectName: string;
  workspaceName: string;
  onOpenFile?: (path: string) => void;
  onApprove?: () => void;
  /** Opens the Review rubric pane (mock: foot '☰ Review rubric' → open('rubric')). */
  onOpenRubric?: () => void;
  /** Required human-gated requirements still awaiting a verdict — Approve is
   *  blocked until 0 (mock: review-gated approval owned by the human). */
  humanGatePending?: number;
}): ReactElement {
  const [steps, setSteps] = useState<WalkStep[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [active, setActive] = useState(0);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [reloadTick, setReloadTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const secRefs = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    let alive = true;
    setLoadState('loading');
    setDone(new Set());
    setActive(0);
    if (!backend?.sendReviewRequest) { setLoadState('error'); return; }
    void backend
      .sendReviewRequest({ op: 'get_changed_files', projectName, workspaceName })
      .then((r) => {
        if (!alive) return;
        if (r.op !== 'changed_files') { setLoadState('error'); return; }
        secRefs.current = [];
        setSteps(buildWalkSteps(r.files));
        setLoadState('ready');
      })
      .catch(() => { if (alive) setLoadState('error'); });
    return () => { alive = false; };
  }, [backend, projectName, workspaceName, reloadTick]);

  /* Scroll-spy: IntersectionObserver on sections drives the active timeline step.
     Active = last section whose top sits above a line 72px into the scroll viewport;
     snap to the last step when scrolled to the bottom. */
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || steps.length === 0) return;
    const recompute = (): void => {
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) { setActive(steps.length - 1); return; }
      const line = root.getBoundingClientRect().top + 72;
      let idx = 0;
      secRefs.current.forEach((el, i) => { if (el && el.getBoundingClientRect().top <= line) idx = i; });
      setActive(idx);
    };
    const io = new IntersectionObserver(recompute, { root, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
    for (const el of secRefs.current) { if (el) io.observe(el); }
    recompute();
    return () => io.disconnect();
  }, [steps]);

  const go = useCallback((i: number): void => {
    secRefs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const toggleDone = useCallback((i: number): void => {
    setDone((d) => {
      const next = new Set(d);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  const total = steps.length;
  const completed = done.size;
  const allDone = total > 0 && completed === total;
  const activeStep = steps[active];

  if (loadState === 'loading') {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center bg-[var(--gs-bg)] text-[12px] text-[var(--gs-text-dim)]">
        Loading changed files…
      </div>
    );
  }
  if (loadState === 'error') {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-[var(--gs-bg)] text-[12px]">
        <span className="text-[var(--gs-danger)]">Failed to load the change guide.</span>
        <button
          type="button"
          onClick={() => setReloadTick((t) => t + 1)}
          className="border border-[var(--gs-border)] px-2 py-0.5 text-[11px] text-[var(--gs-text-muted)] hover:border-[var(--gs-border-active)] hover:text-[var(--gs-text)]"
        >
          Retry
        </button>
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center bg-[var(--gs-bg)] text-[12px] text-[var(--gs-text-dim)]">
        No changed files — nothing to walk through.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-[var(--gs-bg)] text-[var(--gs-text)]">
      {/* LEFT — fixed timeline column */}
      <div className="flex w-[300px] flex-shrink-0 flex-col border-r border-[var(--gs-border)] bg-[#050505]">
        <div className="flex-shrink-0 border-b border-[var(--gs-border)] px-3.5 py-3">
          <div className="text-[12px] font-medium text-[var(--gs-text)]">Change Guide · the PR as a story</div>
        </div>

        <div className="relative max-h-[55%] flex-shrink-0 overflow-y-auto py-2">
          <div className="pointer-events-none absolute bottom-2 left-[22px] top-2 w-px bg-[var(--gs-border)]" />
          {steps.map((s, i) => {
            const isActive = active === i;
            const isDone = done.has(i);
            return (
              <button
                key={s.n}
                type="button"
                onClick={() => go(i)}
                className={`relative flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-[11.5px] transition-colors duration-[120ms] ${
                  isActive ? 'text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]'
                }`}
              >
                <span
                  className={`h-[9px] w-[9px] flex-shrink-0 rounded-full border-2 transition-colors duration-[120ms] ${
                    isDone
                      ? 'border-[var(--gs-success)] bg-[var(--gs-success)]'
                      : isActive
                        ? 'border-[var(--gs-accent)] bg-[var(--gs-accent)] shadow-[0_0_10px_var(--gs-accent)]'
                        : 'border-[var(--gs-border-active)] bg-[var(--gs-bg)]'
                  }`}
                />
                <span className={`w-4 flex-shrink-0 text-right font-[family-name:var(--gs-font-mono)] text-[10px] tabular-nums ${isDone ? 'text-[var(--gs-success)]' : isActive ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text-dim)]'}`}>
                  {isDone ? '✓' : s.n}
                </span>
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
              </button>
            );
          })}
        </div>

        <div className="flex-shrink-0 px-3.5 py-1.5 text-[10px] tabular-nums text-[var(--gs-text-dim)]">
          {completed} / {total} phases reviewed
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--gs-border)] p-3.5">
          {activeStep && (
            <>
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-[var(--gs-text-dim)]">{activeStep.kind}</div>
              <p className="mt-2 text-[12.5px] leading-[1.55] text-[var(--gs-text)]">{activeStep.what}</p>
              <p className="mt-2 text-[11.5px] leading-[1.55] text-[var(--gs-text-muted)]">
                <span className="mr-1.5 uppercase text-[10px] tracking-[0.1em] text-[var(--gs-accent)]">why</span>
                {activeStep.why}
              </p>
            </>
          )}
        </div>

        {/* Foot bar — rubric shortcut + human-gate owned approval (mock ReviewStage rg-foot) */}
        <div className="flex flex-shrink-0 items-center gap-[7px] border-t border-[var(--gs-border)] px-3.5 py-2.5">
          <button
            type="button"
            onClick={() => onOpenRubric?.()}
            className="border border-[var(--gs-border)] px-2 py-[3px] text-[11px] text-[var(--gs-text-muted)] transition-colors duration-[120ms] hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)] active:scale-[.96]"
          >
            ☰ Review rubric
          </button>
          <button
            type="button"
            disabled={!allDone || humanGatePending > 0}
            onClick={() => { if (allDone && humanGatePending === 0) onApprove?.(); }}
            title={humanGatePending > 0 ? `${humanGatePending} human gate${humanGatePending === 1 ? '' : 's'} pending in the rubric` : undefined}
            className={`ml-auto whitespace-nowrap border border-[var(--gs-accent)] bg-[var(--gs-accent)] px-2 py-[3px] text-[11px] font-medium tabular-nums text-[var(--gs-text-on-accent)] transition-colors duration-[120ms] ${
              allDone && humanGatePending === 0
                ? 'hover:bg-[var(--gs-accent-hover)] active:scale-[.96]'
                : 'cursor-not-allowed opacity-40'
            }`}
          >
            {allDone && humanGatePending === 0 ? 'Approve' : `Approve · ${completed}/${total}`}
          </button>
        </div>
      </div>

      {/* RIGHT — scrolling walkthrough sections */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4">
        {steps.map((s, i) => {
          const isDone = done.has(i);
          return (
            <section
              key={s.n}
              ref={(el) => { secRefs.current[i] = el; }}
              className={`mb-[18px] scroll-mt-[6px] border ${isDone ? 'border-[rgba(0,255,102,0.3)]' : 'border-[var(--gs-border)]'}`}
            >
              <div className={`flex items-center gap-2.5 border-b border-[var(--gs-border)] px-[11px] py-[9px] ${isDone ? 'bg-[rgba(0,255,102,0.05)]' : 'bg-[var(--gs-bg-elevated)]'}`}>
                <span
                  className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border font-[family-name:var(--gs-font-mono)] text-[10px] tabular-nums ${
                    isDone ? 'border-[var(--gs-success)] text-[var(--gs-success)]' : 'border-[var(--gs-border-active)] text-[var(--gs-text-muted)]'
                  }`}
                >
                  {isDone ? '✓' : s.n}
                </span>
                <span className="min-w-0 truncate text-[13px] font-medium text-[var(--gs-text)]">{s.title}</span>
                <span className="ml-auto flex-shrink-0 text-[10px] uppercase tracking-[0.06em] text-[var(--gs-text-dim)]">{s.kind}</span>
                <button
                  type="button"
                  onClick={() => toggleDone(i)}
                  className={`flex-shrink-0 whitespace-nowrap px-2 py-0.5 text-[10.5px] transition-transform duration-[120ms] active:scale-[.96] ${
                    isDone
                      ? 'border border-[var(--gs-success)] bg-[var(--gs-success)] text-[var(--gs-text-on-accent)]'
                      : 'border border-[var(--gs-border-active)] text-[var(--gs-text-muted)] hover:border-[var(--gs-text-muted)] hover:text-[var(--gs-text)]'
                  }`}
                >
                  {isDone ? '✓ Complete' : 'Mark complete'}
                </button>
              </div>
              <div className="flex flex-col gap-2.5 p-[11px]">
                {s.files.map((f) => (
                  <FileDiffBlock
                    key={f.path}
                    backend={backend}
                    projectName={projectName}
                    workspaceName={workspaceName}
                    file={f}
                    onOpenFile={onOpenFile}
                  />
                ))}
                {s.comment && (
                  <div className="border-l-2 border-[var(--gs-border-active)] bg-[#050505] px-[11px] py-2 text-[11.5px]">
                    <div className={`text-[10.5px] ${THREAD_TONE[s.comment.tone]}`}>◆ {s.comment.who}</div>
                    <div className="mt-[3px] text-[var(--gs-text-muted)]">{s.comment.text}</div>
                    {s.comment.tone === 'fail' && (
                      <div className="mt-2.5 flex w-fit gap-px border border-[var(--gs-border)] bg-[var(--gs-border)]">
                        <button type="button" className="bg-[var(--gs-accent)] px-3 py-1.5 text-[11px] text-[var(--gs-text-on-accent)] transition-colors duration-[100ms] hover:bg-[var(--gs-accent-hover)]">
                          ✦ Send to agent → fix
                        </button>
                        <button type="button" className="bg-[#000] px-3 py-1.5 text-[11px] text-[var(--gs-text-muted)] transition-colors duration-[100ms] hover:bg-[var(--gs-bg-elevated)] hover:text-[var(--gs-text)]">
                          Comment
                        </button>
                        <button type="button" className="bg-[#000] px-3 py-1.5 text-[11px] text-[var(--gs-text-muted)] transition-colors duration-[100ms] hover:bg-[var(--gs-bg-elevated)] hover:text-[var(--gs-danger)]">
                          Dismiss
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
