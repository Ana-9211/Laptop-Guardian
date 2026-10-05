import type { LiveState } from '../state/connection';
import { useStatus } from '../state/StatusProvider';
import { useTicker } from '../state/useTicker';
import { CLOCK_TICK_MS } from '../config';
import type { TaskRow } from '../types';
import { fmtDate, until } from '../format';
import { Icon, Sep, Tip } from './ui';

export const fmtElapsed = (sec: number) => {
  const s = Math.max(0, Math.round(sec)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
};
const sinceText = (d: Date | null) => {
  if (!d) return 'never';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  return s < 5 ? 'just now' : s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};

export function maintenanceText(tasks: TaskRow[] | undefined, level: string): string {
  if (!tasks || !tasks.length) return 'Maintenance unknown';
  const core = tasks.filter((t) => t.kind !== 'dashboard');
  if (core.some((t) => t.status === 'missing')) return 'Maintenance not installed';
  if (core.some((t) => t.status === 'disabled')) return 'Maintenance disabled';
  if (level === 'crit' || level === 'warn') return 'Maintenance needs attention';
  if (core.every((t) => t.status === 'never-run' || t.status === 'off')) return 'Maintenance scheduled';
  return 'Maintenance active';
}

function refreshLabel(live: LiveState, lastRefreshed: Date | null): string {
  if (live.link === 'offline') return lastRefreshed ? `Offline. Last update ${sinceText(lastRefreshed)}` : 'Offline';
  if (live.link === 'connecting') return 'Connecting';
  return live.stale ? `Stale. Updated ${sinceText(lastRefreshed)}` : `Updated ${sinceText(lastRefreshed)}`;
}

export function RefreshButton() {
  const { refresh, live, lastRefreshed } = useStatus();
  useTicker(CLOCK_TICK_MS.relative);
  const busy = live.refreshing;
  return (
    <div className="row tight refresh-wrap">
      <span className={`small refresh-time ${live.link === 'offline' || live.stale ? 'is-stale' : 'muted'}`} aria-live="off">{refreshLabel(live, lastRefreshed)}</span>
      <Tip text="Re-reads Task Scheduler, the latest scan, reports, logs and snapshots. Keyboard: R">
        <button className="btn primary" onClick={() => void refresh()} disabled={busy} aria-busy={busy} aria-keyshortcuts="R">
          <span className={busy ? 'spin' : ''} style={{ display: 'inline-flex' }}><Icon name="refresh" size={14} /></span>{busy ? 'Refreshing...' : 'Refresh status'}
        </button>
      </Tip>
    </div>
  );
}

const LEVEL_DOT: Record<string, string> = { ok: 'ok', info: 'info', warn: 'warn', crit: 'crit' };

export function StatusStrip() {
  const { status: s, live } = useStatus();
  useTicker(CLOCK_TICK_MS.slow);
  const offline = live.link === 'offline';
  if (!s && live.link === 'connecting') return <div className="statusstrip" aria-label="System status"><span className="small muted">Connecting to the local bridge...</span></div>;
  const running = live.scan.phase === 'running' ? live.scan : null;
  const sched = s?.schedule;
  return (
    <div className="statusstrip" role="region" aria-label="System status">
      <Tip text={offline ? 'The dashboard cannot reach the local bridge. Open Laptop Guardian again from the Start Menu to restart it.' : `Local bridge connected on 127.0.0.1:${s?.bridge.port} (pid ${s?.bridge.pid}).`}>
        <span className="chip" tabIndex={0}><i className={`dot ${offline ? 'crit' : 'ok'}`} />{offline ? 'Bridge offline' : 'Bridge connected'}</span>
      </Tip>
      {s && <>
        <Tip text={s.safety.safeMode ? 'Safe Mode: Guardian only observes and recommends. No process is terminated and nothing is cleaned automatically.' : 'Safe Mode is off: only the actions you authorised in Settings can run automatically.'}>
          <a className="chip" href="#/settings"><i className={`dot ${s.safety.safeMode ? 'ok' : 'warn'}`} />Safe Mode {s.safety.safeMode ? 'on' : 'off'}</a>
        </Tip>
        {s.safety.automationPaused && <a className="chip" href="#/settings"><i className="dot warn" />Automation paused</a>}
        <a className="chip" href="#/logs"><i className={`dot ${running ? 'info pulse' : 'ok'}`} />{running ? `${running.type === 'weekly' ? 'Weekly' : 'Daily'} scan running` : 'No scan running'}</a>
        <Tip text={sched?.error ? `Task Scheduler could not be read: ${sched.error}` : (sched?.tasks || []).map((t) => `${t.name}: ${t.summary}`).join('\n') || 'No task information'}>
          <a className="chip" href="#/settings"><i className={`dot ${LEVEL_DOT[sched?.level || 'info']}`} />{sched?.error ? 'Task Scheduler unreadable' : live.elevationPending ? 'Waiting for administrator approval' : live.schedulePending ? 'Checking Task Scheduler...' : maintenanceText(sched?.tasks, sched?.level || 'ok')}</a>
        </Tip>
        <span className="chip" title={s.next.daily || ''}><Icon name="daily" size={12} />Daily {s.next.daily ? <>{until(s.next.daily)}<Sep />{fmtDate(s.next.daily)}</> : 'off'}</span>
        <span className="chip" title={s.next.weekly || ''}><Icon name="weekly" size={12} />Weekly {s.next.weekly ? <>{until(s.next.weekly)}<Sep />{fmtDate(s.next.weekly)}</> : 'off'}</span>
        <Tip text={s.shutdown.pending ? 'A shutdown is scheduled. Cancel it with: shutdown /a' : s.shutdown.armed ? `The scheduled weekly run may shut the laptop down at ${fmtDate(s.shutdown.target)}. ${s.shutdown.note}` : 'Weekly shutdown is off. The laptop stays on after the weekly run.'}>
          <a className={`chip ${s.shutdown.pending ? 'warn' : ''}`} href="#/settings"><i className={`dot ${s.shutdown.pending ? 'warn' : s.shutdown.armed ? 'info' : 'ok'}`} />{s.shutdown.pending ? `Shutdown at ${fmtDate(s.shutdown.pending.at)}` : s.shutdown.armed ? `Shutdown ${fmtDate(s.shutdown.target)}` : 'Shutdown off'}</a>
        </Tip>
      </>}
    </div>
  );
}
