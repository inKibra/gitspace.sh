// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from './App.js';
import { GitSpaceShell, type ProjectAgentView, type ProjectLifecycleView } from './GitSpaceShell.js';

let root: Root;
let container: HTMLDivElement;
let animationDescriptor: PropertyDescriptor | undefined;

const checkedAt = '2026-10-18T12:00:00.000Z';
const project: ProjectAgentView = { ...verticalSliceFixture.workspace, kind: 'project', phase: null, id: verticalSliceFixture.workspace.projectId };
const projects: ProjectLifecycleView[] = [{ id: project.projectId, name: 'Project', lifecycle: 'active', repositoryReference: 'https://github.com/example/project.git', baseBranch: project.branch, role: null, source: null, revision: 1, remote: { head: 'a'.repeat(40), checkedAt, behind: true }, archivedAt: null, updatedAt: new Date(checkedAt) }];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // happy-dom has no Web Animations; the transcript's scroll area asks for them.
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations');
});

it('labels Update base tersely and carries the full text in its accessible name', async () => {
  const onUpdateBase = vi.fn(async () => undefined);
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} workspace={project} projects={projects} onUpdateBase={onUpdateBase} />));
  const update = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === `Behind origin/${project.branch} · Update base`);
  if (!update) throw new Error('Update base button missing');
  expect(update.textContent).toBe('Update');
  await act(async () => update.click());
  expect(onUpdateBase).toHaveBeenCalledTimes(1);
});

it('keeps every top bar item on one line that scrolls sideways at a narrow width, the breadcrumb first', async () => {
  vi.stubGlobal('innerWidth', 480);
  const notice = <button type="button">Update base failed: {'origin/develop is not a descendant of develop; '.repeat(4)} · Details</button>;
  await act(() => root.render(<GitSpaceShell {...verticalSliceFixture} workspace={project} projects={projects} onUpdateBase={async () => undefined} projectOperation={notice} />));
  const location = container.querySelector('nav[aria-label="Location"]');
  const line = location?.parentElement;
  if (!location || !line) throw new Error('Top bar missing');
  expect(line.classList).toContain('overflow-x-auto');
  expect(line.classList).toContain('whitespace-nowrap');
  expect(line.firstElementChild).toBe(location);
  expect(location.textContent).toContain(`${project.projectName}/${project.branch}`);
  for (const item of line.children) expect(item.classList.contains('shrink-0') || item.classList.contains('flex-[1_0_auto]')).toBe(true);
  // Nothing in the line is hidden by width: what doesn't fit is scrolled to.
  expect([...line.querySelectorAll('*')].filter((element) => /\bmax-(?:sm|md|lg|xl):hidden\b/u.test(element.getAttribute('class') ?? ''))).toEqual([]);
});
