import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ReviewThread } from '../../types/review.js';

const mockGetThreads = mock<(workspacePath: string, workspaceName: string, baseBranch: string) => ReviewThread[]>(() => []);
const mockApproveHunk = mock(async () => {
  throw new Error('approveHunk mock not initialized');
});
const mockGetWorkspaceChangedFiles = mock(async () => ({
  files: [],
  baseBranch: 'main',
  headBranch: 'feature',
}));
const mockGetWorkspaceFileDiff = mock(async () => ({ diff: '' }));
const mockReadProjectConfig = mock(() => ({ baseBranch: 'main' }));
const mockScanWorkspaces = mock(async () => ([{ projectName: 'alpha', id: 'alpha:ws', path: '/tmp/workspace' }]));

mock.module('../review.js', () => ({
  getThreads: mockGetThreads,
  readReviewSession: mock(() => ({ version: '1.0', workspaceName: 'ws', baseBranch: 'main', prNumber: null, threads: [], createdAt: '', updatedAt: '' })),
  writeReviewSession: mock(() => undefined),
  prepareReviewStorage: mock(async () => undefined),
  createThread: mock(async () => { throw new Error('unused createThread'); }),
  addReply: mock(() => { throw new Error('unused addReply'); }),
  updateThread: mock(() => { throw new Error('unused updateThread'); }),
  updateComment: mock(() => { throw new Error('unused updateComment'); }),
  deleteComment: mock(() => { throw new Error('unused deleteComment'); }),
  detectPRNumber: mock(async () => null),
  approveHunk: mockApproveHunk,
}));

mock.module('../git.js', () => ({
  getWorkspaceChangedFiles: mockGetWorkspaceChangedFiles,
  getWorkspaceDiff: mock(async () => ({ diff: '', baseBranch: 'main', headBranch: 'feature' })),
  getWorkspaceFileContextRange: mock(async () => ({ oldStart: 1, oldLines: [], oldTotal: 0, newStart: 1, newLines: [], newTotal: 0 })),
  getWorkspaceFileDiff: mockGetWorkspaceFileDiff,
  getWorkspaceFileVersions: mock(async () => ({ oldContents: '', newContents: '' })),
}));

mock.module('../config.js', () => ({
  readProjectConfig: mockReadProjectConfig,
}));

mock.module('../../lib/remote-session/workspace-scanner.js', () => ({
  scanWorkspaces: mockScanWorkspaces,
}));

const { executeLocalReviewOperation } = await import('../review-executor.js');

describe('review executor approve_path', () => {
  let threads: ReviewThread[];

  beforeEach(() => {
    mockGetThreads.mockReset();
    mockApproveHunk.mockReset();
    mockGetWorkspaceChangedFiles.mockReset();
    mockGetWorkspaceFileDiff.mockReset();
    mockReadProjectConfig.mockReset();
    mockScanWorkspaces.mockReset();

    threads = [
      {
        id: 'thread-approved',
        target: { kind: 'hunk', file: 'src/app.ts', hunkHeader: '@@ -1 +1 @@' },
        decision: 'approved',
        resolved: false,
        comments: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'thread-pending',
        target: { kind: 'hunk', file: 'src/app.ts', hunkHeader: '@@ -5 +5 @@' },
        decision: 'pending',
        resolved: false,
        comments: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    mockGetThreads.mockImplementation(() => threads);
    mockReadProjectConfig.mockImplementation(() => ({ baseBranch: 'main' }));
    mockScanWorkspaces.mockImplementation(async () => ([{ projectName: 'alpha', id: 'ws', path: '/tmp/workspace' }]));
    mockGetWorkspaceChangedFiles.mockImplementation(async () => ({
      files: [{ filePath: 'src/app.ts', prevFilePath: undefined }],
      baseBranch: 'main',
      headBranch: 'feature',
    }));
    mockGetWorkspaceFileDiff.mockImplementation(async () => ({
      diff: ['@@ -1 +1 @@', ' line one', '@@ -5 +5 @@', ' line two'].join('\n'),
    }));
    mockApproveHunk.mockImplementation(async (_workspacePath, _workspaceName, _baseBranch, target) => {
      const existing = threads.find(
        (thread) => thread.target.kind === 'hunk'
          && thread.target.file === target.file
          && thread.target.hunkHeader === target.hunkHeader,
      );
      if (existing) {
        existing.decision = 'approved';
        return existing;
      }
      const created: ReviewThread = {
        id: `thread-${threads.length + 1}`,
        target,
        decision: 'approved',
        resolved: false,
        comments: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      threads.push(created);
      return created;
    });
  });

  it('counts only hunks whose approval state changed', async () => {
    const result = await executeLocalReviewOperation({
      op: 'approve_path',
      projectName: 'alpha',
      workspaceName: 'ws',
      path: 'src',
      pathKind: 'folder',
    });

    expect(result.op).toBe('path_approved');
    expect(result.approvedCount).toBe(1);
    expect(mockApproveHunk).toHaveBeenCalledTimes(1);
    expect(threads.find((thread) => thread.id === 'thread-pending')?.decision).toBe('approved');
  });
});
