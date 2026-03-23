import { afterEach, describe, expect, mock, test } from 'bun:test';

describe('notes command', () => {
  afterEach(() => {
    mock.restore();
    delete process.env.GSSH_SPACE_PROJECT;
    delete process.env.GSSH_SPACE_WORKSPACE;
  });

  test('adds note text from stdin', async () => {
    process.env.GSSH_SPACE_PROJECT = 'proj';
    process.env.GSSH_SPACE_WORKSPACE = 'ws';
    const addWorkspaceNoteMock = mock(() => ({ id: 'n1', kind: 'note' }));
    const readTextFromStdinMock = mock(async () => 'from stdin');

    mock.module('../../core/workspace-metadata.js', () => ({
      addWorkspaceNote: addWorkspaceNoteMock,
      listWorkspaceNotes: mock(() => []),
      removeWorkspaceNote: mock(() => false),
      summarizeWorkspaceNotes: mock(() => ({ total: 0, openTodoCount: 0, doneTodoCount: 0, highPriorityOpenTodoCount: 0, topOpenTodos: [], recentNotes: [] })),
      updateWorkspaceNote: mock(() => ({})),
    }));
    mock.module('../../utils/read-stdin-text.js', () => ({
      readTextFromStdin: readTextFromStdinMock,
    }));

    const { addNote } = await import(`../notes.js?test=${Date.now()}`);
    await addNote({ stdin: true });

    expect(readTextFromStdinMock).toHaveBeenCalledTimes(1);
    expect(addWorkspaceNoteMock).toHaveBeenCalledWith('proj', 'ws', {
      body: 'from stdin',
      kind: 'note',
      priority: undefined,
    });
  });

  test('rejects using stdin and body together', async () => {
    process.env.GSSH_SPACE_PROJECT = 'proj';
    process.env.GSSH_SPACE_WORKSPACE = 'ws';

    mock.module('../../core/workspace-metadata.js', () => ({
      addWorkspaceNote: mock(() => ({ id: 'n1', kind: 'note' })),
      listWorkspaceNotes: mock(() => []),
      removeWorkspaceNote: mock(() => false),
      summarizeWorkspaceNotes: mock(() => ({ total: 0, openTodoCount: 0, doneTodoCount: 0, highPriorityOpenTodoCount: 0, topOpenTodos: [], recentNotes: [] })),
      updateWorkspaceNote: mock(() => ({})),
    }));

    const { addNote } = await import(`../notes.js?test=${Date.now()}`);

    await expect(addNote({ stdin: true, body: 'hello' })).rejects.toThrow('Choose only one of --body or --stdin.');
  });

  test('requires body or stdin', async () => {
    process.env.GSSH_SPACE_PROJECT = 'proj';
    process.env.GSSH_SPACE_WORKSPACE = 'ws';

    mock.module('../../core/workspace-metadata.js', () => ({
      addWorkspaceNote: mock(() => ({ id: 'n1', kind: 'note' })),
      listWorkspaceNotes: mock(() => []),
      removeWorkspaceNote: mock(() => false),
      summarizeWorkspaceNotes: mock(() => ({ total: 0, openTodoCount: 0, doneTodoCount: 0, highPriorityOpenTodoCount: 0, topOpenTodos: [], recentNotes: [] })),
      updateWorkspaceNote: mock(() => ({})),
    }));

    const { addNote } = await import(`../notes.js?test=${Date.now()}`);

    await expect(addNote({})).rejects.toThrow('Provide note text with --body or --stdin.');
  });
});
