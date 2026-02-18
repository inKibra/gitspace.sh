/** @jsxImportSource react */
/**
 * ReviewPage — full review dashboard.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────┐
 *   │ Header (breadcrumb, status badge, GH buttons)    │
 *   ├──────────────────────────────────────────────────┤
 *   │  Diff viewer (70%)   │  Thread panel (30%)       │
 *   └──────────────────────────────────────────────────┘
 */

import { useEffect, useState, useCallback } from 'react';
import { useReview } from '../hooks/useReview.web.js';
import { DiffViewer } from '../components/DiffViewer.web.js';
import { ThreadPanel } from '../components/ThreadPanel.web.js';
import { computeWorkspaceStatus } from '../types/review.js';
import type { ReviewOperation, ReviewResult, ThreadTarget, HunkDecision } from '../types/review.js';

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
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(true);
  const [importing, setImporting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Load diff and threads on mount
  useEffect(() => {
    void review.loadDiff();
    void review.loadThreads();
  }, [projectName, workspaceName]);

  const status = computeWorkspaceStatus(review.threads);
  const statusInfo = STATUS_LABELS[status];

  const handleCreateThread = useCallback(async (target: ThreadTarget, body: string, decision?: HunkDecision) => {
    await review.createThread(target, body, decision);
  }, [review]);

  const handleUpdateThread = useCallback(async (threadId: string, updates: { decision?: HunkDecision }) => {
    await review.updateThread(threadId, updates);
  }, [review]);

  const handleImport = useCallback(async () => {
    setImporting(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      const { imported } = await review.importGitHub();
      setActionSuccess(`Imported ${imported} comment(s) from GitHub.`);
      setTimeout(() => setActionSuccess(null), 4000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Import failed');
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
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Push failed');
      setTimeout(() => setActionError(null), 6000);
    } finally {
      setPushing(false);
    }
  }, [review]);

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
      {/* Header */}
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

        {/* Breadcrumb */}
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
          {review.headBranch && (
            <span style={{ fontSize: '11px', color: '#6e7681', background: '#21262d', padding: '1px 6px', borderRadius: '4px', border: '1px solid #30363d' }}>
              {review.headBranch}
            </span>
          )}
          {review.baseBranch && (
            <span style={{ fontSize: '11px', color: '#6e7681' }}>← {review.baseBranch}</span>
          )}
        </div>

        {/* Status badge */}
        <span style={{
          marginLeft: '4px',
          fontSize: '11px',
          padding: '2px 8px',
          borderRadius: '10px',
          background: statusInfo.color + '22',
          color: statusInfo.color,
          border: `1px solid ${statusInfo.color}44`,
          flexShrink: 0,
        }}>
          {statusInfo.label}
        </span>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Action buttons */}
        {(actionError || actionSuccess) && (
          <span style={{
            fontSize: '12px',
            color: actionError ? '#f85149' : '#22c55e',
            maxWidth: '300px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {actionError || actionSuccess}
          </span>
        )}

        <button
          onClick={() => { void review.loadDiff(); void review.loadThreads(); }}
          disabled={review.loading}
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
          {review.loading ? '...' : '↺ Refresh'}
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
          onClick={() => setShowPanel((v) => !v)}
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
          {showPanel ? '≡ Hide' : '≡ Threads'}
          {review.threads.filter((t) => !t.resolved).length > 0 && (
            <span style={{
              marginLeft: '6px',
              fontSize: '10px',
              padding: '0 5px',
              background: '#58a6ff',
              color: '#0d1117',
              borderRadius: '8px',
              fontWeight: 700,
            }}>
              {review.threads.filter((t) => !t.resolved).length}
            </span>
          )}
        </button>
      </div>

      {/* Error banner */}
      {review.error && (
        <div style={{
          padding: '8px 16px',
          background: '#f8514922',
          borderBottom: '1px solid #f8514944',
          color: '#f85149',
          fontSize: '12px',
        }}>
          Error: {review.error}
        </div>
      )}

      {/* Loading state */}
      {review.loading && !review.diff && (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#8b949e',
          fontSize: '13px',
        }}>
          Loading diff...
        </div>
      )}

      {/* Main content */}
      {review.diff !== null && (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Diff viewer */}
          <div style={{ flex: showPanel ? '1 1 70%' : '1 1 100%', overflow: 'hidden' }}>
            <DiffViewer
              diff={review.diff}
              threads={review.threads}
              onCreateThread={handleCreateThread}
              onUpdateThread={handleUpdateThread}
              onThreadClick={(id) => {
                setSelectedThreadId(id);
                setShowPanel(true);
              }}
            />
          </div>

          {/* Thread panel */}
          {showPanel && (
            <div style={{ flex: '0 0 320px', overflow: 'hidden', borderLeft: '1px solid #30363d' }}>
              <ThreadPanel
                threads={review.threads}
                selectedThreadId={selectedThreadId}
                onResolveThread={(id, resolved) => review.updateThread(id, { resolved })}
                onAddReply={review.addReply}
                onUpdateComment={review.updateComment}
                onDeleteComment={review.deleteComment}
                onUpdateDecision={(id, decision) => review.updateThread(id, { decision })}
                onClose={() => setShowPanel(false)}
              />
            </div>
          )}
        </div>
      )}

      {/* Empty diff state */}
      {review.diff === '' && !review.loading && (
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
          <div>No changes vs {review.baseBranch ?? 'base branch'}.</div>
          <div style={{ fontSize: '12px', color: '#6e7681' }}>
            This workspace is up to date with its base branch.
          </div>
        </div>
      )}
    </div>
  );
}
