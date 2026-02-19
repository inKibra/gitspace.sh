/** @jsxImportSource react */
/**
 * ReviewPage — full review dashboard.
 */

import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { DiffViewer, type HunkFocusTarget } from '../components/DiffViewer.web.js';
import { ThreadPanel } from '../components/ThreadPanel.web.js';
import { useReview } from '../hooks/useReview.web.js';
import { computeWorkspaceStatus } from '../types/review.js';
import type {
  HunkDecision,
  ReviewChangedFile,
  ReviewOperation,
  ReviewResult,
  ThreadTarget,
} from '../types/review.js';

export interface ReviewPageProps {
  projectName: string;
  workspaceName: string;
  machineName?: string;
  sendReviewRequest: (operation: ReviewOperation) => Promise<ReviewResult>;
  onBack: () => void;
}

const STATUS_LABELS = {
  not_started: { label: 'Not started', color: '#6e7681' },
  in_progress: { label: 'In progress', color: '#d29922' },
  approved: { label: 'Approved', color: '#22c55e' },
  changes_required: { label: 'Changes required', color: '#f85149' },
};

export function ReviewPage({
  projectName,
  workspaceName,
  machineName,
  sendReviewRequest,
  onBack,
}: ReviewPageProps) {
  const review = useReview({ sendReviewRequest, projectName, workspaceName });

  const [files, setFiles] = useState<ReviewChangedFile[]>([]);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [headBranch, setHeadBranch] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [panelWidth, setPanelWidth] = useState(360);
  const [threadFilter, setThreadFilter] = useState<'all' | 'current-file' | 'current-hunk'>('all');
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [currentHunkFocus, setCurrentHunkFocus] = useState<HunkFocusTarget | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ threadId: string; nonce: number } | null>(null);

  const [importing, setImporting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const status = computeWorkspaceStatus(review.threads);
  const statusInfo = STATUS_LABELS[status];

  const loadChangedFiles = useCallback(async () => {
    setFilesLoading(true);
    setFilesError(null);
    try {
      const result = await sendReviewRequest({
        op: 'get_changed_files',
        projectName,
        workspaceName,
      });

      if (result.op !== 'changed_files') {
        throw new Error(`Unexpected response for get_changed_files: ${result.op}`);
      }

      setFiles(result.files);
      setBaseBranch(result.baseBranch);
      setHeadBranch(result.headBranch);
    } catch (error) {
      setFiles([]);
      setFilesError(error instanceof Error ? error.message : String(error));
    } finally {
      setFilesLoading(false);
    }
  }, [sendReviewRequest, projectName, workspaceName]);

  useEffect(() => {
    void review.loadThreads();
    void loadChangedFiles();
  }, [projectName, workspaceName, loadChangedFiles, review.loadThreads]);

  const handleRefresh = useCallback(() => {
    void review.loadThreads();
    void loadChangedFiles();
  }, [review, loadChangedFiles]);

  const handleCreateThread = useCallback(async (target: ThreadTarget, body: string, decision?: HunkDecision) => {
    await review.createThread(target, body, decision);
  }, [review]);

  const handleUpdateThread = useCallback(async (threadId: string, updates: { decision?: HunkDecision }) => {
    await review.updateThread(threadId, updates);
  }, [review]);

  const handleGetFileDiff = useCallback(async (filePath: string, prevFilePath?: string) => {
    const result = await sendReviewRequest({
      op: 'get_file_diff',
      projectName,
      workspaceName,
      filePath,
      prevFilePath,
    });

    if (result.op !== 'file_diff') {
      throw new Error(`Unexpected response for get_file_diff: ${result.op}`);
    }

    return result.diff;
  }, [sendReviewRequest, projectName, workspaceName]);

  const handleGetFileContextRange = useCallback(async (
    filePath: string,
    prevFilePath?: string,
    range?: { oldStart?: number; oldEnd?: number; newStart?: number; newEnd?: number }
  ) => {
    const result = await sendReviewRequest({
      op: 'get_file_context_range',
      projectName,
      workspaceName,
      filePath,
      prevFilePath,
      oldStart: range?.oldStart,
      oldEnd: range?.oldEnd,
      newStart: range?.newStart,
      newEnd: range?.newEnd,
    });

    if (result.op !== 'file_context_range') {
      throw new Error(`Unexpected response for get_file_context_range: ${result.op}`);
    }

    return result;
  }, [sendReviewRequest, projectName, workspaceName]);

  const handleImport = useCallback(async () => {
    setImporting(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      const { imported } = await review.importGitHub();
      setActionSuccess(`Imported ${imported} comment(s) from GitHub.`);
      setTimeout(() => setActionSuccess(null), 4000);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Import failed');
      setTimeout(() => setActionError(null), 6000);
    } finally {
      setImporting(false);
    }
  }, [review]);

  const handlePush = useCallback(async () => {
    setPushing(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      const { url } = await review.pushGitHub();
      setActionSuccess(`Review submitted: ${url}`);
      setTimeout(() => setActionSuccess(null), 6000);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Push failed');
      setTimeout(() => setActionError(null), 6000);
    } finally {
      setPushing(false);
    }
  }, [review]);

  const openThread = useCallback((threadId: string) => {
    setSelectedThreadId(threadId);
    setPanelCollapsed(false);
    setFocusRequest({ threadId, nonce: Date.now() });
  }, []);

  const handleSelectedFileChange = useCallback((filePath: string | null) => {
    setCurrentFilePath(filePath);
    if (currentHunkFocus && (!filePath || currentHunkFocus.filePath !== filePath)) {
      setCurrentHunkFocus(null);
      setThreadFilter((mode) => (mode === 'current-hunk' ? 'current-file' : mode));
    }
  }, [currentHunkFocus]);

  const handleHunkFocus = useCallback((target: HunkFocusTarget | null) => {
    setCurrentHunkFocus(target);
    if (target) {
      setPanelCollapsed(false);
      setThreadFilter('current-hunk');
    }
  }, []);

  const startResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const initialClientX = event.clientX;
    const initialWidth = panelWidth;

    const handleMove = (moveEvent: MouseEvent) => {
      const delta = initialClientX - moveEvent.clientX;
      const next = Math.min(640, Math.max(280, initialWidth + delta));
      setPanelWidth(next);
    };

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [panelWidth]);

  return (
    <div style={{
      height: '100vh',
      width: '100vw',
      display: 'flex',
      flexDirection: 'column',
      background: '#0d1117',
      color: '#e6edf3',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      overflow: 'hidden',
    }}>
      <div style={{
        background: '#161b22',
        borderBottom: '1px solid #30363d',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexShrink: 0,
        minHeight: '52px',
      }}>
        <button
          onClick={onBack}
          style={{
            background: 'none',
            border: 'none',
            color: '#8b949e',
            cursor: 'pointer',
            fontSize: '13px',
            padding: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          ← Workspaces
        </button>

        <div style={{ height: '16px', width: '1px', background: '#30363d' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          {machineName && (
            <>
              <span style={{ fontSize: '13px', color: '#8b949e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {machineName}
              </span>
              <span style={{ color: '#30363d' }}>/</span>
            </>
          )}
          <span style={{ fontSize: '13px', color: '#8b949e' }}>{projectName}</span>
          <span style={{ color: '#30363d' }}>/</span>
          <span style={{ fontSize: '13px', color: '#e6edf3', fontWeight: 600 }}>{workspaceName}</span>
          {headBranch && (
            <span style={{ fontSize: '11px', color: '#6e7681', background: '#21262d', padding: '1px 6px', borderRadius: '4px', border: '1px solid #30363d' }}>
              {headBranch}
            </span>
          )}
          {baseBranch && (
            <span style={{ fontSize: '11px', color: '#6e7681' }}>← {baseBranch}</span>
          )}
        </div>

        <span style={{
          marginLeft: '4px',
          fontSize: '11px',
          padding: '2px 8px',
          borderRadius: '10px',
          background: `${statusInfo.color}22`,
          color: statusInfo.color,
          border: `1px solid ${statusInfo.color}44`,
          flexShrink: 0,
        }}>
          {statusInfo.label}
        </span>

        <div style={{ flex: 1 }} />

        {(actionError || actionSuccess) && (
          <span style={{
            fontSize: '12px',
            color: actionError ? '#f85149' : '#22c55e',
            maxWidth: '320px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {actionError || actionSuccess}
          </span>
        )}

        <button
          onClick={handleRefresh}
          disabled={filesLoading || review.loading}
          style={{
            fontSize: '12px',
            padding: '5px 10px',
            background: '#21262d',
            color: '#8b949e',
            border: '1px solid #30363d',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          {filesLoading || review.loading ? '...' : '↺ Refresh'}
        </button>

        <button
          onClick={() => void handleImport()}
          disabled={importing}
          style={{
            fontSize: '12px',
            padding: '5px 10px',
            background: '#21262d',
            color: '#58a6ff',
            border: '1px solid #30363d',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          {importing ? '...' : '↓ Import GH'}
        </button>

        <button
          onClick={() => void handlePush()}
          disabled={pushing || review.threads.length === 0}
          style={{
            fontSize: '12px',
            padding: '5px 10px',
            background: pushing ? '#21262d' : '#22c55e',
            color: pushing ? '#8b949e' : '#0d1117',
            border: '1px solid #30363d',
            borderRadius: '6px',
            cursor: review.threads.length === 0 ? 'not-allowed' : 'pointer',
            fontWeight: 600,
          }}
        >
          {pushing ? '...' : '↑ Push to GH'}
        </button>

        <button
          onClick={() => setPanelCollapsed((value) => !value)}
          style={{
            fontSize: '12px',
            padding: '5px 10px',
            background: '#21262d',
            color: '#8b949e',
            border: '1px solid #30363d',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          {panelCollapsed ? '≡ Threads' : '≡ Hide'}
          {review.threads.filter((thread) => !thread.resolved).length > 0 && (
            <span style={{
              marginLeft: '6px',
              fontSize: '10px',
              padding: '0 5px',
              background: '#58a6ff',
              color: '#0d1117',
              borderRadius: '8px',
              fontWeight: 700,
            }}>
              {review.threads.filter((thread) => !thread.resolved).length}
            </span>
          )}
        </button>
      </div>

      {(review.error || filesError) && (
        <div style={{
          padding: '8px 16px',
          background: '#f8514922',
          borderBottom: '1px solid #f8514944',
          color: '#f85149',
          fontSize: '12px',
        }}>
          Error: {filesError ?? review.error}
        </div>
      )}

      {filesLoading && files.length === 0 ? (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#8b949e',
          fontSize: '13px',
        }}>
          Loading changed files...
        </div>
      ) : files.length === 0 ? (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#8b949e',
          fontSize: '13px',
          flexDirection: 'column',
          gap: '8px',
        }}>
          <div>No changes vs {baseBranch ?? 'base branch'}.</div>
          <div style={{ fontSize: '12px', color: '#6e7681' }}>
            This workspace is up to date with its base branch.
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <div style={{ flex: panelCollapsed ? '1 1 100%' : '1 1 auto', overflow: 'hidden' }}>
            <DiffViewer
              files={files}
              threads={review.threads}
              onCreateThread={handleCreateThread}
              onUpdateThread={handleUpdateThread}
              onRequestFileDiff={handleGetFileDiff}
              onRequestFileContextRange={handleGetFileContextRange}
              onThreadClick={openThread}
              onSelectedFileChange={handleSelectedFileChange}
              onHunkFocus={handleHunkFocus}
              focusRequest={focusRequest}
              onThreadHover={(threadId) => {
                setHoveredThreadId(threadId);
                if (threadId) {
                  setPanelCollapsed(false);
                }
              }}
            />
          </div>

          {!panelCollapsed && (
            <div style={{ display: 'flex', width: `${panelWidth}px`, maxWidth: '60vw', minWidth: '280px' }}>
              <div
                onMouseDown={startResize}
                style={{
                  width: '6px',
                  cursor: 'col-resize',
                  background: 'transparent',
                  borderLeft: '1px solid #30363d',
                }}
              />

              <div style={{ flex: 1, overflow: 'hidden', borderLeft: '1px solid #30363d' }}>
              <ThreadPanel
                threads={review.threads}
                currentFilePath={currentFilePath}
                hunkFocus={currentHunkFocus}
                filterMode={threadFilter}
                onFilterModeChange={setThreadFilter}
                selectedThreadId={selectedThreadId}
                hoveredThreadId={hoveredThreadId}
                onResolveThread={(threadId, resolved) => review.updateThread(threadId, { resolved })}
                onAddReply={review.addReply}
                onUpdateComment={review.updateComment}
                onDeleteComment={review.deleteComment}
                onUpdateDecision={(threadId, decision) => review.updateThread(threadId, { decision })}
                onOpenThreadTarget={openThread}
                onClose={() => setPanelCollapsed(true)}
              />
            </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
