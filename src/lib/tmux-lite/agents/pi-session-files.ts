import { join, resolve, relative, isAbsolute } from 'node:path';
import { existsSync, realpathSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { getPiAgentDir } from './pi-runtime.js';

/**
 * Max bytes read from the HEAD of a session JSONL when listing sessions. The
 * only fields listing needs — the session header, the leading title record, and
 * the first user message — all live at the very top of the file. Reading the
 * whole transcript (readFileSync) to list a session meant startup seeding of a
 * workspace with many large transcripts froze the daemon event loop for
 * seconds (serve-activate 15s-timeout / "daemon wedged"). 256 KiB is far more
 * than enough for the header + first messages while bounding per-session cost.
 */
const SESSION_LIST_HEAD_BYTES = 256 * 1024;

/** Read up to `maxBytes` from the start of a file (never the whole thing). A
 *  final truncated line is tolerated by callers (they trim + try/catch lines). */
function readFileHead(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf-8', 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

export interface PiSessionFileInfo {
  id: string;
  path: string;
  cwd: string;
  title?: string;
  firstMessage?: string;
  created: Date;
  modified: Date;
  messageCount: number;
}

interface SessionHeader {
  type: 'session';
  id: string;
  cwd: string;
  title?: string;
  timestamp?: string;
}

interface SessionEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  name?: string;
}

const SESSION_FILE_EXTENSION = '.jsonl';

function normalizeSessionPathForComparison(input: string): string {
  const resolved = resolveEquivalentPath(input);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveEquivalentPath(input: string): string {
  const resolved = resolve(input);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeSessionPathForComparison(root);
  const normalizedCandidate = normalizeSessionPathForComparison(candidate);
  const relativePath = relative(normalizedRoot, normalizedCandidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function encodeLegacyAbsoluteSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

function encodeRelativeSessionDirName(prefix: string, root: string, cwd: string): string {
  const rel = relative(root, cwd).replace(/[/\\:]/g, '-');
  return rel ? (prefix.endsWith('-') ? `${prefix}${rel}` : `${prefix}-${rel}`) : prefix;
}

function getDefaultSessionDirName(cwd: string): { encodedDirName: string; resolvedCwd: string } {
  const resolvedCwd = resolveEquivalentPath(cwd);
  const configuredHome = process.env.HOME?.trim();
  const home = resolveEquivalentPath(configuredHome && configuredHome.length > 0 ? configuredHome : homedir());
  const tempRoot = resolveEquivalentPath(tmpdir());

  const encodedDirName = pathIsWithin(home, resolvedCwd)
    ? encodeRelativeSessionDirName('-', home, resolvedCwd)
    : pathIsWithin(tempRoot, resolvedCwd)
      ? encodeRelativeSessionDirName('-tmp', tempRoot, resolvedCwd)
      : encodeLegacyAbsoluteSessionDirName(resolvedCwd);

  return { encodedDirName, resolvedCwd };
}

/**
 * Encode a working directory path the way Pi does for session storage.
 */
export function encodeSessionDirName(cwd: string): string {
  return getDefaultSessionDirName(cwd).encodedDirName;
}

/**
 * Get the default sessions root directory.
 */
export function getDefaultSessionsRoot(): string {
  return join(getPiAgentDir(), 'sessions');
}

/**
 * Get the session directory for a specific workspace cwd.
 */
export function getSessionDirForCwd(cwd: string, sessionsRoot?: string): string {
  const root = sessionsRoot ?? getDefaultSessionsRoot();
  return join(root, encodeSessionDirName(cwd));
}

function extractFirstTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content.slice(0, 200);
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textBlock = content.find((part: unknown) => {
    if (!part || typeof part !== 'object') return false;
    return (part as { type?: unknown }).type === 'text';
  }) as { text?: unknown } | undefined;

  if (!textBlock || typeof textBlock.text !== 'string') {
    return undefined;
  }

  return textBlock.text.slice(0, 200);
}

function listSessionFiles(sessionDir: string): string[] {
  try {
    return readdirSync(sessionDir)
      .filter((fileName) => fileName.endsWith(SESSION_FILE_EXTENSION))
      .map((fileName) => join(sessionDir, fileName));
  } catch {
    return [];
  }
}

// The `session` header is usually the first line, but newer omp session files
// may prepend a fixed-width, in-place-updatable `title` record (so the title can
// be rewritten without rewriting the whole file), which pushes the header down.
// Scan the first few leading records for it.
const MAX_HEADER_SCAN_LINES = 8;

function parseSessionHeader(content: string): SessionHeader | null {
  let lineStart = 0;
  for (let i = 0; i < MAX_HEADER_SCAN_LINES && lineStart < content.length; i++) {
    const lineEnd = content.indexOf('\n', lineStart);
    const line = (lineEnd === -1 ? content.slice(lineStart) : content.slice(lineStart, lineEnd)).trim();
    if (line) {
      try {
        const header = JSON.parse(line) as SessionHeader;
        if (header.type === 'session' && typeof header.id === 'string') {
          return header;
        }
      } catch {
        // not JSON or not the header record — keep scanning
      }
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return null;
}

/** Freshest title from a leading in-place-updatable `title` record, if present. */
function parseLeadingTitle(content: string): string | undefined {
  const end = content.indexOf('\n');
  const line = (end === -1 ? content : content.slice(0, end)).trim();
  if (!line) return undefined;
  try {
    const rec = JSON.parse(line) as { type?: string; title?: unknown };
    if (rec.type === 'title' && typeof rec.title === 'string') {
      const trimmed = rec.title.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  } catch {
    // not a title record
  }
  return undefined;
}

function parseSessionIdFromFile(filePath: string): string | null {
  let content: string;
  try {
    // The header is the first line — the head is all we need.
    content = readFileHead(filePath, SESSION_LIST_HEAD_BYTES);
  } catch {
    return null;
  }

  const header = parseSessionHeader(content);
  if (!header) return null;
  return header.id;
}

function parseSessionInfoFromFile(filePath: string): PiSessionFileInfo | null {
  let content: string;
  try {
    // Head-only: header, leading title, and first user message live at the top.
    // messageCount below therefore counts messages WITHIN the head (approximate
    // for very long transcripts) — it is display-only and not used to drive any
    // behaviour, so an approximate count on huge files is an acceptable trade
    // for not reading the entire transcript just to list it.
    content = readFileHead(filePath, SESSION_LIST_HEAD_BYTES);
  } catch {
    return null;
  }

  const header = parseSessionHeader(content);
  if (!header) return null;

  let messageCount = 0;
  let firstMessage: string | undefined;
  let title: string | undefined = typeof header.title === 'string' ? header.title : undefined;

  let lineStart = content.indexOf('\n') + 1;
  while (lineStart > 0 && lineStart < content.length) {
    const lineEnd = content.indexOf('\n', lineStart);
    const rawLine = lineEnd === -1 ? content.slice(lineStart) : content.slice(lineStart, lineEnd);
    const line = rawLine.trim();
    if (line) {
      try {
        const entry = JSON.parse(line) as SessionEntry;
        if (entry.type === 'message') {
          const role = entry.message?.role;
          if (role === 'user' || role === 'assistant') {
            messageCount++;
            const messageText = extractFirstTextContent(entry.message?.content);
            if (!firstMessage && role === 'user' && messageText) {
              firstMessage = messageText;
            }
          }
        } else if (entry.type === 'session_info' && typeof entry.name === 'string') {
          title = entry.name;
        }
      } catch {
        // skip unparseable lines
      }
    }

    if (lineEnd === -1) {
      break;
    }
    lineStart = lineEnd + 1;
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }

  // A leading in-place-updatable `title` record is the freshest title; prefer it.
  const leadingTitle = parseLeadingTitle(content);
  if (leadingTitle) {
    title = leadingTitle;
  }

  return {
    id: header.id,
    path: filePath,
    cwd: header.cwd,
    title,
    firstMessage,
    created: header.timestamp ? new Date(header.timestamp) : stat.birthtime,
    modified: stat.mtime,
    messageCount,
  };
}

function findSessionFileForId(sessionDir: string, sessionId: string): string | null {
  const sessionFiles = listSessionFiles(sessionDir);
  if (sessionFiles.length === 0) return null;

  const filenameSuffix = `_${sessionId}${SESSION_FILE_EXTENSION}`;
  const fallbackCandidates: string[] = [];

  for (const filePath of sessionFiles) {
    if (!filePath.endsWith(filenameSuffix)) {
      fallbackCandidates.push(filePath);
      continue;
    }
    if (parseSessionIdFromFile(filePath) === sessionId) {
      return filePath;
    }
  }

  for (const filePath of fallbackCandidates) {
    if (parseSessionIdFromFile(filePath) === sessionId) {
      return filePath;
    }
  }

  return null;
}

/**
 * List all Pi sessions for a given workspace cwd.
 * Reads session JSONL files directly from disk.
 * @param sessionsRoot Override the sessions root directory (for testing).
 */
export function listPiSessions(cwd: string, sessionsRoot?: string): PiSessionFileInfo[] {
  const sessionDir = getSessionDirForCwd(cwd, sessionsRoot);
  if (!existsSync(sessionDir)) return [];

  const sessionFiles = listSessionFiles(sessionDir);
  const sessions: PiSessionFileInfo[] = [];

  for (const filePath of sessionFiles) {
    const parsed = parseSessionInfoFromFile(filePath);
    if (parsed) {
      sessions.push(parsed);
    }
  }

  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/**
 * Find a specific session file by ID for a given workspace cwd.
 * @param sessionsRoot Override the sessions root directory (for testing).
 */
export function findPiSessionFile(cwd: string, sessionId: string, sessionsRoot?: string): PiSessionFileInfo | null {
  const sessionDir = getSessionDirForCwd(cwd, sessionsRoot);
  if (!existsSync(sessionDir)) return null;

  const matchedFile = findSessionFileForId(sessionDir, sessionId);
  if (!matchedFile) return null;

  return parseSessionInfoFromFile(matchedFile);
}
