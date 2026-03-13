import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { getReplaySnapshot, type ReplaySnapshotOptions } from './snapshot.js';
import { readReplayManifest } from './store.js';
import type { TerminalSnapshot } from './types.js';

interface PngRasterizer {
  kind: 'sips' | 'magick' | 'convert';
  executable: string;
}

export interface RenderSnapshotSvgOptions {
  title?: string;
  subtitle?: string;
  includeScrollback?: boolean;
}

export interface ReplayScreenshotOptions extends ReplaySnapshotOptions {
  outputPath: string;
  includeScrollback?: boolean;
}

const THEME = {
  background: '#0d1117',
  border: '#30363d',
  header: '#161b22',
  title: '#e6edf3',
  subtitle: '#8b949e',
  text: '#c9d1d9',
  accent: '#58a6ff',
};

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function pathCandidates(name: string): string[] {
  const pathValue = process.env.PATH ?? '';
  const segments = pathValue.split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return segments.flatMap((segment) => suffixes.map((suffix) => join(segment, `${name}${suffix}`)));
}

function findExecutable(name: string): string | null {
  for (const candidate of pathCandidates(name)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function findPngRasterizer(): PngRasterizer | null {
  const candidates = process.platform === 'darwin'
    ? ['sips', 'magick', 'convert'] as const
    : ['magick', 'convert', 'sips'] as const;

  for (const candidate of candidates) {
    const executable = findExecutable(candidate);
    if (executable) {
      return { kind: candidate, executable };
    }
  }

  return null;
}

function buildSvgDocument(width: number, height: number, body: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    body,
    '</svg>',
  ].join('');
}

export function renderTerminalSnapshotSvg(snapshot: TerminalSnapshot, options: RenderSnapshotSvgOptions = {}): string {
  const includeScrollback = options.includeScrollback ?? false;
  const lines = includeScrollback
    ? [...snapshot.screen.scrollbackTail, ...snapshot.screen.visible]
    : [...snapshot.screen.visible];

  const paddingX = 24;
  const paddingY = 20;
  const headerHeight = 42;
  const cellWidth = 9;
  const cellHeight = 18;
  const fontSize = 15;
  const cols = Math.max(snapshot.terminal.cols, 20);
  const rows = Math.max(lines.length, snapshot.terminal.rows, 1);
  const width = paddingX * 2 + cols * cellWidth;
  const height = headerHeight + paddingY * 2 + rows * cellHeight;
  const title = options.title ?? snapshot.metadata.processTitle ?? snapshot.sessionId;
  const subtitle = options.subtitle ?? `replay ${snapshot.replayId} - t=${snapshot.timeMs}ms`;

  const lineText = lines.length > 0 ? lines : [''];
  const textElements = lineText.map((line, index) => {
    const y = headerHeight + paddingY + fontSize + index * cellHeight;
    const content = line.length > 0 ? escapeXml(line) : '&#160;';
    return `<text x="${paddingX}" y="${y}" xml:space="preserve">${content}</text>`;
  }).join('');

  return buildSvgDocument(width, height, `
    <rect width="100%" height="100%" rx="14" ry="14" fill="${THEME.background}" stroke="${THEME.border}" />
    <rect x="1" y="1" width="${width - 2}" height="${headerHeight}" rx="14" ry="14" fill="${THEME.header}" />
    <circle cx="18" cy="21" r="5" fill="#ff5f56" />
    <circle cx="36" cy="21" r="5" fill="#ffbd2e" />
    <circle cx="54" cy="21" r="5" fill="#27c93f" />
    <text x="72" y="19" fill="${THEME.title}" font-family="Menlo, Monaco, 'SF Mono', monospace" font-size="15" font-weight="600">${escapeXml(title)}</text>
    <text x="72" y="33" fill="${THEME.subtitle}" font-family="Menlo, Monaco, 'SF Mono', monospace" font-size="11">${escapeXml(subtitle)}</text>
    <text x="${width - 24}" y="20" text-anchor="end" fill="${THEME.accent}" font-family="Menlo, Monaco, 'SF Mono', monospace" font-size="11">${snapshot.terminal.cols}x${snapshot.terminal.rows}</text>
    <g fill="${THEME.text}" font-family="Menlo, Monaco, 'SF Mono', monospace" font-size="${fontSize}" style="font-variant-ligatures:none;">
      ${textElements}
    </g>
  `);
}

function rasterizeSvg(inputPath: string, outputPath: string, rasterizer: PngRasterizer): void {
  const cmd = rasterizer.kind === 'sips'
    ? [rasterizer.executable, '-s', 'format', 'png', inputPath, '--out', outputPath]
    : [rasterizer.executable, inputPath, outputPath];

  const [command, ...args] = cmd;
  const result = spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    const detail = Buffer.from(result.stderr ?? result.stdout ?? '').toString('utf-8').trim();
    throw new Error(detail || `Failed to rasterize screenshot with ${rasterizer.kind}`);
  }
}

export function writeTerminalSnapshotPng(
  snapshot: TerminalSnapshot,
  outputPath: string,
  options: RenderSnapshotSvgOptions = {}
): string {
  const rasterizer = findPngRasterizer();
  if (!rasterizer) {
    throw new Error('No PNG rasterizer found. Install ImageMagick or use a system with sips available.');
  }

  const absoluteOutputPath = resolve(outputPath);
  mkdirSync(dirname(absoluteOutputPath), { recursive: true });

  const tempDir = mkdtempSync(join(tmpdir(), 'gitspace-replay-shot-'));
  const tempSvgPath = join(tempDir, 'snapshot.svg');

  try {
    writeFileSync(tempSvgPath, renderTerminalSnapshotSvg(snapshot, options), 'utf-8');
    rasterizeSvg(tempSvgPath, absoluteOutputPath, rasterizer);

    if (!existsSync(absoluteOutputPath)) {
      throw new Error(`Screenshot was not written: ${absoluteOutputPath}`);
    }

    const size = statSync(absoluteOutputPath).size;
    if (size <= 0) {
      throw new Error(`Screenshot is empty: ${absoluteOutputPath}`);
    }

    return absoluteOutputPath;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function writeReplayScreenshot(replayId: string, options: ReplayScreenshotOptions): Promise<string> {
  const manifest = readReplayManifest(replayId);
  if (!manifest) {
    throw new Error(`Replay manifest not found: ${replayId}`);
  }

  const snapshot = await getReplaySnapshot(replayId, options);
  return writeTerminalSnapshotPng(snapshot, options.outputPath, {
    title: manifest.sessionName,
    subtitle: `replay ${manifest.replayId} - t=${snapshot.timeMs}ms`,
    includeScrollback: options.includeScrollback,
  });
}

export function readPngDimensions(pngPath: string): { width: number; height: number } {
  const file = readFileSync(pngPath);
  if (file.length < 24 || file.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error(`Invalid PNG file: ${pngPath}`);
  }

  return {
    width: file.readUInt32BE(16),
    height: file.readUInt32BE(20),
  };
}
