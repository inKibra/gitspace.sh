import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { getProjectWorkspacesDir, readProjectConfig, writeProjectConfig } from './config.js';
import type { WorkspacePhase } from '../types/config.js';
import type { WorkspaceNote, WorkspaceNotePriority, WorkspaceNotesSummary } from '../types/workspace.js';
import { generateId } from '../utils/id.js';

const WORKSPACE_STORAGE_DIR = join('.gitspace', 'workspace');
const WORKSPACE_STORAGE_GITIGNORE_ENTRY = '.gitspace/workspace/';
const WORKSPACE_STORAGE_GITIGNORE_MARKER = '# gssh workspace local state';

export interface WorkspaceMetadata {
  version: 1;
  updatedAt: string;
  status?: WorkspacePhase;
}

function nowIso(): string {
  return new Date().toISOString();
}

function workspacePath(projectName: string, workspaceName: string): string {
  return join(getProjectWorkspacesDir(projectName), workspaceName);
}

export function getWorkspaceStorageDir(workspacePath: string, workspaceName: string): string {
  return join(workspacePath, WORKSPACE_STORAGE_DIR, workspaceName);
}

export function getWorkspaceMetadataPath(workspacePath: string, workspaceName: string): string {
  return join(getWorkspaceStorageDir(workspacePath, workspaceName), 'metadata.json');
}

export function getWorkspaceNotesPath(workspacePath: string, workspaceName: string): string {
  return join(getWorkspaceStorageDir(workspacePath, workspaceName), 'notes.json');
}

export function getWorkspaceReviewPath(workspacePath: string, workspaceName: string): string {
  return join(getWorkspaceStorageDir(workspacePath, workspaceName), 'review.json');
}

export function ensureWorkspaceStorageIgnored(workspacePath: string): void {
  const gitignorePath = join(workspacePath, '.gitignore');
  const alreadyIgnored =
    existsSync(gitignorePath) && readFileSync(gitignorePath, 'utf-8').includes(WORKSPACE_STORAGE_GITIGNORE_ENTRY);
  if (alreadyIgnored) {
    return;
  }
  appendFileSync(
    gitignorePath,
    `\n${WORKSPACE_STORAGE_GITIGNORE_MARKER}\n${WORKSPACE_STORAGE_GITIGNORE_ENTRY}\n`,
    'utf-8',
  );
}

function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
}

function readLegacyWorkspaceStatus(projectName: string, workspaceName: string): WorkspacePhase | undefined {
  try {
    const projectConfig = readProjectConfig(projectName) as { workspaceStatus?: Record<string, WorkspacePhase> };
    return projectConfig.workspaceStatus?.[workspaceName];
  } catch {
    return undefined;
  }
}

function clearLegacyWorkspaceStatus(projectName: string, workspaceName: string): void {
  try {
    const projectConfig = readProjectConfig(projectName) as unknown as Record<string, unknown> & {
      workspaceStatus?: Record<string, WorkspacePhase>;
    };
    if (!projectConfig.workspaceStatus?.[workspaceName]) {
      return;
    }
    const nextWorkspaceStatus = { ...projectConfig.workspaceStatus };
    delete nextWorkspaceStatus[workspaceName];
    const nextConfig: Record<string, unknown> = { ...projectConfig };
    if (Object.keys(nextWorkspaceStatus).length > 0) {
      nextConfig.workspaceStatus = nextWorkspaceStatus;
    } else {
      delete nextConfig.workspaceStatus;
    }
    writeProjectConfig(projectName, nextConfig as never);
  } catch {
    // ignore cleanup failures
  }
}

export function readWorkspaceMetadata(projectName: string, workspaceName: string): WorkspaceMetadata {
  const wsPath = workspacePath(projectName, workspaceName);
  const filePath = getWorkspaceMetadataPath(wsPath, workspaceName);
  const metadata = readJsonFile<WorkspaceMetadata>(filePath) ?? {
    version: 1,
    updatedAt: nowIso(),
  };

  if (metadata.status === undefined) {
    const legacyStatus = readLegacyWorkspaceStatus(projectName, workspaceName);
    if (legacyStatus !== undefined) {
      const migrated: WorkspaceMetadata = {
        ...metadata,
        status: legacyStatus,
        updatedAt: nowIso(),
      };
      writeWorkspaceMetadata(projectName, workspaceName, migrated);
      clearLegacyWorkspaceStatus(projectName, workspaceName);
      return migrated;
    }
  }

  return metadata;
}

export function writeWorkspaceMetadata(projectName: string, workspaceName: string, metadata: WorkspaceMetadata): void {
  const wsPath = workspacePath(projectName, workspaceName);
  ensureWorkspaceStorageIgnored(wsPath);
  const filePath = getWorkspaceMetadataPath(wsPath, workspaceName);
  ensureParentDir(filePath);
  writeFileSync(filePath, JSON.stringify({ ...metadata, version: 1, updatedAt: nowIso() }, null, 2), 'utf-8');
}

export function getWorkspaceStatus(projectName: string, workspaceName: string): WorkspacePhase | undefined {
  return readWorkspaceMetadata(projectName, workspaceName).status;
}

export function setWorkspaceStatus(projectName: string, workspaceName: string, status: WorkspacePhase): void {
  const current = readWorkspaceMetadata(projectName, workspaceName);
  writeWorkspaceMetadata(projectName, workspaceName, {
    ...current,
    status,
  });
}

export function listWorkspaceNotes(projectName: string, workspaceName: string): WorkspaceNote[] {
  const wsPath = workspacePath(projectName, workspaceName);
  const filePath = getWorkspaceNotesPath(wsPath, workspaceName);
  return readJsonFile<WorkspaceNote[]>(filePath) ?? [];
}

function writeWorkspaceNotes(projectName: string, workspaceName: string, notes: WorkspaceNote[]): void {
  const wsPath = workspacePath(projectName, workspaceName);
  ensureWorkspaceStorageIgnored(wsPath);
  const filePath = getWorkspaceNotesPath(wsPath, workspaceName);
  ensureParentDir(filePath);
  writeFileSync(filePath, JSON.stringify(notes, null, 2), 'utf-8');
}

export function addWorkspaceNote(
  projectName: string,
  workspaceName: string,
  args: { body: string; kind?: WorkspaceNote['kind']; priority?: WorkspaceNotePriority },
): WorkspaceNote {
  const note: WorkspaceNote = {
    id: generateId(),
    body: args.body,
    kind: args.kind ?? 'note',
    priority: args.kind === 'todo' ? (args.priority ?? 'medium') : undefined,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const notes = listWorkspaceNotes(projectName, workspaceName);
  notes.push(note);
  writeWorkspaceNotes(projectName, workspaceName, notes);
  return note;
}

export function updateWorkspaceNote(
  projectName: string,
  workspaceName: string,
  noteId: string,
  updates: Partial<Pick<WorkspaceNote, 'body' | 'kind' | 'priority' | 'doneAt'>>,
): WorkspaceNote {
  const notes = listWorkspaceNotes(projectName, workspaceName);
  const index = notes.findIndex((note) => note.id === noteId);
  if (index === -1) {
    throw new Error(`Workspace note not found: ${noteId}`);
  }
  const current = notes[index];
  const nextKind = updates.kind ?? current.kind;
  const next: WorkspaceNote = {
    ...current,
    ...updates,
    kind: nextKind,
    priority: nextKind === 'todo' ? (updates.priority ?? current.priority ?? 'medium') : undefined,
    updatedAt: nowIso(),
  };
  notes[index] = next;
  writeWorkspaceNotes(projectName, workspaceName, notes);
  return next;
}

export function removeWorkspaceNote(projectName: string, workspaceName: string, noteId: string): boolean {
  const notes = listWorkspaceNotes(projectName, workspaceName);
  const next = notes.filter((note) => note.id !== noteId);
  if (next.length === notes.length) {
    return false;
  }
  writeWorkspaceNotes(projectName, workspaceName, next);
  return true;
}

export function summarizeWorkspaceNotes(notes: WorkspaceNote[]): WorkspaceNotesSummary {
  const openTodos = notes
    .filter((note) => note.kind === 'todo' && !note.doneAt)
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || b.updatedAt.localeCompare(a.updatedAt));
  const doneTodos = notes.filter((note) => note.kind === 'todo' && note.doneAt);
  const recentNotes = [...notes]
    .filter((note) => note.kind === 'note')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 3);
  const updatedAt = [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.updatedAt;

  return {
    total: notes.length,
    openTodoCount: openTodos.length,
    doneTodoCount: doneTodos.length,
    highPriorityOpenTodoCount: openTodos.filter((note) => note.priority === 'high').length,
    topOpenTodos: openTodos.slice(0, 5),
    recentNotes,
    updatedAt,
  };
}

function priorityRank(priority?: WorkspaceNotePriority): number {
  switch (priority) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
}
