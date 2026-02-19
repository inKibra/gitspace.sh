/** @jsxImportSource react */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { FileDiff } from '@pierre/diffs/react';
import {
  parsePatchFiles,
  type AnnotationSide,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type FileDiffOptions,
  type Hunk,
  type SelectedLineRange,
} from '@pierre/diffs';
import type { HunkDecision, ReviewChangedFile, ReviewThread, ThreadTarget } from '../types/review.js';

export interface DiffViewerProps {
  files: ReviewChangedFile[];
  threads: ReviewThread[];
  onCreateThread: (target: ThreadTarget, body: string, decision?: HunkDecision) => Promise<void>;
  onUpdateThread: (threadId: string, updates: { decision?: HunkDecision }) => Promise<void>;
  onRequestFileDiff: (filePath: string, prevFilePath?: string) => Promise<string>;
  onRequestFileContextRange: (
    filePath: string,
    prevFilePath?: string,
    range?: { oldStart?: number; oldEnd?: number; newStart?: number; newEnd?: number }
  ) => Promise<{
    oldStart: number;
    oldLines: string[];
    oldTotal: number;
    newStart: number;
    newLines: string[];
    newTotal: number;
  }>;
  onThreadClick?: (threadId: string) => void;
  onThreadHover?: (threadId: string | null) => void;
}

interface CommentFormState {
  target: ThreadTarget;
  decision?: HunkDecision;
}

interface HunkInfo {
  header: string;
  anchorSide: AnnotationSide;
  anchorLine: number;
}

interface LoadedFileDiff {
  fileDiff: FileDiffMetadata;
  hunks: HunkInfo[];
}

type FileDiffState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: LoadedFileDiff }
  | { status: 'error'; message: string };

type FileContextState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready';
      oldLines: string[];
      newLines: string[];
      oldTotal: number;
      newTotal: number;
      contextHash: string;
    }
  | { status: 'error'; message: string };

type InlineAnnotationMeta =
  | { kind: 'thread'; thread: ReviewThread }
  | {
      kind: 'hunk-control';
      hunkHeader: string;
      decision: HunkDecision;
      threadId?: string;
      commentCount: number;
    };

const CHANGE_COLOR: Record<ReviewChangedFile['changeType'], string> = {
  new: '#22c55e',
  deleted: '#f85149',
  renamed: '#d29922',
  modified: '#58a6ff',
};

const CHANGE_LABEL: Record<ReviewChangedFile['changeType'], string> = {
  new: 'A',
  deleted: 'D',
  renamed: 'R',
  modified: 'M',
};

export function DiffViewer({
  files,
  threads,
  onCreateThread,
  onUpdateThread,
  onRequestFileDiff,
  onRequestFileContextRange,
  onThreadClick,
  onThreadHover,
}: DiffViewerProps) {
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);
  const [fileDiffStateByKey, setFileDiffStateByKey] = useState<Record<string, FileDiffState>>({});
  const [contextStateByKey, setContextStateByKey] = useState<Record<string, FileContextState>>({});

  const [commentForm, setCommentForm] = useState<CommentFormState | null>(null);
  const [commentBody, setCommentBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const diffHostRef = useRef<HTMLDivElement | null>(null);
  const loadingFileDiffKeysRef = useRef<Set<string>>(new Set());

  const fileByKey = useMemo(() => {
    const map = new Map<string, ReviewChangedFile>();
    for (const file of files) {
      map.set(fileKey(file.filePath, file.prevFilePath), file);
    }
    return map;
  }, [files]);

  const selectedFile = useMemo(() => {
    if (selectedFileKey) {
      const match = fileByKey.get(selectedFileKey);
      if (match) {
        return match;
      }
    }
    return files[0] ?? null;
  }, [selectedFileKey, fileByKey, files]);

  const selectedKey = selectedFile ? fileKey(selectedFile.filePath, selectedFile.prevFilePath) : null;
  const selectedDiffState = selectedKey ? fileDiffStateByKey[selectedKey] ?? ({ status: 'idle' } as const) : null;
  const selectedContextState = selectedKey ? contextStateByKey[selectedKey] ?? ({ status: 'idle' } as const) : null;

  useEffect(() => {
    const valid = new Set(files.map((file) => fileKey(file.filePath, file.prevFilePath)));

    setFileDiffStateByKey((prev) => {
      const next: Record<string, FileDiffState> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (valid.has(key)) {
          next[key] = value;
        }
      }
      return next;
    });

    setContextStateByKey((prev) => {
      const next: Record<string, FileContextState> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (valid.has(key)) {
          next[key] = value;
        }
      }
      return next;
    });
  }, [files]);

  const loadFileDiff = useCallback(async (file: ReviewChangedFile) => {
    const key = fileKey(file.filePath, file.prevFilePath);

    const current = fileDiffStateByKey[key];
    if (current?.status === 'loading' || current?.status === 'ready') {
      return;
    }

    if (loadingFileDiffKeysRef.current.has(key)) {
      return;
    }

    loadingFileDiffKeysRef.current.add(key);

    setFileDiffStateByKey((prev) => {
      const existing = prev[key];
      if (existing?.status === 'loading' || existing?.status === 'ready') {
        return prev;
      }
      return { ...prev, [key]: { status: 'loading' } };
    });

    try {
      const diff = await onRequestFileDiff(file.filePath, file.prevFilePath);
      const parsed = parseSingleFileDiff(diff, file);
      setFileDiffStateByKey((prev) => ({
        ...prev,
        [key]: { status: 'ready', data: parsed },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileDiffStateByKey((prev) => ({
        ...prev,
        [key]: { status: 'error', message },
      }));
    } finally {
      loadingFileDiffKeysRef.current.delete(key);
    }
  }, [fileDiffStateByKey, onRequestFileDiff]);

  useEffect(() => {
    if (!selectedFile || !selectedKey) {
      return;
    }
    const state = fileDiffStateByKey[selectedKey] ?? { status: 'idle' as const };
    if (state.status === 'idle') {
      void loadFileDiff(selectedFile);
    }
  }, [selectedFile, selectedKey, fileDiffStateByKey, loadFileDiff]);

  const ensureContextLoaded = useCallback(async () => {
    if (!selectedFile || !selectedKey) {
      return;
    }

    const current = contextStateByKey[selectedKey] ?? { status: 'idle' as const };
    if (current.status === 'loading' || current.status === 'ready') {
      return;
    }

    setContextStateByKey((prev) => ({
      ...prev,
      [selectedKey]: { status: 'loading' },
    }));

    try {
      const context = await onRequestFileContextRange(
        selectedFile.filePath,
        selectedFile.prevFilePath
      );

      setContextStateByKey((prev) => ({
        ...prev,
        [selectedKey]: {
          status: 'ready',
          oldLines: expandToAbsoluteLines(context.oldLines, context.oldStart, context.oldTotal),
          newLines: expandToAbsoluteLines(context.newLines, context.newStart, context.newTotal),
          oldTotal: context.oldTotal,
          newTotal: context.newTotal,
          contextHash: `${context.oldTotal}:${context.newTotal}:${context.oldLines.length}:${context.newLines.length}`,
        },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setContextStateByKey((prev) => ({
        ...prev,
        [selectedKey]: { status: 'error', message },
      }));
    }
  }, [selectedFile, selectedKey, contextStateByKey, onRequestFileContextRange]);

  // On-demand expansion trigger: clicking line-info separators when context is
  // not loaded will load context first, then user can click again to expand.
  useEffect(() => {
    const host = diffHostRef.current;
    if (!host || !selectedKey) {
      return;
    }

    const onCaptureClick = (event: MouseEvent) => {
      const current = contextStateByKey[selectedKey] ?? { status: 'idle' as const };
      if (current.status === 'loading' || current.status === 'ready') {
        return;
      }

      const path = event.composedPath();
      const clickedSeparator = path.some((node) => {
        return node instanceof HTMLElement && (
          node.hasAttribute('data-unmodified-lines') ||
          node.hasAttribute('data-separator-content') ||
          node.getAttribute('data-separator') === 'line-info'
        );
      });

      if (!clickedSeparator) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void ensureContextLoaded();
    };

    host.addEventListener('click', onCaptureClick, true);
    return () => {
      host.removeEventListener('click', onCaptureClick, true);
    };
  }, [selectedKey, contextStateByKey, ensureContextLoaded]);

  const selectedLoadedDiff = selectedDiffState?.status === 'ready' ? selectedDiffState.data : null;
  const selectedContextReady = selectedContextState?.status === 'ready' ? selectedContextState : null;

  const hunkThreadByHeader = useMemo(() => {
    const map = new Map<string, ReviewThread>();
    if (!selectedFile) {
      return map;
    }

    for (const thread of threads) {
      if (thread.target.kind !== 'hunk') {
        continue;
      }
      if (thread.target.file !== selectedFile.filePath) {
        continue;
      }
      if (!map.has(thread.target.hunkHeader)) {
        map.set(thread.target.hunkHeader, thread);
      }
    }

    return map;
  }, [threads, selectedFile]);

  const lineAnnotations = useMemo((): DiffLineAnnotation<InlineAnnotationMeta>[] => {
    if (!selectedLoadedDiff || !selectedFile) {
      return [];
    }

    const annotations: DiffLineAnnotation<InlineAnnotationMeta>[] = [];

    for (const hunk of selectedLoadedDiff.hunks) {
      const existing = hunkThreadByHeader.get(hunk.header);
      annotations.push({
        side: hunk.anchorSide,
        lineNumber: hunk.anchorLine,
        metadata: {
          kind: 'hunk-control',
          hunkHeader: hunk.header,
          decision: existing?.decision ?? 'pending',
          threadId: existing?.id,
          commentCount: existing?.comments.length ?? 0,
        },
      });
    }

    for (const thread of threads) {
      if (thread.target.kind === 'line' && thread.target.file === selectedFile.filePath) {
        annotations.push({
          side: thread.target.side === 'LEFT' ? 'deletions' : 'additions',
          lineNumber: thread.target.startLine,
          metadata: { kind: 'thread', thread },
        });
      }
    }

    return annotations;
  }, [selectedLoadedDiff, selectedFile, hunkThreadByHeader, threads]);

  const handleSubmitComment = useCallback(async () => {
    if (!commentForm || !commentBody.trim()) {
      return;
    }

    setSubmitting(true);
    try {
      await onCreateThread(commentForm.target, commentBody.trim(), commentForm.decision);
      setCommentForm(null);
      setCommentBody('');
    } finally {
      setSubmitting(false);
    }
  }, [commentForm, commentBody, onCreateThread]);

  const setHunkDecision = useCallback(async (hunkHeader: string, decision: HunkDecision) => {
    if (!selectedFile) {
      return;
    }

    const existing = hunkThreadByHeader.get(hunkHeader);
    if (existing) {
      await onUpdateThread(existing.id, { decision });
      return;
    }

    if (decision === 'pending') {
      return;
    }

    await onCreateThread(
      { kind: 'hunk', file: selectedFile.filePath, hunkHeader },
      decision === 'approved'
        ? 'Approved hunk via inline controls.'
        : 'Rejected hunk via inline controls.',
      decision
    );
  }, [selectedFile, hunkThreadByHeader, onUpdateThread, onCreateThread]);

  const openHunkCommentForm = useCallback((hunkHeader: string) => {
    if (!selectedFile) {
      return;
    }
    setCommentForm({ target: { kind: 'hunk', file: selectedFile.filePath, hunkHeader } });
    setCommentBody('');
  }, [selectedFile]);

  const handleLineSelectionEnd = useCallback((range: SelectedLineRange | null) => {
    if (!range || !selectedFile) {
      return;
    }

    setCommentForm({
      target: {
        kind: 'line',
        file: selectedFile.filePath,
        startLine: Math.min(range.start, range.end),
        endLine: Math.max(range.start, range.end),
        side: (range.side ?? 'additions') === 'deletions' ? 'LEFT' : 'RIGHT',
      },
    });
    setCommentBody('');
  }, [selectedFile]);

  const renderHoverUtility = useCallback((
    getHoveredLine: () => { lineNumber: number; side: AnnotationSide } | undefined
  ) => {
    return (
      <button
        title="Add comment"
        onMouseDown={(event) => {
          event.preventDefault();
          const hovered = getHoveredLine();
          if (!hovered || !selectedFile) {
            return;
          }
          setCommentForm({
            target: {
              kind: 'line',
              file: selectedFile.filePath,
              startLine: hovered.lineNumber,
              endLine: hovered.lineNumber,
              side: hovered.side === 'deletions' ? 'LEFT' : 'RIGHT',
            },
          });
          setCommentBody('');
        }}
        style={{
          width: '20px',
          height: '20px',
          borderRadius: '999px',
          border: 'none',
          background: '#1a76d4',
          color: '#0d1117',
          cursor: 'pointer',
          fontSize: '14px',
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
        }}
      >
        +
      </button>
    );
  }, [selectedFile]);

  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<InlineAnnotationMeta>) => {
    const meta = annotation.metadata;

    if (meta.kind === 'thread') {
      const thread = meta.thread;
      const color = thread.decision ? decisionColor(thread.decision) : '#58a6ff';
      const count = thread.comments.length;

      return (
        <div style={{ position: 'relative', height: 0, overflow: 'visible', pointerEvents: 'none' }}>
          <button
            title={`Open thread (${count} comment${count === 1 ? '' : 's'})`}
            onClick={() => onThreadClick?.(thread.id)}
            onMouseEnter={() => onThreadHover?.(thread.id)}
            onMouseLeave={() => onThreadHover?.(null)}
            style={{
              position: 'absolute',
              top: '-9px',
              right: '8px',
              width: '16px',
              height: '16px',
              borderRadius: '999px',
              border: `1px solid ${color}66`,
              background: `${color}33`,
              color,
              cursor: 'pointer',
              fontSize: '10px',
              fontWeight: 700,
              lineHeight: 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'auto',
            }}
          >
            {count > 1 ? String(Math.min(count, 9)) : '•'}
          </button>
        </div>
      );
    }

    const tint = decisionColor(meta.decision);
    return (
      <div style={{ position: 'relative', zIndex: 10, height: 0, overflow: 'visible', pointerEvents: 'none' }}>
        <div
          style={{
            position: 'absolute',
            top: '4px',
            right: '28px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            pointerEvents: 'auto',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)',
            borderRadius: '4px',
            border: `1px solid ${tint}33`,
            background: '#161b22',
            padding: '1px',
          }}
          onMouseEnter={() => meta.threadId && onThreadHover?.(meta.threadId)}
          onMouseLeave={() => onThreadHover?.(null)}
        >
          <button
            title="Reject hunk"
            onClick={() => void setHunkDecision(meta.hunkHeader, 'rejected')}
            style={actionButtonStyle(meta.decision === 'rejected', '#f85149')}
          >
            Reject
          </button>
          <button
            title="Approve hunk"
            onClick={() => void setHunkDecision(meta.hunkHeader, 'approved')}
            style={actionButtonStyle(meta.decision === 'approved', '#22c55e', true)}
          >
            Approve
          </button>
          {!meta.threadId && (
            <button
              title="Comment on hunk"
              onClick={() => openHunkCommentForm(meta.hunkHeader)}
              style={actionButtonStyle(false, '#58a6ff')}
            >
              Comment
            </button>
          )}
        </div>
      </div>
    );
  }, [onThreadClick, onThreadHover, openHunkCommentForm, setHunkDecision]);

  const fileDiffOptions = useMemo((): FileDiffOptions<InlineAnnotationMeta> => ({
    diffStyle: 'unified',
    hunkSeparators: 'line-info',
    enableHoverUtility: true,
    enableLineSelection: true,
    onLineSelectionEnd: handleLineSelectionEnd,
  }), [handleLineSelectionEnd]);

  const renderedFileDiff = useMemo((): FileDiffMetadata | null => {
    if (!selectedLoadedDiff) {
      return null;
    }

    const base = selectedLoadedDiff.fileDiff;
    if (selectedContextReady && selectedContextReady.oldTotal > 0 && selectedContextReady.newTotal > 0) {
      return {
        ...base,
        cacheKey: `${base.cacheKey ?? selectedKey}:context:${selectedContextReady.contextHash}`,
        oldLines: selectedContextReady.oldLines,
        newLines: selectedContextReady.newLines,
      };
    }

    return base;
  }, [selectedLoadedDiff, selectedContextReady, selectedKey]);

  if (files.length === 0) {
    return (
      <div style={{ padding: '32px', textAlign: 'center', color: '#8b949e' }}>
        No changed files.
      </div>
    );
  }

  const selectedDiffLoading = selectedDiffState?.status === 'loading' || selectedDiffState?.status === 'idle';
  const selectedDiffError = selectedDiffState?.status === 'error' ? selectedDiffState.message : null;
  const contextLoading = selectedContextState?.status === 'loading';
  const contextError = selectedContextState?.status === 'error' ? selectedContextState.message : null;
  const contextReady = selectedContextState?.status === 'ready';

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{
        width: '220px',
        flexShrink: 0,
        borderRight: '1px solid #30363d',
        overflow: 'auto',
        background: '#0d1117',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          padding: '8px 10px 6px',
          fontSize: '11px',
          color: '#6e7681',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          borderBottom: '1px solid #21262d',
          flexShrink: 0,
        }}>
          {files.length} file{files.length !== 1 ? 's' : ''}
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {files.map((file) => {
            const key = fileKey(file.filePath, file.prevFilePath);
            const isSelected = selectedKey === key;
            const color = CHANGE_COLOR[file.changeType];
            const label = CHANGE_LABEL[file.changeType];
            const lastSlash = file.filePath.lastIndexOf('/');
            const dirPart = lastSlash >= 0 ? file.filePath.slice(0, lastSlash + 1) : '';
            const basePart = lastSlash >= 0 ? file.filePath.slice(lastSlash + 1) : file.filePath;

            return (
              <button
                key={key}
                onClick={() => setSelectedFileKey(key)}
                title={file.filePath}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '5px 10px',
                  background: isSelected ? '#161b22' : 'transparent',
                  borderLeft: isSelected ? '2px solid #58a6ff' : '2px solid transparent',
                  borderTop: 'none',
                  borderRight: 'none',
                  borderBottom: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  minWidth: 0,
                }}
              >
                <span style={{ fontSize: '10px', fontWeight: 700, color, flexShrink: 0, width: '12px', textAlign: 'center' }}>
                  {label}
                </span>
                <span style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '12px',
                  color: isSelected ? '#e6edf3' : '#8b949e',
                  fontFamily: 'monospace',
                }}>
                  {dirPart && <span style={{ color: '#6e7681' }}>{dirPart}</span>}
                  {basePart}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div ref={diffHostRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <div style={{
          padding: '8px 12px',
          borderBottom: '1px solid #30363d',
          background: '#161b22',
          color: '#8b949e',
          fontSize: '12px',
          display: 'flex',
          gap: '14px',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}>
          <span>Hover a line and click <b>+</b> to comment</span>
          <span>Drag line numbers to comment on a range</span>
          <span>
            Hunk actions: <span style={{ color: '#22c55e' }}>Approve</span> / <span style={{ color: '#f85149' }}>Reject</span>
          </span>

          {!contextReady && (
            <button
              onClick={() => void ensureContextLoaded()}
              disabled={contextLoading || !selectedFile || !selectedLoadedDiff}
              style={{
                fontSize: '11px',
                padding: '2px 8px',
                borderRadius: '4px',
                border: '1px solid #30363d',
                background: '#21262d',
                color: '#8b949e',
                cursor: contextLoading ? 'wait' : 'pointer',
              }}
            >
              {contextLoading ? 'Loading context...' : 'Enable context expansion'}
            </button>
          )}

          {contextReady && <span style={{ color: '#22c55e' }}>Context expansion ready</span>}
          {contextError && <span style={{ color: '#f85149' }}>Context load failed: {contextError}</span>}
        </div>

        {selectedDiffLoading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b949e', fontSize: '13px' }}>
            Loading file diff...
          </div>
        ) : selectedDiffError ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f85149', fontSize: '13px', padding: '16px' }}>
            Failed to load file diff: {selectedDiffError}
          </div>
        ) : renderedFileDiff ? (
          <div style={{ flex: 1, overflow: 'auto' }}>
            <FileDiff
              fileDiff={renderedFileDiff}
              options={fileDiffOptions}
              lineAnnotations={lineAnnotations}
              renderAnnotation={renderAnnotation}
              renderHoverUtility={renderHoverUtility}
            />
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8b949e' }}>
            Select a file to view its diff.
          </div>
        )}
      </div>

      {commentForm && (
        <div style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: '#161b22',
          borderTop: '1px solid #30363d',
          padding: '12px 16px',
          zIndex: 100,
        }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', maxWidth: '860px', margin: '0 auto' }}>
            <div style={{ flex: 1 }}>
              {commentForm.target.kind === 'hunk' && (
                <div style={{ marginBottom: '6px', fontSize: '12px', color: '#8b949e' }}>
                  Commenting on hunk
                </div>
              )}
              {commentForm.target.kind === 'line' && (
                <div style={{ marginBottom: '6px', fontSize: '12px', color: '#8b949e' }}>
                  Commenting on line {commentForm.target.startLine}
                  {commentForm.target.startLine !== commentForm.target.endLine
                    ? `-${commentForm.target.endLine}`
                    : ''}
                </div>
              )}
              <textarea
                value={commentBody}
                onChange={(event) => setCommentBody(event.target.value)}
                placeholder="Add a comment..."
                rows={3}
                style={{
                  width: '100%',
                  background: '#0d1117',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  color: '#e6edf3',
                  padding: '8px',
                  fontSize: '13px',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setCommentForm(null);
                    setCommentBody('');
                  }
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    void handleSubmitComment();
                  }
                }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <button
                onClick={() => void handleSubmitComment()}
                disabled={submitting}
                style={{
                  padding: '8px 16px',
                  background: '#22c55e',
                  color: '#0d1117',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: submitting ? 'wait' : 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                }}
              >
                {submitting ? '...' : 'Submit'}
              </button>
              <button
                onClick={() => {
                  setCommentForm(null);
                  setCommentBody('');
                }}
                style={{
                  padding: '8px 16px',
                  background: '#21262d',
                  color: '#8b949e',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '13px',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function fileKey(filePath: string, prevFilePath?: string): string {
  return `${prevFilePath ?? ''}=>${filePath}`;
}

function parseSingleFileDiff(diff: string, file: ReviewChangedFile): LoadedFileDiff {
  const parsed = parsePatchFiles(diff);
  const parsedFile = parsed.flatMap((patch) => patch.files).find((entry) => {
    if (entry.name === file.filePath) {
      return true;
    }
    if (file.prevFilePath && entry.prevName === file.prevFilePath && entry.name === file.filePath) {
      return true;
    }
    return false;
  }) ?? parsed.flatMap((patch) => patch.files)[0];

  if (!parsedFile) {
    throw new Error('No parseable file diff returned for selected file');
  }

  const hunks: HunkInfo[] = parsedFile.hunks.map((hunk) => {
    const anchorSide: AnnotationSide = hunk.additionCount > 0 ? 'additions' : 'deletions';
    const anchorLine = Math.max(1, anchorSide === 'additions' ? hunk.additionStart : hunk.deletionStart);

    return {
      header: formatHunkHeader(hunk),
      anchorSide,
      anchorLine,
    };
  });

  return {
    fileDiff: parsedFile,
    hunks,
  };
}

function formatHunkHeader(hunk: Hunk): string {
  const specs = (hunk.hunkSpecs ?? '').trim();
  const context = hunk.hunkContext ?? '';

  if (!specs) {
    return context ? `@@ @@ ${context}` : '@@ @@';
  }

  return `@@ ${specs} @@${context ? ` ${context}` : ''}`;
}

function expandToAbsoluteLines(lines: string[], start: number, total: number): string[] {
  if (total <= 0) {
    return [];
  }

  // When backend returns full file range, this is effectively identity with a
  // defensive fallback for non-1 starts.
  const output = new Array<string>(total).fill('');
  const offset = Math.max(0, start - 1);
  for (let index = 0; index < lines.length; index++) {
    const absoluteIndex = offset + index;
    if (absoluteIndex >= output.length) {
      break;
    }
    output[absoluteIndex] = lines[index] ?? '';
  }
  return output;
}

function decisionColor(decision: HunkDecision): string {
  if (decision === 'approved') {
    return '#22c55e';
  }
  if (decision === 'rejected') {
    return '#f85149';
  }
  return '#d29922';
}

function actionButtonStyle(active: boolean, color: string, success = false): CSSProperties {
  return {
    border: success
      ? `1px solid ${active ? `${color}88` : `${color}66`}`
      : `1px solid ${active ? `${color}66` : '#30363d'}`,
    background: success
      ? active
        ? color
        : `${color}cc`
      : active
        ? `${color}33`
        : '#21262d',
    color: success ? '#0d1117' : active ? color : '#c9d1d9',
    borderRadius: '4px',
    fontSize: '11px',
    padding: '1px 8px',
    fontWeight: 600,
    cursor: 'pointer',
  };
}
