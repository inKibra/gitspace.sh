/**
 * Theme switching for the web UI.
 *
 * Persists to localStorage, applies via `data-theme` attribute on <html>.
 * The CSS in web/index.css defines all token values per theme.
 */

import { useState, useCallback, useEffect } from 'react';

export const THEMES = [
  { id: 'brutalist',       label: 'Brutalist',        group: 'dark'  },
  { id: 'phosphor',        label: 'Phosphor',         group: 'dark'  },
  { id: 'noir',            label: 'Noir',             group: 'dark'  },
  { id: 'noir-brutalist',  label: 'Noir Brutalist',   group: 'dark'  },
  { id: 'hot-wire',        label: 'Hot Wire',         group: 'dark'  },
  { id: 'noir-phosphor',   label: 'Noir Phosphor',    group: 'dark'  },
  { id: 'bleached',        label: 'Bleached',         group: 'light' },
  { id: 'paper-noir',      label: 'Paper Noir',       group: 'light' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

const STORAGE_KEY = 'gs-theme';
const DEFAULT_THEME: ThemeId = 'brutalist';

/** Read persisted theme, falling back to default. */
function getStoredTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && THEMES.some(t => t.id === stored)) return stored as ThemeId;
  } catch {
    // localStorage unavailable (private browsing, etc.)
  }
  return DEFAULT_THEME;
}

/** Apply theme to the document. */
function applyTheme(id: ThemeId): void {
  document.documentElement.setAttribute('data-theme', id);
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Ignore write failures
  }
}

// Apply on load — runs before React hydrates so there's no flash.
applyTheme(getStoredTheme());

/** React hook for theme state. */
export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(getStoredTheme);

  const setTheme = useCallback((id: ThemeId) => {
    applyTheme(id);
    setThemeState(id);
  }, []);

  const cycleTheme = useCallback(() => {
    const idx = THEMES.findIndex(t => t.id === theme);
    const next = THEMES[(idx + 1) % THEMES.length];
    setTheme(next.id);
  }, [theme, setTheme]);

  // Sync if another tab changes the theme
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        const id = e.newValue as ThemeId;
        if (THEMES.some(t => t.id === id)) {
          applyTheme(id);
          setThemeState(id);
        }
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  return { theme, setTheme, cycleTheme, themes: THEMES };
}
