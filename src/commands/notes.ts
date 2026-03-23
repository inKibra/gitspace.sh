import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import {
  addWorkspaceNote,
  listWorkspaceNotes,
  removeWorkspaceNote,
  summarizeWorkspaceNotes,
  updateWorkspaceNote,
} from '../core/workspace-metadata.js';
import type { WorkspaceNotePriority } from '../types/workspace.js';
import { readTextFromStdin } from '../utils/read-stdin-text.js';

type NotesFormat = 'json' | 'text';

interface WorkspaceNotesContextOptions {
  project?: string;
  workspace?: string;
}

function resolveWorkspaceContext(options: WorkspaceNotesContextOptions): { projectName: string; workspaceName: string } {
  const projectName = options.project ?? process.env.GSSH_SPACE_PROJECT;
  const workspaceName = options.workspace ?? process.env.GSSH_SPACE_WORKSPACE;
  if (!projectName || !workspaceName) {
    throw new SpacesError('Could not determine current project/workspace. Use --project and --workspace flags.', 'USER_ERROR', 1);
  }
  return { projectName, workspaceName };
}

function printNotesText(projectName: string, workspaceName: string): void {
  const notes = listWorkspaceNotes(projectName, workspaceName);
  if (notes.length === 0) {
    logger.log('No workspace notes found.');
    return;
  }
  for (const note of notes) {
    const marker = note.kind === 'todo' ? (note.doneAt ? '[x]' : '[ ]') : '-';
    const priority = note.kind === 'todo' && note.priority ? ` (${note.priority})` : '';
    logger.log(`${marker} ${note.id}${priority} ${note.body}`);
  }
}

export async function listNotes(options: WorkspaceNotesContextOptions & { format?: NotesFormat } = {}): Promise<void> {
  const { projectName, workspaceName } = resolveWorkspaceContext(options);
  const notes = listWorkspaceNotes(projectName, workspaceName);
  if (options.format === 'text') {
    printNotesText(projectName, workspaceName);
    return;
  }
  console.log(JSON.stringify({
    projectName,
    workspaceName,
    summary: summarizeWorkspaceNotes(notes),
    notes,
  }, null, 2));
}

export async function addNote(options: WorkspaceNotesContextOptions & {
  body?: string;
  stdin?: boolean;
  todo?: boolean;
  priority?: WorkspaceNotePriority;
  json?: boolean;
} = {}): Promise<void> {
  const { projectName, workspaceName } = resolveWorkspaceContext(options);
  if (options.stdin && options.body !== undefined) {
    throw new SpacesError('Choose only one of --body or --stdin.', 'USER_ERROR', 1);
  }
  const body = options.stdin ? await readTextFromStdin() : options.body?.trim();
  if (!body) {
    throw new SpacesError('Provide note text with --body or --stdin.', 'USER_ERROR', 1);
  }
  const note = addWorkspaceNote(projectName, workspaceName, {
    body,
    kind: options.todo ? 'todo' : 'note',
    priority: options.todo ? options.priority : undefined,
  });
  if (options.json) {
    console.log(JSON.stringify(note, null, 2));
    return;
  }
  logger.success(`Added ${note.kind} ${note.id}`);
}

export async function updateNote(options: WorkspaceNotesContextOptions & {
  id?: string;
  body?: string;
  todo?: boolean;
  note?: boolean;
  priority?: WorkspaceNotePriority;
  done?: boolean;
  undone?: boolean;
  json?: boolean;
} = {}): Promise<void> {
  const { projectName, workspaceName } = resolveWorkspaceContext(options);
  if (!options.id) {
    throw new SpacesError('--id is required', 'USER_ERROR', 1);
  }
  if (options.todo && options.note) {
    throw new SpacesError('Choose only one of --todo or --note.', 'USER_ERROR', 1);
  }
  if (options.done && options.undone) {
    throw new SpacesError('Choose only one of --done or --undone.', 'USER_ERROR', 1);
  }
  const note = updateWorkspaceNote(projectName, workspaceName, options.id, {
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(options.todo ? { kind: 'todo' as const } : {}),
    ...(options.note ? { kind: 'note' as const } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
    ...(options.done ? { doneAt: new Date().toISOString() } : {}),
    ...(options.undone ? { doneAt: undefined } : {}),
  });
  if (options.json) {
    console.log(JSON.stringify(note, null, 2));
    return;
  }
  logger.success(`Updated ${note.kind} ${note.id}`);
}

export async function removeNote(options: WorkspaceNotesContextOptions & { id?: string; json?: boolean } = {}): Promise<void> {
  const { projectName, workspaceName } = resolveWorkspaceContext(options);
  if (!options.id) {
    throw new SpacesError('--id is required', 'USER_ERROR', 1);
  }
  const removed = removeWorkspaceNote(projectName, workspaceName, options.id);
  if (!removed) {
    throw new SpacesError(`Workspace note not found: ${options.id}`, 'USER_ERROR', 1);
  }
  if (options.json) {
    console.log(JSON.stringify({ removed: true, id: options.id }, null, 2));
    return;
  }
  logger.success(`Removed note ${options.id}`);
}

export async function markNoteDone(options: WorkspaceNotesContextOptions & { id?: string; json?: boolean }): Promise<void> {
  await updateNote({ ...options, done: true });
}

export async function markNoteUndone(options: WorkspaceNotesContextOptions & { id?: string; json?: boolean }): Promise<void> {
  await updateNote({ ...options, undone: true });
}
