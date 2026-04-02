/**
 * Sets up a happy-dom environment on globalThis for tests that need
 * browser globals (window, document, navigator) under Bun.
 *
 * Returns a cleanup function so each test suite gets its own isolated
 * DOM window without sharing module-level mutable state.
 *
 * Usage:
 *   import { setupTestDom } from '../../test/setup-dom.js';
 *   let teardown: () => void;
 *   beforeAll(() => { teardown = setupTestDom(); });
 *   afterAll(() => teardown());
 *
 * Legacy usage (still supported):
 *   import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
 *   beforeAll(() => setupTestDom());
 *   afterAll(() => teardownTestDom());
 */
import { Window } from 'happy-dom';

let activeCleanup: (() => void) | null = null;

export function setupTestDom(): () => void {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    window: g.window,
    document: g.document,
    navigator: g.navigator,
  };

  const domWindow = new Window();
  g.window = domWindow;
  g.document = domWindow.document;
  g.navigator = domWindow.navigator;

  const cleanup = () => {
    g.window = saved.window;
    g.document = saved.document;
    g.navigator = saved.navigator;
    domWindow.close();
    if (activeCleanup === cleanup) activeCleanup = null;
  };
  activeCleanup = cleanup;
  return cleanup;
}

/** Legacy teardown — calls the cleanup from the most recent setupTestDom(). */
export function teardownTestDom(): void {
  activeCleanup?.();
}
