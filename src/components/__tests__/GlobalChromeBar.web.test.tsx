/** @jsxImportSource react */
/**
 * The chrome bar's project switcher, which stands where the board chip used to.
 *
 * It carries two distinct actions, which is why it cannot be a native select:
 * clicking the NAME enters that project, and the caret opens a menu that scopes
 * the workspace chips to one project (or widens back to all). Before this, the
 * bar had a board chip plus a project crumb that appeared only when exactly one
 * project existed — so with several projects there was no label, no filter, and
 * no way to reach any project but the first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import { GlobalChromeBar, type ChromeWorkspaceChip } from '../GlobalChromeBar.web.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

const PROJECTS = [{ name: 'core' }, { name: 'gitspace.sh' }, { name: 'mercury-turbo' }];

const CHIPS: ChromeWorkspaceChip[] = [
  { key: 'core:a', name: 'ws-a', projectName: 'core', phase: 'code', statusColor: '#0f0' },
  { key: 'gitspace.sh:b', name: 'ws-b', projectName: 'gitspace.sh', phase: 'review', statusColor: '#0f0' },
];

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')];
}

function openMenu(container: HTMLElement): void {
  const caret = buttons(container).find((b) => b.getAttribute('aria-label') === 'Switch project');
  if (!caret) throw new Error('expected a switcher caret');
  fireEvent.click(caret);
}

describe('GlobalChromeBar project switcher', () => {
  it('replaces the board chip and names the project in scope', () => {
    const { container } = render(
      <GlobalChromeBar projects={PROJECTS} currentProjectName="core" workspaces={CHIPS}
        onBoard={() => undefined} onEnterProject={() => undefined} onFilterProject={() => undefined}
        onSelectWorkspace={() => undefined} />,
    );
    // No standalone board chip any more; the brand is the way back to the board.
    expect(buttons(container).some((b) => b.textContent?.trim() === '⊞ board')).toBe(false);
    expect(buttons(container).some((b) => b.textContent?.includes('core'))).toBe(true);
  });

  it('enters the project when its name is clicked', () => {
    const entered: string[] = [];
    const { container } = render(
      <GlobalChromeBar projects={PROJECTS} currentProjectName="core" workspaces={CHIPS}
        onBoard={() => undefined} onEnterProject={(n) => entered.push(n)} onFilterProject={() => undefined}
        onSelectWorkspace={() => undefined} />,
    );
    const name = buttons(container).find((b) => b.textContent?.includes('⊞ core'));
    if (!name) throw new Error('expected the project name button');
    fireEvent.click(name);
    expect(entered).toEqual(['core']);
  });

  it('offers every project in the menu and filters to the chosen one', () => {
    const filtered: Array<string | null> = [];
    const { container } = render(
      <GlobalChromeBar projects={PROJECTS} currentProjectName="core" workspaces={CHIPS}
        onBoard={() => undefined} onEnterProject={() => undefined} onFilterProject={(n) => filtered.push(n)}
        onSelectWorkspace={() => undefined} />,
    );
    openMenu(container);
    const labels = buttons(container).map((b) => b.textContent?.trim());
    expect(labels).toContain('all projects');
    for (const p of PROJECTS) expect(labels).toContain(p.name);

    const target = buttons(container).find((b) => b.textContent?.trim() === 'mercury-turbo');
    if (!target) throw new Error('expected the project entry');
    fireEvent.click(target);
    expect(filtered).toEqual(['mercury-turbo']);
  });

  it('widens back to every project', () => {
    const filtered: Array<string | null> = [];
    const { container } = render(
      <GlobalChromeBar projects={PROJECTS} currentProjectName="core" workspaces={CHIPS}
        onBoard={() => undefined} onEnterProject={() => undefined} onFilterProject={(n) => filtered.push(n)}
        onSelectWorkspace={() => undefined} />,
    );
    openMenu(container);
    const all = buttons(container).find((b) => b.textContent?.trim() === 'all projects');
    if (!all) throw new Error('expected the all-projects entry');
    fireEvent.click(all);
    expect(filtered).toEqual([null]);
  });

  it('opens the menu from the name when no project is in scope yet', () => {
    // On the cross-project board there is nothing to enter, so the name must not
    // be a dead click.
    const entered: string[] = [];
    const { container } = render(
      <GlobalChromeBar projects={PROJECTS} workspaces={CHIPS}
        onBoard={() => undefined} onEnterProject={(n) => entered.push(n)} onFilterProject={() => undefined}
        onSelectWorkspace={() => undefined} />,
    );
    const name = buttons(container).find((b) => b.textContent?.includes('all projects'));
    if (!name) throw new Error('expected the placeholder label');
    fireEvent.click(name);
    expect(entered).toEqual([]);
    expect(buttons(container).some((b) => b.textContent?.trim() === 'mercury-turbo')).toBe(true);
  });

  it('closes the menu on Escape', () => {
    const { container } = render(
      <GlobalChromeBar projects={PROJECTS} currentProjectName="core" workspaces={CHIPS}
        onBoard={() => undefined} onEnterProject={() => undefined} onFilterProject={() => undefined}
        onSelectWorkspace={() => undefined} />,
    );
    openMenu(container);
    expect(buttons(container).some((b) => b.textContent?.trim() === 'gitspace.sh')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(buttons(container).some((b) => b.textContent?.trim() === 'gitspace.sh')).toBe(false);
  });

  it('renders no switcher when the backend has no projects', () => {
    const { container } = render(
      <GlobalChromeBar projects={[]} workspaces={CHIPS}
        onBoard={() => undefined} onSelectWorkspace={() => undefined} />,
    );
    expect(buttons(container).some((b) => b.getAttribute('aria-label') === 'Switch project')).toBe(false);
  });
});
