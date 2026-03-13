import type { TerminalSnapshot } from './types.js';
import { reconstructReplayAt } from './reconstruct.js';

function translateLine(buffer: { getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined }, index: number): string {
  return buffer.getLine(index)?.translateToString(true) ?? '';
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') {
    end--;
  }
  return lines.slice(0, end);
}

export interface ReplaySnapshotOptions {
  atMs?: number;
  scrollbackLines?: number;
}

export async function getReplaySnapshot(
  replayId: string,
  options: ReplaySnapshotOptions = {}
): Promise<TerminalSnapshot> {
  const { atMs, scrollbackLines = 80 } = options;
  const reconstructed = await reconstructReplayAt(replayId, atMs);
  const buffer = reconstructed.xterm.buffer.active;
  const viewportY = buffer.viewportY;
  const visible: string[] = [];
  for (let row = 0; row < reconstructed.rows; row++) {
    visible.push(translateLine(buffer, viewportY + row));
  }

  const scrollbackStart = Math.max(0, viewportY - scrollbackLines);
  const scrollbackTail: string[] = [];
  for (let row = scrollbackStart; row < viewportY; row++) {
    scrollbackTail.push(translateLine(buffer, row));
  }

  return {
    version: 1,
    replayId: reconstructed.replayId,
    sessionId: reconstructed.sessionId,
    workspaceId: reconstructed.workspaceId,
    source: 'replay',
    timeMs: reconstructed.timeMs,
    seq: reconstructed.seq,
    terminal: {
      cols: reconstructed.cols,
      rows: reconstructed.rows,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      viewportY,
      baseY: buffer.baseY,
    },
    metadata: {
      title: reconstructed.title,
      processTitle: reconstructed.processTitle,
      exitCode: reconstructed.exitCode,
      checkpointId: reconstructed.checkpointId,
    },
    screen: {
      visible,
      scrollbackTail,
      currentLine: translateLine(buffer, buffer.cursorY),
    },
  };
}

export interface ReplayTextOptions extends ReplaySnapshotOptions {
  includeScrollback?: boolean;
  trimTrailingBlankRows?: boolean;
}

export async function getReplayText(
  replayId: string,
  options: ReplayTextOptions = {}
): Promise<string> {
  const snapshot = await getReplaySnapshot(replayId, options);
  const lines = options.includeScrollback
    ? [...snapshot.screen.scrollbackTail, ...snapshot.screen.visible]
    : [...snapshot.screen.visible];
  const output = options.trimTrailingBlankRows === false ? lines : trimTrailingBlankLines(lines);
  return output.join('\n');
}

export async function getReplayMarkdown(
  replayId: string,
  options: ReplayTextOptions = {}
): Promise<string> {
  const snapshot = await getReplaySnapshot(replayId, options);
  const text = await getReplayText(replayId, options);
  const lines = [
    `Session: ${snapshot.sessionId}`,
    `Replay: ${snapshot.replayId}`,
    `Time: ${snapshot.timeMs}ms`,
    `Size: ${snapshot.terminal.cols}x${snapshot.terminal.rows}`,
  ];

  if (snapshot.metadata.processTitle) {
    lines.push(`Process: ${snapshot.metadata.processTitle}`);
  }
  if (snapshot.metadata.exitCode !== undefined) {
    lines.push(`Exit: ${snapshot.metadata.exitCode}`);
  }

  return `${lines.join('\n')}\n\n\`\`\`terminal\n${text}\n\`\`\``;
}
