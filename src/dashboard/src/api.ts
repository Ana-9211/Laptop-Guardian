import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeepStatus, ExecResponse, Finding, HistoryItem, NetworkCurrent, Plan, RevoInfo, ScheduleApplyResult, ScheduleSaveResult, StatusData } from './types';

export class ApiError extends Error {
  status: number;
  /** Every reason the bridge gave (for example each failed live check), not just the first. */
  errors: string[];
  constructor(status: number, message: string, errors: string[] = []) { super(message); this.status = status; this.errors = errors; }
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
  if (!res.ok) { const body = data as { error?: string; errors?: string[] } | null; throw new ApiError(res.status, body?.error || `Request failed (${res.status})`, body?.errors || []); }
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

/** Action Center: plan (re-validates the live target), confirm, execute, poll an elevated run. Nothing here accepts a command. */
export const remediation = {
  findings: () => api.get<{ generatedAt: string; revo: RevoInfo | null; findings: Finding[] }>('/api/remediation/findings'),
  history: () => api.get<{ items: HistoryItem[] }>('/api/remediation/history?limit=200'),
  plan: (actionId: string, params: Record<string, string | number>) => api.post<Plan>('/api/remediation/plan', { actionId, params }),
  cancel: (token: string) => api.post<{ ok: boolean }>('/api/remediation/cancel', { token }),
  execute: (token: string, acknowledged: string[]) => api.post<ExecResponse>('/api/remediation/execute', { token, confirm: true, acknowledged }),
  result: (ticket: string) => api.get<ExecResponse>(`/api/remediation/result/${ticket}`),
  undo: (eventId: string) => api.post<Plan>('/api/remediation/undo', { eventId }),
};

/** Network Guard. Deep capture and DNS filtering have their own confirmed endpoints and cannot be switched on from settings. */
export const network = {
  current: () => api.get<NetworkCurrent>('/api/network/current'),
  snapshot: () => api.post<NetworkCurrent>('/api/network/snapshot'),
  deepStart: () => api.post<DeepStatus>('/api/network/deep/start', { confirm: true, acknowledged: true }),
  deepStop: () => api.post<DeepStatus>('/api/network/deep/stop'),
  deepDelete: () => api.post<{ deletedFiles: number }>('/api/network/deep/delete', { confirm: true }),
  dnsFiltering: (enabled: boolean) => api.post<NetworkCurrent['dns']>('/api/network/dns-filtering', { confirm: true, enabled, acknowledged: enabled }),
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
