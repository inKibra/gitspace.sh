import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import type { Terminal as XTerminal } from '@xterm/headless';
import { ReplayScreenshotError, SpacesError } from '../../../types/errors.js';
import { logger } from '../../../utils/logger.js';
import { reconstructReplayAt } from './reconstruct.js';
import type { ReplaySnapshotOptions } from './snapshot.js';
import { readReplayManifest } from './store.js';
import type { TerminalSnapshot } from './types.js';

// ============================================================================
// PNG rasterizer detection
// ============================================================================

interface PngRasterizer {
  kind: 'sips' | 'magick' | 'convert';
  executable: string;
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

const RASTERIZE_TIMEOUT_MS = 15_000;

interface ScreenshotErrorContext {
  replayId?: string;
  outputPath?: string;
  rasterizer?: string;
}

function formatScreenshotContext(context: ScreenshotErrorContext): string {
  return [
    context.replayId ? `replayId=${context.replayId}` : null,
    context.outputPath ? `outputPath=${context.outputPath}` : null,
    context.rasterizer ? `rasterizer=${context.rasterizer}` : null,
  ].filter((value): value is string => value !== null).join(' ');
}

function logAndCreateScreenshotError(
  message: string,
  context: ScreenshotErrorContext,
  error?: unknown,
): ReplayScreenshotError {
  const suffix = formatScreenshotContext(context);
  const detail = error instanceof Error ? error.message : error ? String(error) : null;
  logger.error(`[replay.screenshot] ${message}${suffix ? ` (${suffix})` : ''}${detail ? `: ${detail}` : ''}`);
  return new ReplayScreenshotError(message);
}

function collectOutput(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf-8').trim();
}

function buildProcessFailureMessage(rasterizer: PngRasterizer, reason: string, stdout: string, stderr: string): string {
  const output = [stderr, stdout].filter(Boolean).join('\n').trim();
  return output.length > 0
    ? `Failed to rasterize screenshot with ${rasterizer.kind}: ${reason}. ${output}`
    : `Failed to rasterize screenshot with ${rasterizer.kind}: ${reason}`;
}

async function rasterizeSvg(
  inputPath: string,
  outputPath: string,
  rasterizer: PngRasterizer,
  context: ScreenshotErrorContext,
): Promise<void> {
  const cmd = rasterizer.kind === 'sips'
    ? [rasterizer.executable, '-s', 'format', 'png', inputPath, '--out', outputPath]
    : [rasterizer.executable, inputPath, outputPath];

  const [command, ...args] = cmd;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;

    const finish = (error?: ReplayScreenshotError) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise();
      }
    };

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      const stdout = collectOutput(stdoutChunks);
      const stderr = collectOutput(stderrChunks);
      finish(logAndCreateScreenshotError(
        buildProcessFailureMessage(rasterizer, `timed out after ${RASTERIZE_TIMEOUT_MS}ms`, stdout, stderr),
        { ...context, rasterizer: rasterizer.kind },
      ));
    }, RASTERIZE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on('error', (error) => {
      finish(logAndCreateScreenshotError(
        `Failed to start screenshot rasterizer ${rasterizer.kind}`,
        { ...context, rasterizer: rasterizer.kind },
        error,
      ));
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }

      const stdout = collectOutput(stdoutChunks);
      const stderr = collectOutput(stderrChunks);
      const reason = signal ? `terminated by signal ${signal}` : `exited with code ${code ?? 'unknown'}`;
      finish(logAndCreateScreenshotError(
        buildProcessFailureMessage(rasterizer, reason, stdout, stderr),
        { ...context, rasterizer: rasterizer.kind },
      ));
    });
  });
}

// ============================================================================
// Theme
// ============================================================================

const THEME = {
  background: '#0d1117',
  border: '#30363d',
  header: '#161b22',
  title: '#e6edf3',
  subtitle: '#8b949e',
  text: '#c9d1d9',
  accent: '#58a6ff',
};

// ============================================================================
// ANSI 256-color palette
// ============================================================================

// Base 16 ANSI colors matching our GitSpace dark theme
const ANSI_BASE_COLORS: string[] = [
  '#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4', // 0-7  normal
  '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc', // 8-15 bright
];

const ANSI_256_PALETTE: string[] = (() => {
  const palette = [...ANSI_BASE_COLORS];

  // 6x6x6 RGB cube (colors 16-231)
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        const rv = r === 0 ? 0 : 55 + r * 40;
        const gv = g === 0 ? 0 : 55 + g * 40;
        const bv = b === 0 ? 0 : 55 + b * 40;
        palette.push(
          `#${rv.toString(16).padStart(2, '0')}${gv.toString(16).padStart(2, '0')}${bv.toString(16).padStart(2, '0')}`,
        );
      }
    }
  }

  // 24-step grayscale (colors 232-255)
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    const hex = v.toString(16).padStart(2, '0');
    palette.push(`#${hex}${hex}${hex}`);
  }

  return palette;
})();

const COLOR_MODE_DEFAULT = 0;
const COLOR_MODE_P16 = 0x01000000;  // 16777216
const COLOR_MODE_P256 = 0x02000000; // 33554432
const COLOR_MODE_RGB = 0x03000000;  // 50331648

function resolveXtermColor(mode: number, value: number, defaultColor: string): string {
  switch (mode) {
    case COLOR_MODE_P16:
    case COLOR_MODE_P256:
      return ANSI_256_PALETTE[value & 0xff] ?? defaultColor;
    case COLOR_MODE_RGB:
      return `#${((value >> 16) & 0xff).toString(16).padStart(2, '0')}${((value >> 8) & 0xff).toString(16).padStart(2, '0')}${(value & 0xff).toString(16).padStart(2, '0')}`;
    default:
      return defaultColor;
  }
}

// ============================================================================
// Styled span extraction from xterm buffer
// ============================================================================

export interface StyledSpan {
  text: string;
  cells: number;
  fg: string;
  bg: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
  strikethrough: boolean;
}

export type StyledRow = StyledSpan[];

function spanStyleKey(span: StyledSpan): string {
  return `${span.fg}|${span.bg ?? ''}|${span.bold ? 'b' : ''}${span.italic ? 'i' : ''}${span.underline ? 'u' : ''}${span.dim ? 'd' : ''}${span.strikethrough ? 's' : ''}`;
}

export function extractStyledRows(
  xterm: XTerminal,
  options: { trimTrailingBlank?: boolean; includeScrollback?: boolean; scrollbackLines?: number } = {}
): StyledRow[] {
  const buffer = xterm.buffer.active;
  const rows: StyledRow[] = [];
  const nullCell = buffer.getNullCell();

  const scrollbackLines = options.scrollbackLines ?? 80;
  const includeScrollback = options.includeScrollback === true || (options.scrollbackLines ?? 0) > 0;
  const viewportStart = includeScrollback
    ? Math.max(0, buffer.baseY - scrollbackLines)
    : buffer.baseY;
  const rowCount = includeScrollback
    ? Math.max(xterm.rows, buffer.baseY - viewportStart + xterm.rows)
    : xterm.rows;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const line = buffer.getLine(viewportStart + rowIndex);
    if (!line) {
      rows.push([]);
      continue;
    }

    const spans: StyledSpan[] = [];
    let currentKey = '';
    let currentSpan: StyledSpan | null = null;

    for (let colIndex = 0; colIndex < xterm.cols; colIndex++) {
      const cell = line.getCell(colIndex, nullCell);
      if (!cell) {
        continue;
      }

      const width = cell.getWidth();
      if (width === 0) {
        continue;
      }

      const char = cell.getChars() || ' ';
      const inverse = cell.isInverse() !== 0;

      let fg = resolveXtermColor(cell.getFgColorMode(), cell.getFgColor(), THEME.text);
      let bg: string | null = cell.getBgColorMode() !== COLOR_MODE_DEFAULT
        ? resolveXtermColor(cell.getBgColorMode(), cell.getBgColor(), THEME.background)
        : null;

      if (inverse) {
        const resolvedBg = bg ?? THEME.background;
        bg = fg;
        fg = resolvedBg;
      }

      const span: StyledSpan = {
        text: char,
        cells: width,
        fg,
        bg,
        bold: cell.isBold() !== 0,
        italic: cell.isItalic() !== 0,
        underline: cell.isUnderline() !== 0,
        dim: cell.isDim() !== 0,
        strikethrough: cell.isStrikethrough() !== 0,
      };

      const key = spanStyleKey(span);
      if (currentSpan && key === currentKey) {
        currentSpan.text += char;
        currentSpan.cells += width;
      } else {
        currentSpan = { ...span };
        currentKey = key;
        spans.push(currentSpan);
      }
    }

    rows.push(spans);
  }

  if (options.trimTrailingBlank) {
    while (rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      const rowText = lastRow.map((s) => s.text).join('').trimEnd();
      if (rowText.length === 0) {
        rows.pop();
      } else {
        break;
      }
    }
  }

  return rows;
}

// ============================================================================
// Colored SVG renderer
// ============================================================================

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildSvgDocument(width: number, height: number, body: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    body,
    '</svg>',
  ].join('');
}

export interface RenderStyledSvgOptions {
  title?: string;
  subtitle?: string;
  dimOpacity?: number;
}

export function renderStyledRowsSvg(
  rows: StyledRow[],
  cols: number,
  options: RenderStyledSvgOptions = {},
): string {
  const paddingX = 20;
  const paddingY = 16;
  const headerHeight = 44;
  const cellWidth = 8.4;
  const cellHeight = 18;
  const fontSize = 13;
  const fontFamily = "Menlo, Monaco, 'SF Mono', 'Cascadia Code', monospace";
  const dimOpacity = options.dimOpacity ?? 0.5;

  const displayRows = Math.max(rows.length, 1);
  const displayCols = Math.max(cols, 20);
  const width = Math.round(paddingX * 2 + displayCols * cellWidth);
  const height = headerHeight + paddingY * 2 + displayRows * cellHeight;

  const title = options.title ?? '';
  const subtitle = options.subtitle ?? '';

  const bgRects: string[] = [];
  const textElements: string[] = [];
  const decorationLines: string[] = [];

  // Underline sits 2px below the baseline; strikethrough sits at ~40% up from baseline
  const underlineY = fontSize + 2;
  const strikeY = Math.round(fontSize * 0.6);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const rowY = headerHeight + paddingY + rowIndex * cellHeight;
    const textY = rowY + fontSize;

    let colX = paddingX;

    for (const span of row) {
      const spanWidth = span.cells * cellWidth;

      // Background rect for non-default backgrounds
      if (span.bg !== null) {
        bgRects.push(
          `<rect x="${colX.toFixed(1)}" y="${rowY}" width="${spanWidth.toFixed(1)}" height="${cellHeight}" fill="${span.bg}" />`,
        );
      }

      // Text span (skip all-whitespace spans with no bg)
      const trimmedText = span.text.trimEnd();
      if (trimmedText.length > 0 || span.bg !== null) {
        const attrs: string[] = [
          `x="${colX.toFixed(1)}"`,
          `y="${textY}"`,
          `fill="${span.fg}"`,
        ];

        if (span.bold) {
          attrs.push('font-weight="bold"');
        }
        if (span.italic) {
          attrs.push('font-style="italic"');
        }
        if (span.dim) {
          attrs.push(`opacity="${dimOpacity}"`);
        }

        textElements.push(
          `<text ${attrs.join(' ')} xml:space="preserve">${escapeXml(span.text)}</text>`,
        );
      }

      // Explicit underline and strikethrough lines (SVG text-decoration is unreliable in sips)
      if (span.underline && trimmedText.length > 0) {
        const lineX2 = (colX + span.cells * cellWidth).toFixed(1);
        const opacity = span.dim ? dimOpacity : 1;
        decorationLines.push(
          `<line x1="${colX.toFixed(1)}" y1="${rowY + underlineY}" x2="${lineX2}" y2="${rowY + underlineY}" stroke="${span.fg}" stroke-width="1" opacity="${opacity}" />`,
        );
      }
      if (span.strikethrough && trimmedText.length > 0) {
        const lineX2 = (colX + span.cells * cellWidth).toFixed(1);
        const opacity = span.dim ? dimOpacity : 1;
        decorationLines.push(
          `<line x1="${colX.toFixed(1)}" y1="${rowY + strikeY}" x2="${lineX2}" y2="${rowY + strikeY}" stroke="${span.fg}" stroke-width="1" opacity="${opacity}" />`,
        );
      }

      colX += spanWidth;
    }
  }

  return buildSvgDocument(width, height, `
    <rect width="100%" height="100%" rx="14" ry="14" fill="${THEME.background}" stroke="${THEME.border}" />
    <rect x="1" y="1" width="${width - 2}" height="${headerHeight}" rx="14" ry="14" fill="${THEME.header}" />
    <circle cx="18" cy="${headerHeight / 2}" r="5" fill="#ff5f57" />
    <circle cx="34" cy="${headerHeight / 2}" r="5" fill="#febc2e" />
    <circle cx="50" cy="${headerHeight / 2}" r="5" fill="#28c840" />
    <text x="66" y="${headerHeight / 2 - 5}" fill="${THEME.title}" font-family="${fontFamily}" font-size="14" font-weight="600">${escapeXml(title)}</text>
    <text x="66" y="${headerHeight / 2 + 9}" fill="${THEME.subtitle}" font-family="${fontFamily}" font-size="11">${escapeXml(subtitle)}</text>
    <text x="${width - 16}" y="${headerHeight / 2 - 4}" text-anchor="end" fill="${THEME.accent}" font-family="${fontFamily}" font-size="11">${displayCols}x${displayRows}</text>
    <rect x="0" y="${headerHeight}" width="${width}" height="${height - headerHeight}" fill="${THEME.background}" />
    <g font-family="${fontFamily}" font-size="${fontSize}" style="font-variant-ligatures:none;">
      ${bgRects.join('\n      ')}
      ${textElements.join('\n      ')}
      ${decorationLines.join('\n      ')}
    </g>
  `);
}

// ============================================================================
// Legacy plain-text SVG renderer (kept for tests / fallback)
// ============================================================================

export interface RenderSnapshotSvgOptions {
  title?: string;
  subtitle?: string;
  includeScrollback?: boolean;
}

export function renderTerminalSnapshotSvg(snapshot: TerminalSnapshot, options: RenderSnapshotSvgOptions = {}): string {
  const includeScrollback = options.includeScrollback ?? false;
  const lines = includeScrollback
    ? [...snapshot.screen.scrollbackTail, ...snapshot.screen.visible]
    : [...snapshot.screen.visible];

  const paddingX = 20;
  const paddingY = 16;
  const headerHeight = 44;
  const cellWidth = 8.4;
  const cellHeight = 18;
  const fontSize = 13;
  const fontFamily = "Menlo, Monaco, 'SF Mono', 'Cascadia Code', monospace";
  const cols = Math.max(snapshot.terminal.cols, 20);
  const displayRows = Math.max(lines.length, snapshot.terminal.rows, 1);
  const width = Math.round(paddingX * 2 + cols * cellWidth);
  const height = headerHeight + paddingY * 2 + displayRows * cellHeight;
  const title = options.title ?? snapshot.metadata.processTitle ?? snapshot.sessionId;
  const subtitle = options.subtitle ?? `replay ${snapshot.replayId} - t=${snapshot.timeMs}ms`;

  const textElements = (lines.length > 0 ? lines : ['']).map((line, index) => {
    const y = headerHeight + paddingY + fontSize + index * cellHeight;
    const content = line.length > 0 ? escapeXml(line) : '&#160;';
    return `<text x="${paddingX}" y="${y}" xml:space="preserve">${content}</text>`;
  }).join('');

  return buildSvgDocument(width, height, `
    <rect width="100%" height="100%" rx="14" ry="14" fill="${THEME.background}" stroke="${THEME.border}" />
    <rect x="1" y="1" width="${width - 2}" height="${headerHeight}" rx="14" ry="14" fill="${THEME.header}" />
    <circle cx="18" cy="${headerHeight / 2}" r="5" fill="#ff5f57" />
    <circle cx="34" cy="${headerHeight / 2}" r="5" fill="#febc2e" />
    <circle cx="50" cy="${headerHeight / 2}" r="5" fill="#28c840" />
    <text x="66" y="${headerHeight / 2 - 5}" fill="${THEME.title}" font-family="${fontFamily}" font-size="14" font-weight="600">${escapeXml(title)}</text>
    <text x="66" y="${headerHeight / 2 + 9}" fill="${THEME.subtitle}" font-family="${fontFamily}" font-size="11">${escapeXml(subtitle)}</text>
    <text x="${width - 16}" y="${headerHeight / 2 - 4}" text-anchor="end" fill="${THEME.accent}" font-family="${fontFamily}" font-size="11">${snapshot.terminal.cols}x${snapshot.terminal.rows}</text>
    <g fill="${THEME.text}" font-family="${fontFamily}" font-size="${fontSize}" style="font-variant-ligatures:none;">
      ${textElements}
    </g>
  `);
}

// ============================================================================
// PNG writing helpers
// ============================================================================

export interface ReplayScreenshotOptions extends ReplaySnapshotOptions {
  outputPath: string;
  includeScrollback?: boolean;
}

async function writeSvgAsPng(svg: string, outputPath: string, replayId?: string): Promise<string> {
  const rasterizer = findPngRasterizer();
  const absoluteOutputPath = resolve(outputPath);

  if (!rasterizer) {
    throw logAndCreateScreenshotError(
      'No PNG rasterizer found. Install ImageMagick or use a system with sips available.',
      { replayId, outputPath: absoluteOutputPath },
    );
  }

  try {
    mkdirSync(dirname(absoluteOutputPath), { recursive: true });
  } catch (error) {
    throw logAndCreateScreenshotError(
      'Failed to prepare replay screenshot output directory.',
      { replayId, outputPath: absoluteOutputPath, rasterizer: rasterizer.kind },
      error,
    );
  }

  let tempDir: string;
  try {
    tempDir = mkdtempSync(join(tmpdir(), 'gitspace-replay-shot-'));
  } catch (error) {
    throw logAndCreateScreenshotError(
      'Failed to create temporary screenshot directory.',
      { replayId, outputPath: absoluteOutputPath, rasterizer: rasterizer.kind },
      error,
    );
  }
  const tempSvgPath = join(tempDir, 'snapshot.svg');
  let result: string | null = null;
  let pendingError: Error | null = null;

  try {
    try {
      writeFileSync(tempSvgPath, svg, 'utf-8');
    } catch (error) {
      throw logAndCreateScreenshotError(
        'Failed to write temporary replay screenshot SVG.',
        { replayId, outputPath: absoluteOutputPath, rasterizer: rasterizer.kind },
        error,
      );
    }

    await rasterizeSvg(tempSvgPath, absoluteOutputPath, rasterizer, {
      replayId,
      outputPath: absoluteOutputPath,
    });

    if (!existsSync(absoluteOutputPath)) {
      throw logAndCreateScreenshotError(
        `Screenshot was not written: ${absoluteOutputPath}`,
        { replayId, outputPath: absoluteOutputPath, rasterizer: rasterizer.kind },
      );
    }

    let size: number;
    try {
      size = statSync(absoluteOutputPath).size;
    } catch (error) {
      throw logAndCreateScreenshotError(
        'Failed to read replay screenshot output metadata.',
        { replayId, outputPath: absoluteOutputPath, rasterizer: rasterizer.kind },
        error,
      );
    }

    if (size <= 0) {
      throw logAndCreateScreenshotError(
        `Screenshot is empty: ${absoluteOutputPath}`,
        { replayId, outputPath: absoluteOutputPath, rasterizer: rasterizer.kind },
      );
    }

    result = absoluteOutputPath;
  } catch (error) {
    pendingError = error instanceof ReplayScreenshotError || error instanceof SpacesError
      ? error
      : logAndCreateScreenshotError(
        'Unexpected replay screenshot failure.',
        { replayId, outputPath: absoluteOutputPath, rasterizer: rasterizer.kind },
        error,
      );
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      const cleanupFailure = logAndCreateScreenshotError(
        'Failed to clean up temporary replay screenshot files.',
        { replayId, outputPath: absoluteOutputPath, rasterizer: rasterizer.kind },
        error,
      );
      if (!pendingError) {
        pendingError = cleanupFailure;
      }
    }
  }

  if (pendingError) {
    throw pendingError;
  }

  return result as string;
}

// Legacy: write from TerminalSnapshot (plain text, no colors)
export async function writeTerminalSnapshotPng(
  snapshot: TerminalSnapshot,
  outputPath: string,
  options: RenderSnapshotSvgOptions = {},
): Promise<string> {
  return writeSvgAsPng(renderTerminalSnapshotSvg(snapshot, options), outputPath, snapshot.replayId);
}

// Primary: write directly from replay, using colored xterm buffer extraction
export async function writeReplayScreenshot(replayId: string, options: ReplayScreenshotOptions): Promise<string> {
  const manifest = readReplayManifest(replayId);
  if (!manifest) {
    logger.error(`[replay.screenshot] Replay manifest not found: replayId=${replayId} outputPath=${resolve(options.outputPath)}`);
    throw new SpacesError(`Replay manifest not found: ${replayId}`, 'USER_ERROR', 1);
  }

  const state = await reconstructReplayAt(replayId, options.atMs);
  try {
    const rows = extractStyledRows(state.xterm, {
      trimTrailingBlank: true,
      includeScrollback: options.includeScrollback,
      scrollbackLines: options.scrollbackLines,
    });
    const svg = renderStyledRowsSvg(rows, state.cols, {
      title: manifest.sessionName || manifest.sessionId,
      subtitle: `replay ${manifest.replayId.slice(0, 16)} · t=${state.timeMs}ms`,
    });
    return await writeSvgAsPng(svg, options.outputPath, replayId);
  } finally {
    state.xterm.dispose();
  }
}

export function readPngDimensions(pngPath: string): { width: number; height: number } {
  let file: Buffer;
  try {
    file = readFileSync(pngPath);
  } catch (error) {
    throw logAndCreateScreenshotError('Failed to read PNG file.', { outputPath: resolve(pngPath) }, error);
  }

  if (file.length < 24 || file.toString('ascii', 1, 4) !== 'PNG') {
    throw logAndCreateScreenshotError(`Invalid PNG file: ${pngPath}`, { outputPath: resolve(pngPath) });
  }

  return {
    width: file.readUInt32BE(16),
    height: file.readUInt32BE(20),
  };
}
