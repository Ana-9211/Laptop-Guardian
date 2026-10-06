import { useEffect, useState } from 'react';

const readHash = () => window.location.hash.replace(/^#/, '') || '/overview';

type Guard = (next: string) => boolean;
const listeners = new Set<() => void>();
let current = readHash();
let previous: string | null = null;   // where the user came from, for the Back button of a drawer opened by a link
let guard: Guard | null = null;

// One listener for the whole app, so a navigation guard asks its question once, not once per component that reads the route.
window.addEventListener('hashchange', () => {
  const next = readHash();
  if (next === current) return;
  if (guard && !guard(next)) { window.location.replace(`#${current}`); return; }   // stay where we were
  previous = current;
  current = next;
  listeners.forEach((l) => l());
});

/** A page with unsaved work installs a guard that returns false to keep the user where they are. Pass null to remove it. */
export const setNavGuard = (g: Guard | null) => { guard = g; };

/** Minimal hash router: `#/page/sub?key=value`. Navigation never reloads the page, so UI state survives refreshes. */
export function useHash() {
  const [h, setH] = useState(current);
  useEffect(() => {
    const l = () => setH(current);
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);
  const [path, qs = ''] = h.split('?');
  return { path, params: new URLSearchParams(qs) };
}
export const go = (to: string) => { window.location.hash = to; };

/** Updates the address bar without adding a history entry or re-rendering (filters and tabs live in the URL so a refresh or a shared link restores them). */
export function replaceQuery(path: string, params: URLSearchParams) {
  const qs = params.toString();
  const next = qs ? `${path}?${qs}` : path;
  if (next === current) return;
  try { window.history.replaceState(null, '', `#${next}`); current = next; } catch { /* the address bar is not essential */ }
}

/** The page the user came from when it is a different page (so a drawer opened by a link can offer Back). */
export function useBack(): { to: string; label: string } | null {
  useHash();   // re-render on navigation
  const pathOf = (h: string) => h.split('?')[0];
  if (!previous || pathOf(previous) === pathOf(current)) return null;
  const seg = pathOf(previous).split('/')[1] || 'overview';
  const names: Record<string, string> = { overview: 'Overview', actions: 'Action Center', daily: 'Daily', weekly: 'Weekly', processes: 'Processes', files: 'Files & Storage', health: 'Health', network: 'Network Guard', reports: 'Reports', logs: 'Logs', recommendations: 'Recommendations', blacklist: 'Blacklist', whitelist: 'Whitelist', settings: 'Settings' };
  return { to: previous, label: names[seg] || seg };
}
