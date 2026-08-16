import type { WorkspaceInfo } from '../../../components/SpacesBrowser.js';
import type { WorkspaceEditorId, WorkspaceEditorOption } from '../../../utils/open-editor.js';

interface ShowWorkspaceEditorSelectConfig {
  workspace: WorkspaceInfo;
  showSelect: (config: {
    title: string;
    searchable?: boolean;
    options: Array<{ label: string; description?: string; value: string }>;
    onSelect: (value: string) => void | Promise<void>;
  }) => void;
  showMessage: (config: { title: string; message: string; variant?: 'info' | 'success' | 'warning' | 'error' }) => void;
  listAvailableEditors: () => Promise<WorkspaceEditorOption[]>;
  openInEditor: (editorId: WorkspaceEditorId) => void | Promise<void>;
}

export async function showWorkspaceEditorSelect(args: ShowWorkspaceEditorSelectConfig): Promise<void> {
  const editors = await args.listAvailableEditors();
  if (editors.length === 0) {
    args.showMessage({
      title: 'Open in Editor',
      message: `No supported editor CLIs were detected for ${args.workspace.name}. Install Cursor, VS Code, or Zed and make its CLI available in PATH.`,
      variant: 'info',
    });
    return;
  }

  if (editors.length === 1) {
    await args.openInEditor(editors[0]!.id);
    return;
  }

  const editorById = new Map(editors.map((editor) => [editor.id, editor]));
  args.showSelect({
    title: `${args.workspace.name} Editors`,
    searchable: true,
    options: editors.map((editor) => ({
      label: editor.label,
      description: editor.description,
      value: editor.id,
    })),
    onSelect: async (value) => {
      const selected = editorById.get(value as WorkspaceEditorId);
      if (selected) {
        await args.openInEditor(selected.id);
      }
    },
  });
}
