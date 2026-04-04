/** @jsxImportSource react */
/**
 * ReviewPage — full review dashboard.
 */

import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { DiffViewer, type HunkFocusTarget } from '../components/DiffViewer.web.js';
import { ThreadPanel } from '../components/ThreadPanel.web.js';
import { useReviewPageModel } from '../app/shared/review/useReviewPageModel.js';
import type {
  HunkDecision,
  ReviewChangedFile,
  ReviewOperation,
  ReviewResult,
  ThreadTarget,
} from '../types/review.js';
import { SpacesError, toSpacesError } from '../types/errors.js';

export interface ReviewPageProps {
  projectName: string;
  workspaceName: string;
  workspaceLabel?: string;
  machineName?: string;
  sendReviewRequest: (operation: ReviewOperation) => Promise<ReviewResult>;
  onBack: () => void;
}

export function ReviewPage({
  projectName,
  workspaceName,
  workspaceLabel,
  machineName,
  sendReviewRequest,
  onBack,
}: ReviewPageProps) {
  const { review, statusInfo } = useReviewPageModel({ sendReviewRequest, projectName, workspaceName });
  const {
    threads,
    loading: reviewLoading,
    error: reviewError,
    loadThreads,
    createThread,
    updateThread,
    addReply,
    updateComment,
    deleteComment,
    importGitHub,
    pushGitHub,
    approvePath,
  } = review;

  const [files, setFiles] = useState<ReviewChangedFile[]>([]);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [headBranch, setHeadBranch] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<SpacesError | null>(null);

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [panelWidth, setPanelWidth] = useState(360);
  const [threadFilter, setThreadFilter] = useState<'all' | 'current-file' | 'current-hunk'>('all');
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [currentHunkFocus, setCurrentHunkFocus] = useState<HunkFocusTarget | null>(null);
  const currentHunkFocusRef = useRef<HunkFocusTarget | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ threadId: string; nonce: number } | null>(null);

  const [importing, setImporting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

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
        throw new SpacesError(`Unexpected response for get_changed_files: ${result.op}`, 'SYSTEM_ERROR', 2);
      }

      setFiles(result.files);
      setBaseBranch(result.baseBranch);
      setHeadBranch(result.headBranch);
    } catch (error) {
      setFiles([]);
      setFilesError(toSpacesError(error, 'Failed to load changed files'));
    } finally {
      setFilesLoading(false);
    }
  }, [sendReviewRequest, projectName, workspaceName]);

  useEffect(() => {
    // Deliberately key this effect to workspace identity only.
    // loadThreads/loadChangedFiles are recreated when upstream callback
    // identities churn, which was causing a refetch loop. Initial review
    // loading should happen when the workspace changes, not when callback
    // references change.
    void loadThreads().catch(() => {});
    void loadChangedFiles();
  }, [projectName, workspaceName]);

  const handleRefresh = useCallback(() => {
    void loadThreads().catch(() => {});
    void loadChangedFiles();
  }, [loadThreads, loadChangedFiles]);

  const handleCreateThread = useCallback(async (target: ThreadTarget, body: string, decision?: HunkDecision) => {
    await createThread(target, body, decision);
  }, [createThread]);

  const handleUpdateThread = useCallback(async (threadId: string, updates: { decision?: HunkDecision }) => {
    await updateThread(threadId, updates);
  }, [updateThread]);

  const handleGetFileDiff = useCallback(async (filePath: string, prevFilePath?: string) => {
    const result = await sendReviewRequest({
      op: 'get_file_diff',
      projectName,
      workspaceName,
      filePath,
      prevFilePath,
    });

    if (result.op !== 'file_diff') {
      throw new SpacesError(`Unexpected response for get_file_diff: ${result.op}`, 'SYSTEM_ERROR', 2);
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
      throw new SpacesError(`Unexpected response for get_file_context_range: ${result.op}`, 'SYSTEM_ERROR', 2);
    }

    return result;
  }, [sendReviewRequest, projectName, workspaceName]);

  const handleImport = useCallback(async () => {
    setImporting(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      const { imported } = await importGitHub();
      setActionSuccess(`Imported ${imported} new thread(s) from GitHub.`);
      setTimeout(() => setActionSuccess(null), 4000);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Import failed');
      setTimeout(() => setActionError(null), 6000);
    } finally {
      setImporting(false);
    }
  }, [importGitHub]);

  const handlePush = useCallback(async () => {
    setPushing(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      const { url } = await pushGitHub();
      setActionSuccess(`Review submitted: ${url}`);
      setTimeout(() => setActionSuccess(null), 6000);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Push failed');
      setTimeout(() => setActionError(null), 6000);
    } finally {
      setPushing(false);
    }
  }, [pushGitHub]);

  const openThread = useCallback((threadId: string) => {
    setSelectedThreadId(threadId);
    setPanelCollapsed(false);
    setFocusRequest({ threadId, nonce: Date.now() });
  }, []);

  const handleSelectedFileChange = useCallback((filePath: string | null) => {
    setCurrentFilePath(filePath);
    const currentFocus = currentHunkFocusRef.current;
    if (currentFocus && (!filePath || currentFocus.filePath !== filePath)) {
      setCurrentHunkFocus(null);
      setThreadFilter((mode) => (mode === 'current-hunk' ? 'current-file' : mode));
    }
  }, []);

  useEffect(() => {
    currentHunkFocusRef.current = currentHunkFocus;
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
      background: 'var(--gs-bg)',
      color: 'var(--gs-text)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      overflow: 'hidden',
    }}>
      <div style={{
        background: 'var(--gs-bg-elevated)',
        borderBottom: '1px solid var(--gs-border)',
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
            color: 'var(--gs-text-muted)',
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

        <div style={{ height: '16px', width: '1px', background: 'var(--gs-border)' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          {machineName && (
            <>
              <span style={{ fontSize: '13px', color: 'var(--gs-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {machineName}
              </span>
              <span style={{ color: 'var(--gs-border)' }}>/</span>
            </>
          )}
          <span style={{ fontSize: '13px', color: 'var(--gs-text-muted)' }}>{projectName}</span>
          <span style={{ color: 'var(--gs-border)' }}>/</span>
          <span style={{ fontSize: '13px', color: 'var(--gs-text)', fontWeight: 600 }}>{workspaceLabel ?? workspaceName}</span>
          {headBranch && (
            <span style={{ fontSize: '11px', color: 'var(--gs-text-dim)', background: 'var(--gs-btn-secondary-bg)', padding: '1px 6px', borderRadius: '4px', border: '1px solid var(--gs-border)' }}>
              {headBranch}
            </span>
          )}
          {baseBranch && (
            <span style={{ fontSize: '11px', color: 'var(--gs-text-dim)' }}>← {baseBranch}</span>
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
            color: actionError ? 'var(--gs-danger)' : 'var(--gs-accent)',
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
          disabled={filesLoading || reviewLoading}
          style={{
            fontSize: '12px',
            padding: '5px 10px',
            background: 'var(--gs-btn-secondary-bg)',
            color: 'var(--gs-text-muted)',
            border: '1px solid var(--gs-border)',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          {filesLoading || reviewLoading ? '...' : '↺ Refresh'}
        </button>

        <button
          onClick={() => void handleImport()}
          disabled={importing}
          style={{
            fontSize: '12px',
            padding: '5px 10px',
            background: 'var(--gs-btn-secondary-bg)',
            color: 'var(--gs-info)',
            border: '1px solid var(--gs-border)',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          {importing ? '...' : '↓ Import GH'}
        </button>

        <button
          onClick={() => void handlePush()}
          disabled={pushing || threads.length === 0}
          style={{
            fontSize: '12px',
            padding: '5px 10px',
            background: pushing ? 'var(--gs-btn-secondary-bg)' : 'var(--gs-accent)',
            color: pushing ? 'var(--gs-text-muted)' : 'var(--gs-text-on-accent)',
            border: '1px solid var(--gs-border)',
            borderRadius: '6px',
            cursor: threads.length === 0 ? 'not-allowed' : 'pointer',
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
            background: 'var(--gs-btn-secondary-bg)',
            color: 'var(--gs-text-muted)',
            border: '1px solid var(--gs-border)',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          {panelCollapsed ? '≡ Threads' : '≡ Hide'}
          {threads.filter((thread) => !thread.resolved).length > 0 && (
            <span style={{
              marginLeft: '6px',
              fontSize: '10px',
              padding: '0 5px',
              background: 'var(--gs-info)',
              color: 'var(--gs-text-on-accent)',
              borderRadius: '8px',
              fontWeight: 700,
            }}>
              {threads.filter((thread) => !thread.resolved).length}
            </span>
          )}
        </button>
      </div>

      {(reviewError || filesError) && (
        <div style={{
          padding: '8px 16px',
          background: 'var(--gs-chip-red-bg)',
          borderBottom: '1px solid var(--gs-danger)',
          color: 'var(--gs-danger)',
          fontSize: '12px',
        }}>
          Error: {filesError?.message ?? reviewError}
        </div>
      )}

      {filesLoading && files.length === 0 ? (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--gs-text-muted)',
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
          color: 'var(--gs-text-muted)',
          fontSize: '13px',
          flexDirection: 'column',
          gap: '8px',
        }}>
          <div>No changes vs {baseBranch ?? 'base branch'}.</div>
          <div style={{ fontSize: '12px', color: 'var(--gs-text-dim)' }}>
            This workspace is up to date with its base branch.
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <div style={{ flex: panelCollapsed ? '1 1 100%' : '1 1 auto', overflow: 'hidden' }}>
            <DiffViewer
              files={files}
              threads={threads}
              onCreateThread={handleCreateThread}
              onUpdateThread={handleUpdateThread}
              onRequestFileDiff={handleGetFileDiff}
              onRequestFileContextRange={handleGetFileContextRange}
              onApprovePath={async (path, pathKind) => {
                const { approvedCount } = await approvePath(path, pathKind);
                setActionError(null);
                setActionSuccess(
                  `Approved ${approvedCount} hunk${approvedCount === 1 ? '' : 's'} in ${pathKind === 'folder' ? 'folder' : 'file'} ${path}`,
                );
                setTimeout(() => setActionSuccess(null), 4000);
              }}
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
                  borderLeft: '1px solid var(--gs-border)',
                }}
              />

              <div style={{ flex: 1, overflow: 'hidden', borderLeft: '1px solid var(--gs-border)' }}>
              <ThreadPanel
                threads={threads}
                currentFilePath={currentFilePath}
                hunkFocus={currentHunkFocus}
                filterMode={threadFilter}
                onFilterModeChange={setThreadFilter}
                selectedThreadId={selectedThreadId}
                hoveredThreadId={hoveredThreadId}
                onResolveThread={(threadId, resolved) => updateThread(threadId, { resolved })}
                onAddReply={addReply}
                onUpdateComment={updateComment}
                onDeleteComment={deleteComment}
                onUpdateDecision={(threadId, decision) => updateThread(threadId, { decision })}
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
