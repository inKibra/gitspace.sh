import { join, resolve, relative, isAbsolute } from 'node:path';
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { getPiAgentDir } from './pi-runtime.js';

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

function parseSessionHeader(content: string): SessionHeader | null {
  const firstLineEnd = content.indexOf('\n');
  const firstLine = (firstLineEnd === -1 ? content : content.slice(0, firstLineEnd)).trimEnd();
  if (!firstLine) return null;

  try {
    const header = JSON.parse(firstLine) as SessionHeader;
    if (header.type !== 'session' || typeof header.id !== 'string') {
      return null;
    }
    return header;
  } catch {
    return null;
  }
}

function parseSessionIdFromFile(filePath: string): string | null {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
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
    content = readFileSync(filePath, 'utf-8');
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
