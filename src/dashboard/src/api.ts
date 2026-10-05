import { useCallback, useEffect, useRef, useState } from 'react';

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

export interface Query<T> { data: T | null; error: ApiError | null; loading: boolean; reload: () => void }

/** Fetch `path` on mount/when it changes. Pass null to skip. Keeps previous data during reloads. */
export function useQuery<T>(path: string | null): Query<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!path) { setLoading(false); return; }
    const n = ++seq.current;
    setLoading(true);
    api.get<T>(path).then((d) => { if (n === seq.current) { setData(d); setError(null); } })
      .catch((e: ApiError) => { if (n === seq.current) setError(e); })
      .finally(() => { if (n === seq.current) setLoading(false); });
  }, [path]);
  useEffect(() => { setData(null); load(); }, [load]);
  return { data, error, loading, reload: load };
}
