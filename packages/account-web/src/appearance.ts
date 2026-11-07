import { useSyncExternalStore } from 'react';

export type Appearance = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'gitspace.appearance';

/**
 * Pins the Fluid colour scheme on <html>: `.light`/`.dark` force a side of
 * every light-dark() token, no class follows the OS. The last applied value is
 * mirrored to localStorage so the next load can pin it before React renders.
 */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  root.classList.toggle('light', appearance === 'light');
  root.classList.toggle('dark', appearance === 'dark');
  try { localStorage.setItem(STORAGE_KEY, appearance); } catch { /* private mode */ }
}

export function restoreAppearance(): void {
  let stored: string | null = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* private mode */ }
  if (stored === 'light' || stored === 'dark' || stored === 'system') applyAppearance(stored);
}

/** Whether the page shows the dark scheme: `.dark` on <html>, or neither class and the OS prefers dark. */
function darkScheme(): boolean {
  const root = document.documentElement;
  return root.classList.contains('dark') || (!root.classList.contains('light') && matchMedia('(prefers-color-scheme: dark)').matches);
}

function subscribeScheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  const media = matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  return () => { observer.disconnect(); media.removeEventListener('change', onChange); };
}

/** Follows the scheme as appearance changes or the OS switches; light when rendered without a document. */
export function useDarkScheme(): boolean {
  return useSyncExternalStore(subscribeScheme, darkScheme, () => false);
}
