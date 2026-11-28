// Who is looking at the mock (the top bar's View as) and what the shell lets every page do: say something in a toast,
// go to another view, and move the handle (claim, ask, take over, assign, release, answer a request).
import { createContext, useContext } from 'react';
import type { User } from './data.js';
import type { MockState } from './model.js';
import type { View } from './routes.js';

export interface MockApi {
  viewer: User;
  state: MockState;
  say(text: string): void;
  /** `work` is the sidebar and board; a live page takes `{ page }` (Machines: `add`), `project` `{ project }`;
   * `settings` takes `{ page, person }`; `project-settings` `{ project, page }`. */
  navigate(view: View, params?: Readonly<Record<string, string>>): void;
  open(workspaceId: string): void;
  claim(workspaceId: string): void;
  ask(workspaceId: string): void;
  takeOver(workspaceId: string): void;
  assign(workspaceId: string, userId: string): void;
  release(workspaceId: string): void;
  /** `add` keeps the holders and adds the asker; `hand-over` lets the viewer go. */
  acceptRequest(requestId: string, mode: 'add' | 'hand-over'): void;
  declineRequest(requestId: string): void;
}

export const MockContext = createContext<MockApi | null>(null);

export function useMock(): MockApi {
  const api = useContext(MockContext);
  if (!api) throw new Error('useMock outside the mock shell');
  return api;
}

export function useViewer(): User {
  return useMock().viewer;
}
