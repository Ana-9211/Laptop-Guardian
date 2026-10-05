import { useEffect, useState } from 'react';

/** Re-renders on an interval so relative times ("5 s ago") and elapsed timers stay honest without refetching anything. */
export function useTicker(ms: number): void {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
