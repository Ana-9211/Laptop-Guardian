import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduleApplyResult, ScheduleSaveResult, StatusData } from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') { headers['X-Guardian'] = '1'; headers['Content-Type'] = 'application/json'; }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Cannot reach the Laptop Guardian bridge. Check that it is running.');
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error || `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  get: <T,>(p: string) => call<T>('GET', p),
  post: <T,>(p: string, b: unknown = {}) => call<T>('POST', p, b),
  put: <T,>(p: string, b: unknown) => call<T>('PUT', p, b),
  patch: <T,>(p: string, b: unknown) => call<T>('PATCH', p, b),
  del: <T,>(p: string) => call<T>('DELETE', p),
};

/** Typed contracts for the endpoints the live-status machinery depends on. */
export const bridge = {
  status: (fresh = false) => api.get<StatusData>(fresh ? '/api/status?fresh=1' : '/api/status'),
  startScan: (kind: 'daily' | 'weekly') => api.post<{ started: boolean }>(`/api/scan/${kind}`, {}),
  saveSchedule: (schedule: unknown) => api.put<ScheduleSaveResult>('/api/schedule', schedule),
  applySchedule: (elevate: boolean) => api.post<ScheduleApplyResult>('/api/schedule/apply', { elevate }),
};

export interface Query<T> {
  data: T | null;
  /** Failure with nothing to show. A failed reload that still has data does not set this: the page keeps its content. */
  error: ApiError | null;
  /** A reload failed but older data is still on screen. */
  stale: boolean;
  loading: boolean;
  reload: () => void;
}

/**
 * Every mounted query registers its loader here so the header "Refresh status" button and the status poller can reload
 * all visible data in place. Component state (filters, sort, open drawers) is untouched because nothing is remounted.
 */
const loaders = new Set<() => Promise<void>>();
export const reloadAllQueries = () => Promise.all([...loaders].map((f) => f()));

/** Fetch `path` on mount/when it changes. Pass null to skip. Keeps previous data during reloads (no flicker to skeleton). */
export function useQuery<T>(path: string | null): Query<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const have = useRef(false);
  const load = useCallback((): Promise<void> => {
    if (!path) { setLoading(false); return Promise.resolve(); }
    const n = ++seq.current;
    if (!have.current) setLoading(true);
    return api.get<T>(path)
      .then((d) => { if (n === seq.current) { have.current = true; setData(d); setError(null); } })
      .catch((e: ApiError) => { if (n === seq.current) setError(e); })
      .finally(() => { if (n === seq.current) setLoading(false); });
  }, [path]);
  useEffect(() => { have.current = false; setData(null); setError(null); void load(); }, [load]);
  useEffect(() => { loaders.add(load); return () => { loaders.delete(load); }; }, [load]);
  const reload = useCallback(() => { void load(); }, [load]);
  return { data, error: data ? null : error, stale: !!(data && error), loading, reload };
}
