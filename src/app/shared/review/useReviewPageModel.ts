import { useReview } from '../../../hooks/useReview.web.js';
import { computeWorkspaceStatus } from '../../../types/review.js';
import type { ReviewOperation, ReviewResult } from '../../../types/review.js';

const STATUS_LABELS = {
  not_started: { label: 'Not started', color: '#6e7681' },
  in_progress: { label: 'In progress', color: '#d29922' },
  approved: { label: 'Approved', color: '#22c55e' },
  changes_required: { label: 'Changes required', color: '#f85149' },
};

export interface UseReviewPageModelArgs {
  projectName: string;
  workspaceName: string;
  sendReviewRequest: (operation: ReviewOperation) => Promise<ReviewResult>;
}

export function useReviewPageModel(args: UseReviewPageModelArgs) {
  const review = useReview({
    sendReviewRequest: args.sendReviewRequest,
    projectName: args.projectName,
    workspaceName: args.workspaceName,
  });

  const status = computeWorkspaceStatus(review.threads);
  const statusInfo = STATUS_LABELS[status];

  return {
    review,
    statusInfo,
  };
}
