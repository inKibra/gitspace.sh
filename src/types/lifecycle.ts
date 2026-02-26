export type WorkspaceSource = 'branch' | 'linear' | 'manual';

export interface SessionLinearAttachmentSummary {
  id: string;
  url: string;
  title: string | null;
  sourceType: string | null;
  createdAt: string;
}

export interface SessionLinearIssueSummary {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  assigneeName: string | null;
  stateName: string | null;
  createdAt: string;
  updatedAt: string;
  attachments: SessionLinearAttachmentSummary[];
}
