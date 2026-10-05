import { useState } from 'react';
import { bridge, ApiError } from '../api';
import type { ActionEvent, Recommendation } from '../types';
import { ago, fmtDate, riskTone, sevTone } from '../format';
import { Badge, RiskBadge, Sep, useToast, Icon } from './ui';
import { useStatus } from '../state/StatusProvider';

export function RecCard({ rec, onOpen }: { rec: Recommendation; onOpen?: (r: Recommendation) => void }) {
  return (
    <button className="card" onClick={() => onOpen?.(rec)} style={{ textAlign: 'left', cursor: onOpen ? 'pointer' : 'default', padding: '10px 12px', display: 'grid', gap: 6, borderLeft: `3px solid var(--${riskTone(rec.risk) || 'line-strong'})` }}>
      <div className="row spread" style={{ flexWrap: 'nowrap' }}>
        <b style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{rec.title}</b>
        <RiskBadge risk={rec.risk} />
      </div>
      <div className="small t2" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{rec.whatIsIt || rec.whyFlagged?.[0]}</div>
      <div className="row tight small muted">
        <Badge tone="outline">{rec.kind}</Badge>
        <span>{rec.suggestedAction}</span><Sep />
        <span>{(rec.consecutiveDays ?? 0) > 1 ? `${rec.consecutiveDays} days in a row` : `seen ${ago(rec.lastSeen)}`}</span>
        {onOpen && <span className="go-hint"><Icon name="chev" size={14} /></span>}
      </div>
    </button>
  );
}

const CAT_TONE: Record<string, string> = { error: 'crit', warning: 'warn', info: 'ok' };
export function ActionTimeline({ rows, max = 8 }: { rows: ActionEvent[]; max?: number }) {
  return (
    <div className="timeline">
      {rows.slice(0, max).map((a) => (
        <a className="tl" key={a.id} href={`#/logs?q=${encodeURIComponent(a.id)}`} aria-label={`Open ${a.action} in the log`}>
          <span className={`dot ${CAT_TONE[a.severity] || 'info'}`} />
          <div style={{ minWidth: 0 }}>
            <div className="row tight"><b className="mono" style={{ fontSize: 12.5 }}>{a.action}</b>{a.target && <span className="t2 trunc" style={{ maxWidth: 260 }}>{a.target}</span>}
              {a.result && a.result !== 'success' && <Badge tone={a.result === 'failure' || a.result === 'timeout' ? 'crit' : ''}>{a.result}</Badge>}</div>
            <div className="small muted">{fmtDate(a.ts)}<Sep />{a.actor || 'agent'}<Sep />{a.category}{a.reason ? <><Sep />{a.reason}</> : null}</div>
          </div>
        </a>
      ))}
    </div>
  );
}

export function useRun() {
  const toast = useToast();
  const { expectScan } = useStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const start = async (kind: 'daily' | 'weekly', after?: () => void) => {
    setBusy(kind);
    try {
      await bridge.startScan(kind);
      toast('ok', `${kind === 'daily' ? 'Daily' : 'Weekly'} scan started${kind === 'weekly' ? ' without shutdown' : ''}. Results appear when it finishes.`);
      after?.();
      expectScan(); // the agent writes its run marker a moment after launching
    } catch (e) { toast('error', (e as ApiError).message); } finally { setBusy(null); }
  };
  return { busy, start };
}
export function RunButtons({ onStarted }: { onStarted?: () => void }) {
  const { busy, start } = useRun();
  return <button className="btn" disabled={!!busy} onClick={() => start('daily', onStarted)}><Icon name="play" size={13} />{busy === 'daily' ? 'Starting...' : 'Run daily scan'}</button>;
}

export function Meter({ value, warn = 70, crit = 90 }: { value: number; warn?: number; crit?: number }) {
  const tone = value >= crit ? 'crit' : value >= warn ? 'warn' : '';
  return <div className="stat" style={{ padding: 0 }}><div className="bar" style={{ width: 90 }}><i className={tone} style={{ width: `${Math.min(100, value)}%` }} /></div></div>;
}

export { sevTone };
