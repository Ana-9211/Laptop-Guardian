import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, bridge, reloadAllQueries } from '../api';
import type { StatusData } from '../types';
import { useToast } from '../components/ui';
import { DATA_RELOAD_MS, SCAN_START_RECHECK_MS } from '../config';
import { deriveLive, detectFinished, finishKey, FinishedScan, isAged, LiveState, nextPollDelay } from './connection';

interface StatusContext {
  status: StatusData | null;
  /** The single description of connection, refresh, scan and staleness. Read this instead of re-deriving it. */
  live: LiveState;
  lastRefreshed: Date | null;
  /** Manual refresh: re-reads Task Scheduler (fresh) and every mounted data query, in place. */
  refresh: () => Promise<void>;
  /** Quiet status re-check (no toast). `fresh` also re-reads Task Scheduler. Resolves false if the bridge is unreachable. */
  check: (fresh?: boolean) => Promise<boolean>;
  /** Call right after starting a scan so the live banner appears without waiting for the next poll. */
  expectScan: () => void;
  dismissFinished: () => void;
}
const Ctx = createContext<StatusContext | null>(null);
export function useStatus(): StatusContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStatus must be used inside <StatusProvider>');
  return c;
}

interface InFlight { fresh: boolean; promise: Promise<boolean> }

/**
 * Owns the ONE polling loop. Everything the UI says about the bridge (offline/connected, refreshing, active or
 * finished scan, stale data, errors) is derived from this provider's state through `deriveLive`.
 */
export function StatusProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [status, setStatus] = useState<StatusData | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [finished, setFinished] = useState<FinishedScan | null>(null);
  const [aged, setAged] = useState(false);

  const inFlight = useRef<InFlight | null>(null);
  const prevRunning = useRef<StatusData['run']['running']>(null);
  const prevKey = useRef<string | null>(null);
  const lastOkRef = useRef<number | null>(null);
  const lastDataReload = useRef(Date.now());
  const offlineBefore = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const reloadData = useCallback(async () => { lastDataReload.current = Date.now(); await reloadAllQueries(); }, []);

  /** One status request. Joins an equal-or-fresher request already in flight; a fresh request waits its turn. Resolves true on success. */
  const fetchStatus = useCallback((fresh: boolean): Promise<boolean> => {
    const cur = inFlight.current;
    if (cur && (cur.fresh || !fresh)) return cur.promise;
    const run = async (): Promise<boolean> => {
      try {
        const s = await bridge.status(fresh);
        const done = detectFinished(prevRunning.current, prevKey.current, s);
        const reconnected = offlineBefore.current;
        offlineBefore.current = false;
        prevRunning.current = s.run.running || null;
        prevKey.current = finishKey(s);
        lastOkRef.current = Date.now();
        setStatus(s); setFailure(null); setLastOkAt(lastOkRef.current); setAged(false);
        if (s.run.running) setFinished(null);
        if (done) {
          setFinished(done);
          toast('ok', `${done.type === 'weekly' ? 'Weekly' : 'Daily'} scan finished. Reloading the data.`);
        }
        if (done || reconnected) void reloadData();
        return true;
      } catch (e) {
        offlineBefore.current = true;
        setFailure(e as ApiError);
        return false;
      }
    };
    const promise = (cur ? cur.promise.then(run) : run()).finally(() => { if (inFlight.current?.promise === promise) inFlight.current = null; });
    inFlight.current = { fresh, promise };
    return promise;
  }, [reloadData, toast]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const ok = await fetchStatus(true);
      if (!ok) { toast('error', 'Refresh failed: the Laptop Guardian bridge is not reachable.'); return; }
      await reloadData();
      toast('ok', 'Status refreshed.');
    } finally { setRefreshing(false); }
  }, [fetchStatus, reloadData, toast]);

  const expectScan = useCallback(() => {
    for (const ms of SCAN_START_RECHECK_MS) timers.current.push(setTimeout(() => { void fetchStatus(false); }, ms));
  }, [fetchStatus]);

  const live = useMemo(() => deriveLive({
    hasStatus: !!status, status, failed: !!failure, errorMessage: failure?.message ?? null, refreshing, finished,
    aged,
  }), [status, failure, refreshing, finished, aged]);
  const liveRef = useRef(live);
  liveRef.current = live;

  // The poll loop. It reads the latest state through liveRef so it never restarts (and never double-polls) when state changes.
  useEffect(() => {
    let stop = false; let busy = false; let first = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (busy || stop) return;
      busy = true;
      try {
        if (document.visibilityState === 'visible' || first) {
          first = false;
          await fetchStatus(false);
          if (liveRef.current.scan.phase !== 'running' && Date.now() - lastDataReload.current >= DATA_RELOAD_MS) void reloadData();
        }
        setAged(isAged(lastOkRef.current, Date.now()));
      } finally { busy = false; }
      if (!stop) { clearTimeout(timer); timer = setTimeout(() => { void tick(); }, nextPollDelay(liveRef.current)); }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); void tick(); } };
    void tick();
    document.addEventListener('visibilitychange', onVisible);
    const pending = timers.current;
    return () => { stop = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); pending.forEach(clearTimeout); };
  }, [fetchStatus, reloadData]);

  // R refreshes (no modifier, never while typing or with a dialog open); Ctrl+R stays the browser's own reload.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'r' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      void refresh();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [refresh]);

  const lastRefreshed = useMemo(() => (lastOkAt ? new Date(lastOkAt) : null), [lastOkAt]);
  const check = useCallback((fresh = false) => fetchStatus(fresh), [fetchStatus]);
  const value = useMemo<StatusContext>(() => ({ status, live, lastRefreshed, refresh, check, expectScan, dismissFinished: () => setFinished(null) }), [status, live, lastRefreshed, refresh, check, expectScan]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
