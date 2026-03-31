/** @jsxImportSource react */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement } from 'react';
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
import { SpacesError, toSpacesError } from '../types/errors.js';
import { normalizeHunkHeader } from '../utils/hunk-header.js';
import { getReviewDecisionColor } from './review-decision-colors.js';

export interface HunkFocusTarget {
  filePath: string;
  hunkHeader: string;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

export interface DiffViewerProps {
  files: ReviewChangedFile[];
  threads: ReviewThread[];
  onCreateThread: (target: ThreadTarget, body: string, decision?: HunkDecision) => Promise<void>;
  onUpdateThread: (threadId: string, updates: { decision?: HunkDecision }) => Promise<void>;
  onApprovePath?: (path: string, pathKind: 'file' | 'folder') => Promise<void>;
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
  onSelectedFileChange?: (filePath: string | null) => void;
  onHunkFocus?: (target: HunkFocusTarget | null) => void;
  focusRequest?: { threadId: string; nonce: number } | null;
}

interface CommentFormState {
  target: ThreadTarget;
  decision?: HunkDecision;
}

interface HunkInfo {
  header: string;
  anchorSide: AnnotationSide;
  anchorLine: number;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

interface LoadedFileDiff {
  fileDiff: FileDiffMetadata;
  hunks: HunkInfo[];
}

type FileDiffState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: LoadedFileDiff }
  | { status: 'error'; error: SpacesError };

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
  | { status: 'error'; error: SpacesError };

interface FileApprovalState {
  totalHunks: number;
  approvedHunks: number;
  rejectedHunks: number;
  pendingHunks: number;
  isApproved: boolean;
}

function filterVisibleFiles(
  files: ReviewChangedFile[],
  hideApprovedFiles: boolean,
  reviewStateByFileKey: Record<string, FileApprovalState>,
): ReviewChangedFile[] {
  if (!hideApprovedFiles) {
    return files;
  }
  return files.filter((file) => !reviewStateByFileKey[fileKey(file.filePath, file.prevFilePath)]?.isApproved);
}

interface FileTreeNode {
  type: 'folder' | 'file';
  name: string;
  path: string;
  files: ReviewChangedFile[];
  children: FileTreeNode[];
}

type InlineAnnotationMeta =
  | { kind: 'thread'; thread: ReviewThread }
  | {
      kind: 'hunk-control';
      hunkHeader: string;
      decision: HunkDecision;
      threadId?: string;
      threadIds: string[];
      commentCount: number;
      oldStart: number;
      oldEnd: number;
      newStart: number;
      newEnd: number;
    };

type HunkControlMeta = Extract<InlineAnnotationMeta, { kind: 'hunk-control' }>;

const CHANGE_COLOR: Record<ReviewChangedFile['changeType'], string> = {
  new: 'var(--gs-accent)',
  deleted: 'var(--gs-danger)',
  renamed: 'var(--gs-warning)',
  copied: 'var(--gs-success)',
  modified: 'var(--gs-info)',
};

const CHANGE_LABEL: Record<ReviewChangedFile['changeType'], string> = {
  new: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  modified: 'M',
};

export function DiffViewer({
  files,
  threads,
  onCreateThread,
  onUpdateThread,
  onApprovePath,
  onRequestFileDiff,
  onRequestFileContextRange,
  onThreadClick,
  onThreadHover,
  onSelectedFileChange,
  onHunkFocus,
  focusRequest,
}: DiffViewerProps) {
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);
  const [fileListWidth, setFileListWidth] = useState(260);
  const [fileListMode, setFileListMode] = useState<'list' | 'tree'>('list');
  const [hideApprovedFiles, setHideApprovedFiles] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [approvingPath, setApprovingPath] = useState<string | null>(null);
  const [reviewStateByFileKey, setReviewStateByFileKey] = useState<Record<string, FileApprovalState>>({});
  const [fileDiffStateByKey, setFileDiffStateByKey] = useState<Record<string, FileDiffState>>({});
  const [contextStateByKey, setContextStateByKey] = useState<Record<string, FileContextState>>({});

  const [commentForm, setCommentForm] = useState<CommentFormState | null>(null);
  const [commentBody, setCommentBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const diffHostRef = useRef<HTMLDivElement | null>(null);
  const loadingFileDiffKeysRef = useRef<Set<string>>(new Set());
  const loadingContextKeysRef = useRef<Set<string>>(new Set());
  const decidingHunkKeysRef = useRef<Set<string>>(new Set());
  const fileDiffStateByKeyRef = useRef<Record<string, FileDiffState>>({});
  const contextStateByKeyRef = useRef<Record<string, FileContextState>>({});
  const hunkThreadByHeaderRef = useRef<Map<string, ReviewThread[]>>(new Map());

  const fileByKey = useMemo(() => {
    const map = new Map<string, ReviewChangedFile>();
    for (const file of files) {
      map.set(fileKey(file.filePath, file.prevFilePath), file);
    }
    return map;
  }, [files]);

  const selectedFile = useMemo(() => {
    const availableFiles = filterVisibleFiles(files, hideApprovedFiles, reviewStateByFileKey);
    if (selectedFileKey) {
      const match = fileByKey.get(selectedFileKey);
      if (match && availableFiles.some((file) => fileKey(file.filePath, file.prevFilePath) === selectedFileKey)) {
        return match;
      }
    }
    return availableFiles[0] ?? null;
  }, [selectedFileKey, fileByKey, files, hideApprovedFiles, reviewStateByFileKey]);

  useEffect(() => {
    if (!commentForm) {
      return;
    }

    if (commentForm.target.kind === 'workspace') {
      return;
    }

    const selectedFilePath = selectedFile?.filePath;
    if (!selectedFilePath || commentForm.target.file !== selectedFilePath) {
      setCommentForm(null);
      setCommentBody('');
    }
  }, [commentForm, selectedFile?.filePath]);

  const selectedKey = selectedFile ? fileKey(selectedFile.filePath, selectedFile.prevFilePath) : null;
  const selectedDiffState = selectedKey ? fileDiffStateByKey[selectedKey] ?? ({ status: 'idle' } as const) : null;
  const selectedContextState = selectedKey ? contextStateByKey[selectedKey] ?? ({ status: 'idle' } as const) : null;

  const startFileListResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const initialClientX = event.clientX;
    const initialWidth = fileListWidth;

    const handleMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - initialClientX;
      const next = Math.min(480, Math.max(180, initialWidth + delta));
      setFileListWidth(next);
    };

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [fileListWidth]);

  useEffect(() => {
    onSelectedFileChange?.(selectedFile?.filePath ?? null);
  }, [onSelectedFileChange, selectedFile]);

  useEffect(() => {
    let cancelled = false;

    const loadReviewState = async () => {
      const entries = await Promise.all(files.map(async (file) => {
        const key = fileKey(file.filePath, file.prevFilePath);
        let parsed = fileDiffStateByKeyRef.current[key]?.status === 'ready'
          ? fileDiffStateByKeyRef.current[key].data
          : null;

        if (!parsed) {
          try {
            const diff = await onRequestFileDiff(file.filePath, file.prevFilePath);
            parsed = parseSingleFileDiff(diff, file);
            setFileDiffStateByKey((prev) => prev[key]?.status === 'ready'
              ? prev
              : { ...prev, [key]: { status: 'ready', data: parsed! } });
          } catch {
            parsed = null;
          }
        }

        const totalHunks = parsed?.hunks.length ?? 0;
        const fileThreads = threads.filter((thread) => thread.target.kind === 'hunk' && thread.target.file === file.filePath);
        const decisions = new Map<string, HunkDecision>();
        for (const hunk of parsed?.hunks ?? []) {
          const matching = fileThreads.filter((thread) => (
            thread.target.kind === 'hunk' &&
            normalizeHunkHeader(thread.target.hunkHeader) === normalizeHunkHeader(hunk.header)
          ));
          decisions.set(normalizeHunkHeader(hunk.header), aggregateHunkDecision(matching));
        }
        const approvedHunks = [...decisions.values()].filter((decision) => decision === 'approved').length;
        const rejectedHunks = [...decisions.values()].filter((decision) => decision === 'rejected').length;
        const pendingHunks = Math.max(0, totalHunks - approvedHunks - rejectedHunks);
        return [key, {
          totalHunks,
          approvedHunks,
          rejectedHunks,
          pendingHunks,
          isApproved: totalHunks > 0 && approvedHunks === totalHunks,
        } satisfies FileApprovalState] as const;
      }));

      if (!cancelled) {
        setReviewStateByFileKey(Object.fromEntries(entries));
      }
    };

    void loadReviewState();
    return () => {
      cancelled = true;
    };
  }, [files, threads, onRequestFileDiff]);

  useEffect(() => {
    fileDiffStateByKeyRef.current = fileDiffStateByKey;
  }, [fileDiffStateByKey]);

  useEffect(() => {
    contextStateByKeyRef.current = contextStateByKey;
  }, [contextStateByKey]);

  useEffect(() => {
    const valid = new Set(files.map((file) => fileKey(file.filePath, file.prevFilePath)));
    const validFilePaths = new Set(files.map((file) => file.filePath));

    for (const key of [...loadingFileDiffKeysRef.current]) {
      if (!valid.has(key)) {
        loadingFileDiffKeysRef.current.delete(key);
      }
    }
    for (const key of [...loadingContextKeysRef.current]) {
      if (!valid.has(key)) {
        loadingContextKeysRef.current.delete(key);
      }
    }
    for (const key of [...decidingHunkKeysRef.current]) {
      const separator = key.indexOf('::');
      const filePath = separator >= 0 ? key.slice(0, separator) : key;
      if (!validFilePaths.has(filePath)) {
        decidingHunkKeysRef.current.delete(key);
      }
    }

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

    const current = fileDiffStateByKeyRef.current[key];
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
      const typed = toSpacesError(error, 'Failed to load file diff');
      setFileDiffStateByKey((prev) => ({
        ...prev,
        [key]: { status: 'error', error: typed },
      }));
    } finally {
      loadingFileDiffKeysRef.current.delete(key);
    }
  }, [onRequestFileDiff]);

  useEffect(() => {
    if (!selectedFile || !selectedKey) {
      return;
    }
    const state = fileDiffStateByKey[selectedKey] ?? { status: 'idle' as const };
    if (state.status === 'idle') {
      void loadFileDiff(selectedFile);
    }
  }, [selectedFile, selectedKey, fileDiffStateByKey, loadFileDiff]);

  useEffect(() => {
    if (!focusRequest) {
      return;
    }

    const thread = threads.find((entry) => entry.id === focusRequest.threadId);
    if (!thread || thread.target.kind === 'workspace') {
      return;
    }
    const target = thread.target;

    const targetFile = files.find((entry) => (
      entry.filePath === target.file || entry.prevFilePath === target.file
    ));
    if (!targetFile) {
      return;
    }

    const key = fileKey(targetFile.filePath, targetFile.prevFilePath);
    setSelectedFileKey(key);
  }, [files, focusRequest, threads]);

  useEffect(() => {
    if (!focusRequest || !selectedFile || !selectedKey) {
      return;
    }

    const thread = threads.find((entry) => entry.id === focusRequest.threadId);
    if (!thread || thread.target.kind === 'workspace') {
      return;
    }

    if (thread.target.file !== selectedFile.filePath && thread.target.file !== selectedFile.prevFilePath) {
      return;
    }

    if (selectedDiffState?.status !== 'ready') {
      return;
    }

    const host = diffHostRef.current;
    if (!host) {
      return;
    }

    const marker = host.querySelector<HTMLElement>(`[data-thread-id="${thread.id}"]`);
    if (marker) {
      marker.scrollIntoView({ block: 'center', behavior: 'smooth' });
      marker.focus?.();
      return;
    }

    const scrollContainer = host.querySelector<HTMLElement>('[data-diff-scroll-container]');
    if (scrollContainer) {
      scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [focusRequest, selectedDiffState?.status, selectedFile, selectedKey, threads]);

  const ensureContextLoaded = useCallback(async () => {
    if (!selectedFile || !selectedKey) {
      return;
    }

    const current = contextStateByKeyRef.current[selectedKey] ?? { status: 'idle' as const };
    if (current.status === 'loading' || current.status === 'ready') {
      return;
    }

    if (loadingContextKeysRef.current.has(selectedKey)) {
      return;
    }

    loadingContextKeysRef.current.add(selectedKey);

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
      const typed = toSpacesError(error, 'Failed to load file context');
      setContextStateByKey((prev) => ({
        ...prev,
        [selectedKey]: { status: 'error', error: typed },
      }));
    } finally {
      loadingContextKeysRef.current.delete(selectedKey);
    }
  }, [selectedFile, selectedKey, onRequestFileContextRange]);

  // On-demand expansion trigger: clicking line-info separators when context is
  // not loaded will load context first, then user can click again to expand.
  useEffect(() => {
    const host = diffHostRef.current;
    if (!host || !selectedKey) {
      return;
    }

    const onCaptureClick = (event: MouseEvent) => {
      const current = contextStateByKeyRef.current[selectedKey] ?? { status: 'idle' as const };
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
  }, [selectedKey, ensureContextLoaded]);

  const selectedLoadedDiff = selectedDiffState?.status === 'ready' ? selectedDiffState.data : null;
  const selectedContextReady = selectedContextState?.status === 'ready' ? selectedContextState : null;

  const hunkThreadByHeader = useMemo(() => {
    const map = new Map<string, ReviewThread[]>();
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
      const normalizedHeader = normalizeHunkHeader(thread.target.hunkHeader);
      const list = map.get(normalizedHeader) ?? [];
      list.push(thread);
      map.set(normalizedHeader, list);
    }

    return map;
  }, [threads, selectedFile]);

  useEffect(() => {
    hunkThreadByHeaderRef.current = hunkThreadByHeader;
  }, [hunkThreadByHeader]);

  const lineAnnotations = useMemo((): DiffLineAnnotation<InlineAnnotationMeta>[] => {
    if (!selectedLoadedDiff || !selectedFile) {
      return [];
    }

    const annotations: DiffLineAnnotation<InlineAnnotationMeta>[] = [];

    for (const hunk of selectedLoadedDiff.hunks) {
      const normalizedHeader = normalizeHunkHeader(hunk.header);
      const existingThreads = hunkThreadByHeader.get(normalizedHeader) ?? [];
      const primaryThread = pickPrimaryThread(existingThreads);
      annotations.push({
        side: hunk.anchorSide,
        lineNumber: hunk.anchorLine,
        metadata: {
          kind: 'hunk-control',
          hunkHeader: normalizedHeader,
          decision: aggregateHunkDecision(existingThreads),
          threadId: primaryThread?.id,
          threadIds: existingThreads.map((thread) => thread.id),
          commentCount: existingThreads.reduce((sum, thread) => sum + thread.comments.length, 0),
          oldStart: hunk.oldStart,
          oldEnd: hunk.oldEnd,
          newStart: hunk.newStart,
          newEnd: hunk.newEnd,
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
    } catch {
      // Error is surfaced via review hook state; avoid unhandled promise rejections.
    } finally {
      setSubmitting(false);
    }
  }, [commentForm, commentBody, onCreateThread]);

  const setHunkDecision = useCallback(async (hunkMeta: HunkControlMeta, decision: HunkDecision) => {
    if (!selectedFile) {
      return;
    }

    const normalizedHeader = normalizeHunkHeader(hunkMeta.hunkHeader);
    const hunkKey = `${selectedFile.filePath}::${normalizedHeader}`;
    if (decidingHunkKeysRef.current.has(hunkKey)) {
      return;
    }

    decidingHunkKeysRef.current.add(hunkKey);

    try {
      onHunkFocus?.({
        filePath: selectedFile.filePath,
        hunkHeader: hunkMeta.hunkHeader,
        oldStart: hunkMeta.oldStart,
        oldEnd: hunkMeta.oldEnd,
        newStart: hunkMeta.newStart,
        newEnd: hunkMeta.newEnd,
      });

      const existingThreads = hunkThreadByHeaderRef.current.get(normalizedHeader) ?? [];
      const primary = pickPrimaryThread(existingThreads);
      if (primary) {
        try {
          await onUpdateThread(primary.id, { decision });
        } catch {
          // Error is surfaced via review hook state; avoid unhandled promise rejections.
        }
        return;
      }

      if (decision === 'pending') {
        return;
      }

      try {
        await onCreateThread(
          { kind: 'hunk', file: selectedFile.filePath, hunkHeader: normalizedHeader },
          decision === 'approved'
            ? 'Approved hunk via inline controls.'
            : 'Rejected hunk via inline controls.',
          decision
        );
      } catch {
        // Error is surfaced via review hook state; avoid unhandled promise rejections.
      }
    } finally {
      decidingHunkKeysRef.current.delete(hunkKey);
    }
  }, [selectedFile, onUpdateThread, onCreateThread, onHunkFocus]);

  const openHunkCommentForm = useCallback((hunkMeta: HunkControlMeta) => {
    if (!selectedFile) {
      return;
    }
    onHunkFocus?.({
      filePath: selectedFile.filePath,
      hunkHeader: hunkMeta.hunkHeader,
      oldStart: hunkMeta.oldStart,
      oldEnd: hunkMeta.oldEnd,
      newStart: hunkMeta.newStart,
      newEnd: hunkMeta.newEnd,
    });
    setCommentForm({
      target: {
        kind: 'hunk',
        file: selectedFile.filePath,
        hunkHeader: normalizeHunkHeader(hunkMeta.hunkHeader),
      },
    });
    setCommentBody('');
  }, [selectedFile, onHunkFocus]);

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
        type="button"
        aria-label="Add line comment"
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
          background: 'var(--gs-info)',
          color: 'var(--gs-text-on-accent)',
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
      const color = thread.decision ? getReviewDecisionColor(thread.decision) : 'var(--gs-info)';
      const count = thread.comments.length;

      return (
        <div style={{ position: 'relative', height: 0, overflow: 'visible', pointerEvents: 'none' }}>
          <button
            title={`Open thread (${count} comment${count === 1 ? '' : 's'})`}
            onClick={() => onThreadClick?.(thread.id)}
            onMouseEnter={() => onThreadHover?.(thread.id)}
            onMouseLeave={() => onThreadHover?.(null)}
            data-thread-id={thread.id}
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

    const tint = getReviewDecisionColor(meta.decision);
    return (
      <div style={{ position: 'relative', zIndex: 10, height: 0, overflow: 'visible', pointerEvents: 'none' }}>
        <div
          data-thread-id={meta.threadId}
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
            background: 'var(--gs-bg-elevated)',
            padding: '1px',
          }}
          onMouseEnter={() => meta.threadId && onThreadHover?.(meta.threadId)}
          onMouseLeave={() => onThreadHover?.(null)}
        >
          <button
            title="Reject hunk"
            onClick={() => {
              void setHunkDecision(meta, 'rejected').catch(() => {});
            }}
            style={actionButtonStyle(meta.decision === 'rejected', 'var(--gs-danger)')}
          >
            Reject
          </button>
          <button
            title="Approve hunk"
            onClick={() => {
              void setHunkDecision(meta, 'approved').catch(() => {});
            }}
            style={actionButtonStyle(meta.decision === 'approved', 'var(--gs-accent)', true)}
          >
            Approve
          </button>
          {meta.threadId && (
            <button
              title="Open hunk thread"
              onClick={() => {
                if (!selectedFile) {
                  return;
                }
                onHunkFocus?.({
                  filePath: selectedFile.filePath,
                  hunkHeader: meta.hunkHeader,
                  oldStart: meta.oldStart,
                  oldEnd: meta.oldEnd,
                  newStart: meta.newStart,
                  newEnd: meta.newEnd,
                });
                if (meta.threadId) {
                  onThreadClick?.(meta.threadId);
                }
              }}
              style={actionButtonStyle(false, 'var(--gs-info)')}
            >
              Threads {meta.threadIds.length > 1 ? `(${meta.threadIds.length})` : ''}
            </button>
          )}
          {!meta.threadId && (
            <button
              title="Comment on hunk"
              onClick={() => openHunkCommentForm(meta)}
              style={actionButtonStyle(false, 'var(--gs-info)')}
            >
              Comment
            </button>
          )}
        </div>
      </div>
    );
  }, [onThreadClick, onThreadHover, openHunkCommentForm, onHunkFocus, selectedFile, setHunkDecision]);

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
      <div style={{ padding: '32px', textAlign: 'center', color: 'var(--gs-text-muted)' }}>
        No changed files.
      </div>
    );
  }

  const selectedDiffLoading = selectedDiffState?.status === 'loading' || selectedDiffState?.status === 'idle';
  const selectedDiffError = selectedDiffState?.status === 'error' ? selectedDiffState.error.message : null;
  const contextLoading = selectedContextState?.status === 'loading';
  const contextError = selectedContextState?.status === 'error' ? selectedContextState.error.message : null;
  const contextReady = selectedContextState?.status === 'ready';
  const visibleFiles = useMemo(
    () => filterVisibleFiles(files, hideApprovedFiles, reviewStateByFileKey),
    [files, hideApprovedFiles, reviewStateByFileKey],
  );
  const visibleFileTree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles]);

  useEffect(() => {
    if (!selectedKey) {
      return;
    }
    if (!visibleFiles.some((file) => fileKey(file.filePath, file.prevFilePath) === selectedKey)) {
      setSelectedFileKey(visibleFiles[0] ? fileKey(visibleFiles[0].filePath, visibleFiles[0].prevFilePath) : null);
    }
  }, [selectedKey, visibleFiles]);

  const handleApprovePath = useCallback(async (path: string, pathKind: 'file' | 'folder') => {
    if (!onApprovePath) {
      return;
    }
    setApprovingPath(`${pathKind}:${path}`);
    try {
      await onApprovePath(path, pathKind);
    } finally {
      setApprovingPath(null);
    }
  }, [onApprovePath]);

    return (
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{
        width: `${fileListWidth}px`,
        flexShrink: 0,
        overflow: 'hidden',
        background: 'var(--gs-bg)',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          padding: '8px 10px 6px',
          fontSize: '11px',
          color: 'var(--gs-text-dim)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          borderBottom: '1px solid var(--gs-border-muted)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <span>{visibleFiles.length} file{visibleFiles.length !== 1 ? 's' : ''}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => setHideApprovedFiles((value) => !value)}
              style={miniToggleStyle(hideApprovedFiles)}
            >
              Hide approved
            </button>
            <button
              type="button"
              onClick={() => setFileListMode((mode) => mode === 'list' ? 'tree' : 'list')}
              style={miniToggleStyle(fileListMode === 'tree')}
            >
              {fileListMode === 'tree' ? 'Tree' : 'List'}
            </button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {visibleFiles.length === 0 ? (
            <div style={{ padding: '12px 10px', fontSize: '12px', color: 'var(--gs-text-dim)' }}>
              No visible files.
            </div>
          ) : fileListMode === 'tree' ? (
            renderFileTreeNodes({
              nodes: visibleFileTree,
              selectedKey,
              expandedFolders,
              onToggleFolder: (path) => setExpandedFolders((prev) => ({ ...prev, [path]: !prev[path] })),
              onSelectFile: setSelectedFileKey,
              onApproveFolder: onApprovePath ? (path) => void handleApprovePath(path, 'folder') : undefined,
              approvingPath,
              reviewStateByFileKey,
            })
          ) : (
            visibleFiles.map((file) => renderFileListRow({
              file,
              selectedKey,
              onSelectFile: setSelectedFileKey,
              reviewState: reviewStateByFileKey[fileKey(file.filePath, file.prevFilePath)],
            }))
          )}
        </div>
      </div>

      <div
        onMouseDown={startFileListResize}
        style={{
          width: '6px',
          cursor: 'col-resize',
          background: 'transparent',
          borderLeft: '1px solid var(--gs-border)',
          flexShrink: 0,
        }}
      />

      <div ref={diffHostRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <div style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--gs-border)',
          background: 'var(--gs-bg-elevated)',
          color: 'var(--gs-text-muted)',
          fontSize: '12px',
          display: 'flex',
          gap: '14px',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}>
          <span>Hover a line and click <b>+</b> to comment</span>
          <span>Drag line numbers to comment on a range</span>
          <span>
            Hunk actions: <span style={{ color: 'var(--gs-accent)' }}>Approve</span> / <span style={{ color: 'var(--gs-danger)' }}>Reject</span>
          </span>

          {!contextReady && (
            <button
              onClick={() => void ensureContextLoaded()}
              disabled={contextLoading || !selectedFile || !selectedLoadedDiff}
              style={{
                fontSize: '11px',
                padding: '2px 8px',
                borderRadius: '4px',
                border: '1px solid var(--gs-border)',
                background: 'var(--gs-btn-secondary-bg)',
                color: 'var(--gs-text-muted)',
                cursor: contextLoading ? 'wait' : 'pointer',
              }}
            >
              {contextLoading ? 'Loading context...' : 'Enable context expansion'}
            </button>
          )}

          {contextReady && <span style={{ color: 'var(--gs-accent)' }}>Context expansion ready</span>}
          {contextError && <span style={{ color: 'var(--gs-danger)' }}>Context load failed: {contextError}</span>}
        </div>

        {selectedDiffLoading ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gs-text-muted)', fontSize: '13px' }}>
            Loading file diff...
          </div>
        ) : selectedDiffError ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gs-danger)', fontSize: '13px', padding: '16px' }}>
            Failed to load file diff: {selectedDiffError}
          </div>
        ) : renderedFileDiff ? (
          <div data-diff-scroll-container style={{ flex: 1, overflow: 'auto' }}>
            <FileDiff
              fileDiff={renderedFileDiff}
              options={fileDiffOptions}
              lineAnnotations={lineAnnotations}
              renderAnnotation={renderAnnotation}
              renderHoverUtility={renderHoverUtility}
            />
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gs-text-muted)' }}>
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
          background: 'var(--gs-bg-elevated)',
          borderTop: '1px solid var(--gs-border)',
          padding: '12px 16px',
          zIndex: 100,
        }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', maxWidth: '860px', margin: '0 auto' }}>
            <div style={{ flex: 1 }}>
              {commentForm.target.kind === 'hunk' && (
                <div style={{ marginBottom: '6px', fontSize: '12px', color: 'var(--gs-text-muted)' }}>
                  Commenting on hunk
                </div>
              )}
              {commentForm.target.kind === 'line' && (
                <div style={{ marginBottom: '6px', fontSize: '12px', color: 'var(--gs-text-muted)' }}>
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
                  background: 'var(--gs-bg)',
                  border: '1px solid var(--gs-border)',
                  borderRadius: '6px',
                  color: 'var(--gs-text)',
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
                    void handleSubmitComment().catch(() => {});
                  }
                }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <button
                onClick={() => {
                  void handleSubmitComment().catch(() => {});
                }}
                disabled={submitting}
                style={{
                  padding: '8px 16px',
                  background: 'var(--gs-accent)',
                  color: 'var(--gs-text-on-accent)',
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
                  background: 'var(--gs-btn-secondary-bg)',
                  color: 'var(--gs-text-muted)',
                  border: '1px solid var(--gs-border)',
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

function miniToggleStyle(active: boolean): CSSProperties {
  return {
    fontSize: '10px',
    padding: '3px 6px',
    borderRadius: '999px',
    border: '1px solid var(--gs-border)',
    background: active ? 'var(--gs-chip-blue-bg)' : 'var(--gs-bg-elevated)',
    color: active ? 'var(--gs-info)' : 'var(--gs-text-muted)',
    cursor: 'pointer',
  };
}

function renderFileListRow({
  file,
  selectedKey,
  onSelectFile,
  reviewState,
  depth = 0,
}: {
  file: ReviewChangedFile;
  selectedKey: string | null;
  onSelectFile: (key: string) => void;
  reviewState?: FileApprovalState;
  depth?: number;
}) {
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
      onClick={() => onSelectFile(key)}
      title={file.filePath}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '5px 10px',
        paddingLeft: `${10 + depth * 14}px`,
        background: isSelected ? 'var(--gs-bg-elevated)' : 'transparent',
        borderLeft: isSelected ? '2px solid var(--gs-info)' : '2px solid transparent',
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
        color: isSelected ? 'var(--gs-text)' : 'var(--gs-text-muted)',
        fontFamily: 'monospace',
      }}>
        {dirPart && <span style={{ color: 'var(--gs-text-dim)' }}>{dirPart}</span>}
        {basePart}
      </span>
      {reviewState?.isApproved && <span style={{ color: 'var(--gs-accent)', fontSize: '10px' }}>OK</span>}
    </button>
  );
}

function buildFileTree(files: ReviewChangedFile[]): FileTreeNode[] {
  const root = new Map<string, FileTreeNode>();

  for (const file of files) {
    const parts = file.filePath.split('/');
    let current = root;
    let currentPath = '';
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = index === parts.length - 1;
      const existing = current.get(part);
      if (existing) {
        if (isFile) existing.files.push(file);
        current = ensureChildMap(existing);
        continue;
      }
      const node: FileTreeNode = {
        type: isFile ? 'file' : 'folder',
        name: part,
        path: currentPath,
        files: isFile ? [file] : [],
        children: [],
      };
      current.set(part, node);
      current = ensureChildMap(node);
    }
  }

  return sortTreeNodes([...root.values()]);
}

function ensureChildMap(node: FileTreeNode): Map<string, FileTreeNode> {
  const map = new Map<string, FileTreeNode>();
  for (const child of node.children) {
    map.set(child.name, child);
  }
  node.children = [...map.values()];
  return new Proxy(map, {
    set(target, property, value) {
      const result = Reflect.set(target, property, value);
      node.children = sortTreeNodes([...target.values()]);
      return result;
    },
  });
}

function sortTreeNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function collectNodeFiles(node: FileTreeNode): ReviewChangedFile[] {
  if (node.type === 'file') {
    return node.files;
  }
  return node.children.flatMap(collectNodeFiles);
}

function renderFileTreeNodes({
  nodes,
  selectedKey,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
  onApproveFolder,
  approvingPath,
  reviewStateByFileKey,
  depth = 0,
}: {
  nodes: FileTreeNode[];
  selectedKey: string | null;
  expandedFolders: Record<string, boolean>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (key: string) => void;
  onApproveFolder?: (path: string) => void;
  approvingPath: string | null;
  reviewStateByFileKey: Record<string, FileApprovalState>;
  depth?: number;
}): ReactElement[] {
  return nodes.flatMap((node) => {
    if (node.type === 'file') {
      return [renderFileListRow({
        file: node.files[0]!,
        selectedKey,
        onSelectFile,
        reviewState: reviewStateByFileKey[fileKey(node.files[0]!.filePath, node.files[0]!.prevFilePath)],
        depth,
      })];
    }

    const childFiles = collectNodeFiles(node);
    const allApproved = childFiles.length > 0 && childFiles.every((file) => reviewStateByFileKey[fileKey(file.filePath, file.prevFilePath)]?.isApproved);
    const isExpanded = expandedFolders[node.path] ?? depth < 1;
    const header = (
      <div
        key={`folder:${node.path}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '5px 10px',
          paddingLeft: `${10 + depth * 14}px`,
          color: 'var(--gs-text-muted)',
          fontSize: '12px',
        }}
      >
        <button type="button" onClick={() => onToggleFolder(node.path)} style={{ background: 'none', border: 'none', color: 'var(--gs-text-muted)', cursor: 'pointer', padding: 0 }}>
          {isExpanded ? '▾' : '▸'}
        </button>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
        <span style={{ fontSize: '10px', color: allApproved ? 'var(--gs-accent)' : 'var(--gs-text-dim)' }}>{childFiles.length}</span>
        {onApproveFolder && (
          <button
            type="button"
            onClick={() => onApproveFolder(node.path)}
            disabled={allApproved || approvingPath === `folder:${node.path}`}
            style={{
              fontSize: '10px',
              padding: '2px 6px',
              borderRadius: '999px',
              border: '1px solid var(--gs-border)',
              background: allApproved ? 'var(--gs-bg-elevated)' : 'var(--gs-terminal-selection)',
              color: allApproved ? 'var(--gs-text-dim)' : 'var(--gs-accent)',
              cursor: allApproved ? 'default' : 'pointer',
            }}
          >
            {approvingPath === `folder:${node.path}` ? '...' : 'Approve'}
          </button>
        )}
      </div>
    );

    return isExpanded
      ? [header, ...renderFileTreeNodes({
        nodes: node.children,
        selectedKey,
        expandedFolders,
        onToggleFolder,
        onSelectFile,
        onApproveFolder,
        approvingPath,
        reviewStateByFileKey,
        depth: depth + 1,
      })]
      : [header];
  });
}

function parseSingleFileDiff(diff: string, file: ReviewChangedFile): LoadedFileDiff {
  const parsed = parsePatchFiles(diff);
  const parsedFile = parsed.flatMap((patch) => patch.files).find((entry) => {
    const matchesCurrentOrPreviousName =
      entry.name === file.filePath ||
      (file.prevFilePath !== undefined && entry.name === file.prevFilePath);
    const matchesCurrentOrPreviousPrevName =
      entry.prevName === file.filePath ||
      (file.prevFilePath !== undefined && entry.prevName === file.prevFilePath);
    return matchesCurrentOrPreviousName || matchesCurrentOrPreviousPrevName;
  });

  if (!parsedFile) {
    throw new SpacesError('No parseable file diff returned for selected file', 'SYSTEM_ERROR', 2);
  }

  const hunks: HunkInfo[] = parsedFile.hunks.map((hunk) => {
    const anchorSide: AnnotationSide = hunk.additionCount > 0 ? 'additions' : 'deletions';
    const anchorLine = Math.max(1, anchorSide === 'additions' ? hunk.additionStart : hunk.deletionStart);
    const oldStart = Math.max(1, hunk.deletionStart);
    const newStart = Math.max(1, hunk.additionStart);
    const oldEnd = hunk.deletionCount > 0 ? oldStart + hunk.deletionCount - 1 : oldStart - 1;
    const newEnd = hunk.additionCount > 0 ? newStart + hunk.additionCount - 1 : newStart - 1;

    return {
      header: formatHunkHeader(hunk),
      anchorSide,
      anchorLine,
      oldStart,
      oldEnd,
      newStart,
      newEnd,
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

  if (specs.startsWith('@@')) {
    return normalizeHunkHeader(specs);
  }

  if (!specs) {
    return normalizeHunkHeader(context ? `@@ @@ ${context}` : '@@ @@');
  }

  return normalizeHunkHeader(`@@ ${specs} @@${context ? ` ${context}` : ''}`);
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

function actionButtonStyle(active: boolean, color: string, success = false): CSSProperties {
  return {
    border: success
      ? `1px solid ${active ? `${color}88` : `${color}66`}`
      : `1px solid ${active ? `${color}66` : 'var(--gs-border)'}`,
    background: success
      ? active
        ? color
        : `${color}cc`
      : active
        ? `${color}33`
        : 'var(--gs-btn-secondary-bg)',
    color: success ? 'var(--gs-text-on-accent)' : active ? color : 'var(--gs-text-secondary)',
    borderRadius: '4px',
    fontSize: '11px',
    padding: '1px 8px',
    fontWeight: 600,
    cursor: 'pointer',
  };
}

function pickPrimaryThread(threads: ReviewThread[]): ReviewThread | undefined {
  if (threads.length === 0) {
    return undefined;
  }
  const unresolved = threads
    .filter((thread) => !thread.resolved)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  if (unresolved.length > 0) {
    return unresolved[0];
  }
  return [...threads].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

function aggregateHunkDecision(threads: ReviewThread[]): HunkDecision {
  if (threads.some((thread) => thread.decision === 'rejected')) {
    return 'rejected';
  }
  if (threads.length > 0 && threads.every((thread) => thread.decision === 'approved')) {
    return 'approved';
  }
  return 'pending';
}
