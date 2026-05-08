import { describe, expect, it, mock } from 'bun:test';
import { showWorkspaceEditorSelect } from './showWorkspaceEditorSelect.js';

function createWorkspace() {
  return {
    id: 'demo',
    name: 'Demo',
    path: '/tmp/demo',
    projectName: 'proj',
    sessionCount: 0,
  };
}

describe('showWorkspaceEditorSelect', () => {
  it('shows an info message when no supported editors are detected', async () => {
    const showSelect = mock(() => undefined);
    const showMessage = mock(() => undefined);
    const openInEditor = mock(() => undefined);

    await showWorkspaceEditorSelect({
      workspace: createWorkspace(),
      showSelect,
      showMessage,
      listAvailableEditors: async () => [],
      openInEditor,
    });

    expect(showSelect).not.toHaveBeenCalled();
    expect(openInEditor).not.toHaveBeenCalled();
    expect(showMessage).toHaveBeenCalledWith({
      title: 'Open in Editor',
      message: 'No supported editor CLIs were detected for Demo. Install Cursor, VS Code, or Zed and make its CLI available in PATH.',
      variant: 'info',
    });
  });

  it('opens directly when only one editor is available', async () => {
    const showSelect = mock(() => undefined);
    const showMessage = mock(() => undefined);
    const openInEditor = mock(() => undefined);

    await showWorkspaceEditorSelect({
      workspace: createWorkspace(),
      showSelect,
      showMessage,
      listAvailableEditors: async () => [
        { id: 'cursor', label: 'Cursor', command: 'cursor', description: 'Open workspace with Cursor' },
      ],
      openInEditor,
    });

    expect(showSelect).not.toHaveBeenCalled();
    expect(showMessage).not.toHaveBeenCalled();
    expect(openInEditor).toHaveBeenCalledWith('cursor');
  });

  it('shows a picker when multiple editors are available', async () => {
    const showSelect = mock(() => undefined);
    const showMessage = mock(() => undefined);

    await showWorkspaceEditorSelect({
      workspace: createWorkspace(),
      showSelect,
      showMessage,
      listAvailableEditors: async () => [
        { id: 'cursor', label: 'Cursor', command: 'cursor', description: 'Open workspace with Cursor' },
        { id: 'vscode', label: 'VS Code', command: 'code', description: 'Open workspace with VS Code' },
      ],
      openInEditor: async () => undefined,
    });

    expect(showMessage).not.toHaveBeenCalled();
    expect(showSelect).toHaveBeenCalledTimes(1);
    const config = (showSelect as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as {
      title: string;
      options: Array<{ label: string }>;
    };
    expect(config.title).toBe('Demo Editors');
    expect(config.options.map((option) => option.label)).toEqual(['Cursor', 'VS Code']);
  });
});
