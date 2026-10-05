import { useCallback, useState } from 'react';

const KEY = 'lg-nav-collapsed';

/** Sidebar collapsed (icon rail) preference, remembered per browser profile. Storage failures just mean it is not remembered. */
export function useNavCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } });
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* not remembered */ }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}
