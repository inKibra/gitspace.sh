import { spawn } from 'child_process';
import { checkCommandExists } from './deps.js';

export type WorkspaceEditorId = 'cursor' | 'vscode' | 'zed';

export interface WorkspaceEditorOption {
  id: WorkspaceEditorId;
  label: string;
  command: string;
  description: string;
}

export type OpenEditorResult =
  | { ok: true }
  | { ok: false; message: string };

const EDITOR_CANDIDATES: Array<{
  id: WorkspaceEditorId;
  label: string;
  commands: string[];
}> = [
  { id: 'cursor', label: 'Cursor', commands: ['cursor'] },
  { id: 'vscode', label: 'VS Code', commands: ['code'] },
  { id: 'zed', label: 'Zed', commands: ['zed', 'zeditor'] },
];

async function resolveEditorCommand(editorId: WorkspaceEditorId): Promise<string | null> {
  const candidate = EDITOR_CANDIDATES.find((entry) => entry.id === editorId);
  if (!candidate) {
    return null;
  }

  for (const command of candidate.commands) {
    if (await checkCommandExists(command)) {
      return command;
    }
  }

  return null;
}

export async function listAvailableEditors(): Promise<WorkspaceEditorOption[]> {
  const available: WorkspaceEditorOption[] = [];

  for (const candidate of EDITOR_CANDIDATES) {
    const command = await resolveEditorCommand(candidate.id);
    if (!command) {
      continue;
    }
    available.push({
      id: candidate.id,
      label: candidate.label,
      command,
      description: `Open workspace with ${candidate.label}`,
    });
  }

  return available;
}

export async function openWorkspaceInEditor(editorId: WorkspaceEditorId, workspacePath: string): Promise<OpenEditorResult> {
  const command = await resolveEditorCommand(editorId);
  if (!command) {
    const label = EDITOR_CANDIDATES.find((entry) => entry.id === editorId)?.label ?? editorId;
    return {
      ok: false,
      message: `${label} is not installed on this machine or its CLI is not available in PATH.`,
    };
  }

  try {
    const child = spawn(command, [workspacePath], {
      cwd: workspacePath,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
