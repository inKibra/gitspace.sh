import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { WorkspaceRemovalTaskBar } from '../WorkspaceRemovalTaskBar.web.js';
import type { WorkspaceRemovalTask } from '../../app/react/useWorkspaceRemovalTasks.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

function task(overrides: Partial<WorkspaceRemovalTask> & Pick<WorkspaceRemovalTask, 'id' | 'label' | 'workspaceName'>): WorkspaceRemovalTask {
  return {
    kind: 'workspace-lifecycle',
    workspaceId: overrides.id,
    ref: { backendKey: 'local', workspaceId: overrides.id },
    status: 'succeeded',
    phase: 'remove',
    startedAt: 1,
    completedAt: 2,
    logLines: [],
    ...overrides,
  };
}

function collectElements(root: Element): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (const child of Array.from(root.children)) {
    if (child.nodeType === 1) {
      result.push(child as HTMLElement, ...collectElements(child));
    }
  }
  return result;
}

function getElementByText(container: HTMLElement, text: string): HTMLElement {
  const element = collectElements(container).find((item) => item.textContent === text);
  if (!element) throw new Error(`Could not find text: ${text}`);
  return element;
}

function getElementsByText(container: HTMLElement, text: string): HTMLElement[] {
  return collectElements(container).filter((item) => item.textContent === text);
}


describe('WorkspaceRemovalTaskBar web selection', () => {
  it('selects clicked rows and renders the selected task panel', async () => {
    const onSelectTask = mock(() => {});
    const view = render(
      <WorkspaceRemovalTaskBar
        tasks={[
          task({ id: 'task-a', label: 'Remove alpha', workspaceName: 'alpha', logLines: ['alpha log'] }),
          task({ id: 'task-b', label: 'Remove beta', workspaceName: 'beta', logLines: ['beta log'] }),
        ]}
        selectedTaskId="task-a"
        onSelectTask={onSelectTask}
        onDismiss={() => {}}
        placement="inline"
      />,
    );

    await act(async () => {
      fireEvent.click(getElementByText(view.container, '0s · logs'));
    });

    await act(async () => {
      fireEvent.click(getElementsByText(view.container, 'Remove alpha')[0]);
    });
    expect(onSelectTask).toHaveBeenCalledWith('task-a');
    expect(getElementByText(view.container, 'alpha log')).toBeTruthy();

    view.rerender(
      <WorkspaceRemovalTaskBar
        tasks={[
          task({ id: 'task-a', label: 'Remove alpha', workspaceName: 'alpha', logLines: ['alpha log'] }),
          task({ id: 'task-b', label: 'Remove beta', workspaceName: 'beta', logLines: ['beta log'] }),
        ]}
        selectedTaskId="task-b"
        onSelectTask={onSelectTask}
        onDismiss={() => {}}
        placement="inline"
      />,
    );

    expect(getElementsByText(view.container, 'alpha log')).toHaveLength(0);
    expect(getElementByText(view.container, 'beta log')).toBeTruthy();
  });

  it('keeps selected task when task order changes and dismiss click does not select row', async () => {
    const onSelectTask = mock(() => {});
    const onDismiss = mock(() => {});
    const view = render(
      <WorkspaceRemovalTaskBar
        tasks={[
          task({ id: 'task-a', label: 'Remove alpha', workspaceName: 'alpha', logLines: ['alpha log'] }),
          task({ id: 'task-b', label: 'Remove beta', workspaceName: 'beta', logLines: ['beta log'] }),
        ]}
        selectedTaskId="task-b"
        onSelectTask={onSelectTask}
        onDismiss={onDismiss}
        placement="inline"
      />,
    );

    await act(async () => {
      fireEvent.click(getElementByText(view.container, '0s · logs'));
    });

    view.rerender(
      <WorkspaceRemovalTaskBar
        tasks={[
          task({ id: 'task-b', label: 'Remove beta', workspaceName: 'beta', logLines: ['beta log'] }),
          task({ id: 'task-a', label: 'Remove alpha', workspaceName: 'alpha', logLines: ['alpha log'] }),
        ]}
        selectedTaskId="task-b"
        onSelectTask={onSelectTask}
        onDismiss={onDismiss}
        placement="inline"
      />,
    );

    expect(getElementByText(view.container, 'beta log')).toBeTruthy();

    await act(async () => {
      fireEvent.click(getElementsByText(view.container, 'dismiss')[0]);
    });

    expect(onDismiss).toHaveBeenCalledWith('task-b');
    expect(onSelectTask).not.toHaveBeenCalled();
  });
});
