import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeepStatus, ExecResponse, Finding, HistoryItem, NetworkCurrent, Plan, RevoInfo, ScheduleApplyResult, ScheduleSaveResult, StatusData } from './types';

export class ApiError extends Error {
  status: number;
  /** Every reason the bridge gave (for example each failed live check), not just the first. */
  errors: string[];
  /** Set when the bridge refuses a settings change until the user confirms the listed risks. */
  needsConfirmation: string[];
  constructor(status: number, message: string, errors: string[] = [], needsConfirmation: string[] = []) { super(message); this.status = status; this.errors = errors; this.needsConfirmation = needsConfirmation; }
}

const TOKEN_KEY = 'guardian-session';
const TOKEN_HASH = /guardian-token=([A-Za-z0-9_-]{16,200})/;
let sessionToken: string | null = null;
/** The launcher opens the dashboard with the per-start session token in the URL fragment. Keep it in this tab only and remove it from the address bar. */
export function captureSessionToken() {
  try {
    const m = TOKEN_HASH.exec(window.location.hash);
    if (m) {
      sessionToken = m[1];
      try { window.sessionStorage.setItem(TOKEN_KEY, sessionToken); } catch { /* private window: the token stays in memory */ }
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`);
    } else {
      try { sessionToken = window.sessionStorage.getItem(TOKEN_KEY); } catch { sessionToken = null; }
    }
  } catch { sessionToken = null; }
}
captureSessionToken();

const NO_TOKEN = 'This window is not signed in to the Laptop Guardian bridge. Close it and open Laptop Guardian from its shortcut.';
function authHeaders(method: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  if (method !== 'GET') { headers['X-Guardian'] = '1'; headers['Content-Type'] = 'application/json'; }
  return headers;
}

/** A request that gets no answer for this long is given up on, so a hung bridge shows an error instead of an endless spinner. Plan and scan calls can legitimately take a while. */
const REQUEST_TIMEOUT_MS = 90_000;

async function send(method: string, path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  let res: Response;
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    res = await fetch(path, { method, headers: authHeaders(method), body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
  } catch {
    throw new ApiError(0, ctl.signal.aborted ? 'The Laptop Guardian bridge did not answer in time. Try again in a moment.' : 'Cannot reach the Laptop Guardian bridge. Check that it is running.');
  } finally { window.clearTimeout(timer); }
  if (res.status === 401) throw new ApiError(401, NO_TOKEN);
  return res;
}

/** Fetch a file through the authenticated channel and hand it to the browser as a download (plain links cannot carry the token). */
export async function downloadFile(method: 'GET' | 'POST', path: string, body: unknown, fallbackName: string): Promise<void> {
  const res = await send(method, path, body, 300_000);
  if (!res.ok) { let msg = `Download failed (${res.status})`; try { msg = ((await res.json()) as { error?: string }).error || msg; } catch { /* not json */ } throw new ApiError(res.status, msg); }
  const cd = res.headers.get('Content-Disposition') || '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] || fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Plain-text body of an authenticated GET (for example a rendered report shown inside a sandboxed frame). */
export async function fetchText(path: string): Promise<string> {
  const res = await send('GET', path);
  if (!res.ok) throw new ApiError(res.status, `Request failed (${res.status})`);
  return res.text();
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body);
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) { const body = data as { error?: string; errors?: string[]; needsConfirmation?: string[] } | null; throw new ApiError(res.status, body?.error || `Request failed (${res.status})`, body?.errors || [], body?.needsConfirmation || []); }
  return data as T;
}

/**
 * Components that ask for the same GET at the same moment (the findings list is wanted by several panels, for example) share one request
 * instead of each hitting the bridge. The entry is dropped as soon as it settles, so later reloads always fetch fresh data.
 */
const inflight = new Map<string, Promise<unknown>>();
function coalescedGet<T>(p: string): Promise<T> {
  const hit = inflight.get(p);
  if (hit) return hit as Promise<T>;
  const req = call<T>('GET', p).finally(() => { inflight.delete(p); });
  inflight.set(p, req);
  return req;
}

export const api = {
  get: <T,>(p: string) => coalescedGet<T>(p),
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
  execute: (token: string, acknowledged: string[], typed?: string) => api.post<ExecResponse>('/api/remediation/execute', { token, confirm: true, acknowledged, ...(typed ? { typed } : {}) }),
  result: (ticket: string) => api.get<ExecResponse>(`/api/remediation/result/${ticket}`),
  undo: (eventId: string) => api.post<Plan>('/api/remediation/undo', { eventId }),
};

export const shutdown = {
  cancel: () => api.post<{ cancelled: boolean; message: string }>('/api/shutdown/cancel', {}),
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
