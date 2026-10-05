import { useEffect, useState } from 'react';

const readHash = () => window.location.hash.replace(/^#/, '') || '/overview';

type Guard = (next: string) => boolean;
const listeners = new Set<() => void>();
let current = readHash();
let guard: Guard | null = null;

// One listener for the whole app, so a navigation guard asks its question once, not once per component that reads the route.
window.addEventListener('hashchange', () => {
  const next = readHash();
  if (next === current) return;
  if (guard && !guard(next)) { window.location.replace(`#${current}`); return; }   // stay where we were
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
