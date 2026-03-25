/**
 * Direct Pi session file reader.
 *
 * Reads Pi/omp session JSONL files from disk without going through
 * SessionManager (which depends on module-load-time state for agent dir resolution).
 *
 * Pi stores sessions at:
 *   <agentDir>/sessions/<encodedCwd>/<timestamp>_<id>.jsonl
 *
 * Where <encodedCwd> encodes the working directory path:
 *   - Paths under $HOME: "-" + relative path with / replaced by -
 *   - Paths under $TMPDIR: "-tmp" + relative path with / replaced by -
 *   - Other: absolute path with / replaced by -
 */

import { join, resolve, relative } from 'node:path';
import { readdirSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
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
  timestamp?: string;
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
  if (candidate === root) {
    return true;
  }
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !rel.startsWith('/');
}

/**
 * Encode a working directory path the way Pi does for session storage.
 */
export function encodeSessionDirName(cwd: string): string {
  const resolved = resolve(cwd);
  const canonicalCwd = resolveEquivalentPath(resolved);
  const configuredHome = process.env.HOME?.trim();
  const home = resolveEquivalentPath(configuredHome && configuredHome.length > 0 ? configuredHome : homedir());
  const tempRoot = resolveEquivalentPath(tmpdir());

  if (pathIsWithin(home, canonicalCwd)) {
    const rel = relative(home, canonicalCwd).replace(/[/\\:]/g, '-');
    return rel ? `-${rel}` : '-';
  }

  if (pathIsWithin(tempRoot, canonicalCwd)) {
    const rel = relative(tempRoot, canonicalCwd).replace(/[/\\:]/g, '-');
    return rel ? `-tmp-${rel}` : '-tmp';
  }

  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
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
function getSessionDirForCwd(cwd: string, sessionsRoot?: string): string {
  const root = sessionsRoot ?? getDefaultSessionsRoot();
  return join(root, encodeSessionDirName(cwd));
}

/**
 * List all Pi sessions for a given workspace cwd.
 * Reads session JSONL files directly from disk.
 * @param sessionsRoot Override the sessions root directory (for testing).
 */
export function listPiSessions(cwd: string, sessionsRoot?: string): PiSessionFileInfo[] {
  const sessionDir = getSessionDirForCwd(cwd, sessionsRoot);
  if (!existsSync(sessionDir)) return [];

  const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));
  const sessions: PiSessionFileInfo[] = [];

  for (const file of files) {
    const filePath = join(sessionDir, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const firstLine = content.split('\n')[0];
      if (!firstLine) continue;

      const header: SessionHeader & { title?: string } = JSON.parse(firstLine);
      if (header.type !== 'session') continue;

      // Count messages and find first user message
      const lines = content.split('\n').filter(Boolean);
      let messageCount = 0;
      let firstMessage: string | undefined;
      let title: string | undefined = typeof header.title === 'string' ? header.title : undefined;

      for (const line of lines.slice(1)) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'message' && entry.message?.role === 'user') {
            messageCount++;
            if (!firstMessage) {
              const content = entry.message.content;
              firstMessage = typeof content === 'string'
                ? content.slice(0, 200)
                : Array.isArray(content)
                  ? content.find((p: any) => p.type === 'text')?.text?.slice(0, 200)
                  : undefined;
            }
          } else if (entry.type === 'message' && entry.message?.role === 'assistant') {
            messageCount++;
          } else if (entry.type === 'session_info' && entry.name) {
            title = entry.name;
          }
        } catch {
          // skip unparseable lines
        }
      }

      const stat = statSync(filePath);

      sessions.push({
        id: header.id,
        path: filePath,
        cwd: header.cwd,
        title,
        firstMessage,
        created: header.timestamp ? new Date(header.timestamp) : stat.birthtime,
        modified: stat.mtime,
        messageCount,
      });
    } catch {
      // skip unreadable files
    }
  }

  // Sort by modified time, newest first
  return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/**
 * Find a specific session file by ID for a given workspace cwd.
 * @param sessionsRoot Override the sessions root directory (for testing).
 */
export function findPiSessionFile(cwd: string, sessionId: string, sessionsRoot?: string): PiSessionFileInfo | null {
  const sessions = listPiSessions(cwd, sessionsRoot);
  return sessions.find((s) => s.id === sessionId) ?? null;
}
