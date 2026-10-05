import { useEffect, useState } from 'react';

const readHash = () => window.location.hash.replace(/^#/, '') || '/overview';

/** Minimal hash router: `#/page/sub?key=value`. Navigation never reloads the page, so UI state survives refreshes. */
export function useHash() {
  const [h, setH] = useState(readHash);
  useEffect(() => {
    const onChange = () => setH(readHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const [path, qs = ''] = h.split('?');
  return { path, params: new URLSearchParams(qs) };
}
export const go = (to: string) => { window.location.hash = to; };
