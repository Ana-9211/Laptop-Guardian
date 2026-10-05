import { useState } from 'react';
import type { LiveState } from '../state/connection';
import { useStatus } from '../state/StatusProvider';
import { useTicker } from '../state/useTicker';
import { CLOCK_TICK_MS } from '../config';
import type { StatusData, TaskRow } from '../types';
import { fmtDate, until } from '../format';
import { Icon, Tip } from './ui';

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

type Tone = 'ok' | 'info' | 'warn' | 'crit' | 'offline';

/** Connection pill tone and wording, derived only from the live state. */
export function connectionView(live: LiveState): { tone: Tone; label: string } {
  if (live.link === 'offline') return { tone: 'offline', label: 'Offline' };
  if (live.link === 'connecting') return { tone: 'info', label: 'Connecting' };
  if (live.stale) return { tone: 'warn', label: 'Stale' };
  return { tone: 'ok', label: 'Connected' };
}

/** One sentence for the command bar, so the page answers "is everything fine?" before any detail is read. */
export function contextSubtitle(s: StatusData | null, live: LiveState): string {
  if (live.link === 'offline') return 'Bridge offline. Showing the last known data.';
  if (!s) return 'Connecting to the local bridge...';
  if (live.scan.phase === 'running') return `${live.scan.type === 'weekly' ? 'Weekly analysis' : 'Daily audit'} in progress`;
  const crit = s.attention.filter((a) => a.level === 'crit').length;
  const warn = s.attention.filter((a) => a.level === 'warn').length;
  if (crit) return crit === 1 ? '1 critical item needs attention' : `${crit} critical items need attention`;
  if (warn) return warn === 1 ? '1 item needs attention' : `${warn} items need attention`;
  const last = s.reports.daily?.generatedAt;
  return last ? `All clear. Last scan ${fmtDate(last)}` : 'No scan has run yet';
}

export function ConnectionPill() {
  const { live } = useStatus();
  const v = connectionView(live);
  return (
    <Tip text={live.link === 'offline' ? 'The dashboard cannot reach the local bridge. Open Laptop Guardian again from the Start Menu to restart it.' : 'Connection to the local bridge on 127.0.0.1.'}>
      <span className="conn" data-tone={v.tone} role="status" aria-label={`Bridge ${v.label.toLowerCase()}`}><i className={`dot ${v.tone === 'offline' ? '' : v.tone}`} /><span className="conn-text">{v.label}</span></span>
    </Tip>
  );
}

export function RefreshButton() {
  const { refresh, live, lastRefreshed } = useStatus();
  useTicker(CLOCK_TICK_MS.relative);
  const busy = live.refreshing;
  const label = live.link === 'offline' ? (lastRefreshed ? `Last update ${sinceText(lastRefreshed)}` : 'Offline') : `Updated ${sinceText(lastRefreshed)}`;
  return (
    <div className="row tight refresh-wrap">
      <span className={`small refresh-time ${live.link === 'offline' || live.stale ? 'is-stale' : 'muted'}`} aria-live="off">{label}</span>
      <Tip text="Re-reads Task Scheduler, the latest scan, reports, logs and snapshots. Keyboard: R">
        <button className="btn primary" onClick={() => void refresh()} disabled={busy} aria-busy={busy} aria-keyshortcuts="R" aria-label={busy ? 'Refreshing status' : 'Refresh status'}>
          <span className={busy ? 'spin' : ''} style={{ display: 'inline-flex' }}><Icon name="refresh" size={14} /></span><span className="btn-label">{busy ? 'Refreshing...' : 'Refresh status'}</span>
        </button>
      </Tip>
    </div>
  );
}

const LEVEL_DOT: Record<string, string> = { ok: 'ok', info: 'info', warn: 'warn', crit: 'crit' };

/** Short summary shown on the collapsed (narrow) rail. */
function railSummary(s: StatusData | null, live: LiveState): { tone: Tone; text: string } {
  if (live.link === 'offline') return { tone: 'crit', text: 'Cannot reach the local bridge' };
  if (!s) return { tone: 'info', text: 'Connecting...' };
  if (live.scan.phase === 'running') return { tone: 'info', text: `Scan in progress: ${live.scan.type}` };
  if (live.elevationPending) return { tone: 'warn', text: 'Waiting for administrator approval' };
  const sched = s.schedule;
  if (sched.error || sched.level === 'crit' || sched.level === 'warn') return { tone: 'warn', text: sched.error ? 'Task Scheduler unreadable' : maintenanceText(sched.tasks, sched.level) };
  return { tone: 'ok', text: `All systems normal, ${s.safety.safeMode ? 'Safe Mode on' : 'Safe Mode off'}` };
}

/** Compact status rail. Items wrap on wide screens; on narrow screens it folds into an expandable one-line summary. */
export function StatusRail() {
  const { status: s, live } = useStatus();
  const [open, setOpen] = useState(false);
  useTicker(CLOCK_TICK_MS.slow);
  const offline = live.link === 'offline';
  const sum = railSummary(s, live);
  const running = live.scan.phase === 'running' ? live.scan : null;
  const sched = s?.schedule;
  return (
    <div className="rail" role="region" aria-label="System status" data-open={open}>
      <button className="rail-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <i className={`dot ${sum.tone}`} /><span>{sum.text}</span><Icon name="chev" size={14} /><span className="sr-only">{open ? 'Hide details' : 'Show details'}</span>
      </button>
      <div className="rail-items">
        {!s && live.link === 'connecting' && <span className="chip"><i className="dot info pulse" />Connecting to the local bridge...</span>}
        <Tip text={offline ? 'The dashboard cannot reach the local bridge. Open Laptop Guardian again from the Start Menu to restart it.' : `Local bridge connected on 127.0.0.1:${s?.bridge.port ?? ''} (pid ${s?.bridge.pid ?? ''}).`}>
          <span className="chip" tabIndex={0}><i className={`dot ${offline ? 'crit' : s ? 'ok' : 'info'}`} />{offline ? 'Bridge offline' : s ? 'Bridge connected' : 'Bridge connecting'}</span>
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
          <Tip text={s.next.daily ? `Next daily audit: ${fmtDate(s.next.daily)}` : 'The daily audit is turned off in Settings.'}><a className="chip" href="#/settings"><Icon name="daily" size={12} />Daily {s.next.daily ? until(s.next.daily) : 'off'}</a></Tip>
          <Tip text={s.next.weekly ? `Next weekly analysis: ${fmtDate(s.next.weekly)}` : 'The weekly analysis is turned off in Settings.'}><a className="chip" href="#/settings"><Icon name="weekly" size={12} />Weekly {s.next.weekly ? until(s.next.weekly) : 'off'}</a></Tip>
          <Tip text={s.shutdown.pending ? 'A shutdown is scheduled. Use the Cancel shutdown button at the top of the page.' : s.shutdown.armed ? `The scheduled weekly run may shut the laptop down at ${fmtDate(s.shutdown.target)}. ${s.shutdown.note}` : 'Weekly shutdown is off. The laptop stays on after the weekly run.'}>
            <a className={`chip ${s.shutdown.pending ? 'warn' : ''}`} href="#/settings"><i className={`dot ${s.shutdown.pending ? 'warn' : s.shutdown.armed ? 'info' : 'ok'}`} />{s.shutdown.pending ? `Shutdown at ${fmtDate(s.shutdown.pending.at)}` : s.shutdown.armed ? `Shutdown ${fmtDate(s.shutdown.target)}` : 'Shutdown off'}</a>
          </Tip>
        </>}
      </div>
    </div>
  );
}
