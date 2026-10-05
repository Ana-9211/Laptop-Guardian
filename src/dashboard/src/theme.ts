import { useCallback, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'lg-theme';

function readStored(): Theme {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}

/** Theme choice persisted per browser profile. 'system' follows the OS via CSS media queries (no data-theme attribute). */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readStored);
  const set = useCallback((v: Theme) => {
    setTheme(v);
    try { if (v === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch { /* storage unavailable: the choice lasts for this session only */ }
    if (v === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v;
  }, []);
  return [theme, set];
}

export const nextTheme = (t: Theme): Theme => (t === 'dark' ? 'light' : t === 'light' ? 'system' : 'dark');
export const themeLabel = (t: Theme) => (t === 'system' ? 'Auto' : t === 'dark' ? 'Dark' : 'Light');
