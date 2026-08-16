import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  addWorkspaceNote,
  getWorkspaceNotesPath,
  listWorkspaceNotes,
} from '../workspace-metadata.js';

let root: string;
let previousRoot: string | undefined;
let workspaceDir: string;
const projectName = 'notes-project';
const workspaceName = 'notes-workspace';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-metadata-'));
  previousRoot = process.env.GITSPACE_WORKSPACE_ROOT;
  process.env.GITSPACE_WORKSPACE_ROOT = root;
  workspaceDir = join(root, projectName, 'workspaces', workspaceName);
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
  else process.env.GITSPACE_WORKSPACE_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('workspace metadata notes persistence boundaries', () => {
  it('degrades malformed notes JSON to an empty list and surfaces a diagnostic', () => {
    const notesPath = getWorkspaceNotesPath(workspaceDir, workspaceName);
    mkdirSync(join(workspaceDir, '.gitspace', 'workspace', workspaceName), { recursive: true });
    writeFileSync(notesPath, '{ not valid JSON', 'utf8');

    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(listWorkspaceNotes(projectName, workspaceName)).toEqual([]);
      expect(warn).toHaveBeenCalled();
      const diagnostic = warn.mock.calls.flat().join(' ');
      expect(diagnostic).toContain('notes.json');
    } finally {
      warn.mockRestore();
    }
  });

  it('degrades a valid JSON object where a notes list is required to an empty list', () => {
    const notesPath = getWorkspaceNotesPath(workspaceDir, workspaceName);
    mkdirSync(join(workspaceDir, '.gitspace', 'workspace', workspaceName), { recursive: true });
    writeFileSync(notesPath, JSON.stringify({ id: 'not-a-list', body: 'invalid persisted record' }), 'utf8');

    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(listWorkspaceNotes(projectName, workspaceName)).toEqual([]);
      expect(warn).toHaveBeenCalled();
      const diagnostic = warn.mock.calls.flat().join(' ');
      expect(diagnostic).toContain('notes.json');
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps valid notes loadable after persistence', () => {
    const created = addWorkspaceNote(projectName, workspaceName, {
      body: 'Keep the persisted note',
      kind: 'note',
    });

    expect(listWorkspaceNotes(projectName, workspaceName)).toEqual([created]);
  });
});
