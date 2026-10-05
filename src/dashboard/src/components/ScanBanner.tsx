import { useStatus } from '../state/StatusProvider';
import { useTicker } from '../state/useTicker';
import { CLOCK_TICK_MS } from '../config';
import { ago, fmtDate } from '../format';
import { Badge, CopyButton, Icon, Sep, useToast } from './ui';
import { network, reloadAllQueries } from '../api';
import { fmtElapsed } from './StatusBar';

const CANCEL_SHUTDOWN = 'shutdown /a';

/** Live view of an active scan, the "scan finished" summary, a stale run marker, and any pending shutdown. */
export function ScanBanner() {
  const { status: s, live, dismissFinished, check } = useStatus();
  const toast = useToast();
  useTicker(CLOCK_TICK_MS.fast);
  if (!s) return null;
  const scan = live.scan;
  const la = s.lastAction;
  const running = scan.phase === 'running' ? scan : null;
  const started = running?.startedAt ? Date.parse(running.startedAt) : NaN;
  const elapsed = running ? (Number.isNaN(started) ? (running.elapsedSec ?? 0) : (Date.now() - started) / 1000) : 0;
  const scheduled = running?.mode === 'scheduled';
  const finishedType = scan.phase === 'finished' ? (scan.type === 'weekly' ? 'weekly' : 'daily') : null;
  const report = finishedType ? s.reports[finishedType] : null;
  return (
    <div className="banners">
      {s.bridge.restartNeeded && (
        <div className="notice warn banner" role="status">
          <Icon name="warn" /><div className="grow"><b>Laptop Guardian was updated, but this window is still using the old version.</b> Close it and open Laptop Guardian from its shortcut again to load the new code.</div>
        </div>
      )}
      {s.network?.deepActive && (
        <div className="notice warn banner" role="status">
          <Icon name="network" /><div className="grow"><b>Deep Network Guard is recording connection activity</b>{s.network.deepSince ? <><Sep />since {fmtDate(s.network.deepSince)}</> : null}. Metadata only (no packet contents), kept on this laptop.</div>
          <a className="btn sm" href="#/network">Manage</a>
          <button className="btn sm danger" onClick={() => { void network.deepStop().then(() => { toast('ok', 'Deep Network Guard stopped.'); void check(true); void reloadAllQueries(); }).catch(() => toast('error', 'Could not stop Deep Network Guard.')); }}>Stop recording</button>
        </div>
      )}
      {s.shutdown.pending && (
        <div className="notice warn banner" role="alert">
          <Icon name="warn" /><div className="grow"><b>Shutdown scheduled for {fmtDate(s.shutdown.pending.at)}.</b> Laptop Guardian finished the weekly run. To cancel, run this in a terminal:</div>
          <code className="mono">{CANCEL_SHUTDOWN}</code><CopyButton text={CANCEL_SHUTDOWN} />
        </div>
      )}
      {running && (
        <div className="notice banner" role="status">
          <i className="dot info pulse" />
          <div className="grow minw0">
            <div className="row tight"><b>{running.type === 'weekly' ? 'Weekly deep analysis' : 'Daily audit'} running</b>
              <Badge tone={scheduled ? 'info' : ''}>{scheduled ? 'Scheduled run' : running.type === 'weekly' ? 'Manual run, no shutdown' : 'Manual run'}</Badge>
              {running.stepName && <Badge tone="outline">Phase: {running.stepName}</Badge>}<span className="small muted">{fmtElapsed(elapsed)} elapsed</span></div>
            {la && <div className="small t2 trunc">Latest: <span className="mono">{la.action}</span>{la.target ? <><Sep />{la.target}</> : null}<Sep />{ago(la.ts)}</div>}
            {running.type === 'weekly' && running.shutdownPossible && <div className="small warn-text">This scheduled run may shut the laptop down at {fmtDate(s.shutdown.target)}. Cancel any time with <code>{CANCEL_SHUTDOWN}</code>.</div>}
          </div>
          <a className="btn sm" href="#/logs">Open log</a>
        </div>
      )}
      {!running && s.run.stale && (
        <div className="notice warn banner"><Icon name="warn" /><div className="grow"><b>A previous {s.run.stale.type} run did not finish</b> (started {fmtDate(s.run.stale.startedAt)}). The machine probably shut down or the run was killed; the next run recovers on its own.</div><a className="btn sm" href="#/logs">Open log</a></div>
      )}
      {finishedType && (
        <div className="notice ok banner" role="status">
          <Icon name="check" /><div className="grow"><b>{finishedType === 'weekly' ? 'Weekly' : 'Daily'} scan finished</b><Sep />{report ? `report ${report.id} is ready` : 'see the log for details'}.</div>
          <a className="btn sm" href={`#/${finishedType}`}>View report</a><a className="btn sm" href="#/logs">Open log</a>
          <button className="btn ghost sm icon-btn" aria-label="Dismiss" onClick={dismissFinished}><Icon name="x" size={14} /></button>
        </div>
      )}
    </div>
  );
}
