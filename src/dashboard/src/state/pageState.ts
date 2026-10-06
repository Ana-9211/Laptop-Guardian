import { useCallback, useEffect, useRef, useState } from 'react';
import { replaceQuery, useHash } from '../router';

const PREFIX = 'lg-page-';
const read = (page: string): Record<string, string> => { try { const j = JSON.parse(localStorage.getItem(PREFIX + page) || '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
const write = (page: string, v: Record<string, string>) => { try { localStorage.setItem(PREFIX + page, JSON.stringify(v)); } catch { /* not remembered */ } };

/**
 * Tabs, filters and sort for one page, kept in two places: the address bar (so a link or a refresh restores them and a link can set them)
 * and this browser's storage (so they come back when you return to the page). Values are strings; a value equal to its default is left out of
 * the URL. Order of precedence when a page opens: the URL, then what was remembered, then the default.
 */
export function usePageState<T extends Record<string, string>>(page: string, defaults: T): [T, (patch: Partial<T>) => void] {
  const { path, params } = useHash();
  const keys = Object.keys(defaults);
  const defRef = useRef(defaults); defRef.current = defaults;
  const fromUrl = useCallback(() => { const o: Record<string, string> = {}; for (const k of keys) { const v = params.get(k); if (v !== null) o[k] = v; } return o; }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const [state, setState] = useState<T>(() => ({ ...defaults, ...pick(read(page), keys), ...fromUrl() }) as T);
  const sig = keys.map((k) => params.get(k) ?? '').join('\u0001');
  const first = useRef(true);
  useEffect(() => {   // a link to this same page with other filters (clicking a badge) replaces what is shown
    if (first.current) { first.current = false; return; }
    const u = fromUrl();
    if (Object.keys(u).length) setState((s) => ({ ...s, ...u }));
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = useCallback((patch: Partial<T>) => {
    setState((s) => {
      const next = { ...s, ...patch } as T;
      write(page, next);
      const p = new URLSearchParams(window.location.hash.split('?')[1] || '');
      for (const k of Object.keys(defRef.current)) { if (next[k] !== defRef.current[k]) p.set(k, next[k]); else p.delete(k); }
      replaceQuery(path, p);
      return next;
    });
  }, [page, path]);
  return [state, set];
}
const pick = (o: Record<string, string>, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k, v]) => keys.includes(k) && typeof v === 'string'));
