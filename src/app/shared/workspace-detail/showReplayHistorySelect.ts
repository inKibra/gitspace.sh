import type { WorkspaceDetailReplayRow } from './types.js';

interface ReplayHistorySelectConfig {
  workspaceName: string;
  replayRows: WorkspaceDetailReplayRow[];
  showSelect: (config: {
    title: string;
    searchable?: boolean;
    options: Array<{ label: string; description?: string; value: string }>;
    onSelect: (value: string) => void | Promise<void>;
  }) => void;
  onSelectReplay: (replayId: string) => void | Promise<void>;
}

export function showReplayHistorySelect(args: ReplayHistorySelectConfig): void {
  args.showSelect({
    title: `${args.workspaceName} Replay History`,
    searchable: true,
    options: args.replayRows.map((replay) => ({
      label: replay.label,
      description: [replay.processLabel, replay.statusLabel, replay.timeLabel, replay.detailLabel].filter(Boolean).join(' · '),
      value: replay.replayId,
    })),
    onSelect: args.onSelectReplay,
  });
}
