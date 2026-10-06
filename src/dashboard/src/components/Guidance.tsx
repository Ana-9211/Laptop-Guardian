import { useState } from 'react';
import { useQuery } from '../api';
import type { ChangesData, DryRun, Metric, Report, SetupChecklist } from '../types';
import { deductionTrend } from '../healthTrend';
import { Badge, Card, Empty, ErrorState, Icon, SkeletonCards } from './ui';
import { ActionButton, useActionFlow } from './ActionFlow';
import { useStatus } from '../state/StatusProvider';
import { ago, fmtFull } from '../format';

const HIDE_KEY = 'lg-checklist-hidden';
const readHidden = () => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } };

/** What is still missing after a fresh install, with a button for each step. Never runs by itself; it can be hidden and brought back. */
export function FirstRunChecklist({ onChanged }: { onChanged?: () => void }) {
  const q = useQuery<SetupChecklist>('/api/setup');
  const { check } = useStatus();
  const flow = useActionFlow(() => { q.reload(); void check(true); onChanged?.(); });
  const [hidden, setHidden] = useState(readHidden);
  const setHide = (v: boolean) => { setHidden(v); try { localStorage.setItem(HIDE_KEY, v ? '1' : '0'); } catch { /* not remembered */ } };
  const d = q.data;
  if (q.error || !d) return null;
  if (d.complete && !d.items.some((i) => i.optional && !i.done && !i.unknown)) return null;
  if (hidden) return <p className="small muted" style={{ margin: 0 }}>{d.remaining ? `${d.remaining} setup step${d.remaining > 1 ? 's' : ''} left. ` : ''}<button className="linklike" onClick={() => setHide(false)}>Show the setup checklist</button></p>;
  return (
    <Card title={d.complete ? 'Optional extras' : `Finish setting up (${d.remaining} left)`} actions={<button className="btn sm ghost" onClick={() => setHide(true)}>Hide</button>}>
      <ul className="plain-list checklist">
        {d.items.map((i) => (
          <li key={i.id} className="row spread" style={{ alignItems: 'flex-start', padding: '6px 0', gap: 12 }}>
            <span className="row" style={{ gap: 10, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
              <span aria-hidden="true" style={{ marginTop: 2 }}><Icon name={i.done ? 'check' : 'info'} size={15} /></span>
              <span className="stack tight"><b>{i.title} {i.done ? <Badge tone="ok">done</Badge> : i.optional ? <Badge tone="outline">optional</Badge> : <Badge tone="warn">to do</Badge>}</b><span className="small t2">{i.detail}</span></span>
            </span>
            <span className="row tight" style={{ flex: 'none' }}>
              {i.action && !i.done && <ActionButton actionId={i.action.actionId} params={i.action.params} label={i.action.label} flow={flow} />}
              {i.link && !i.done && <a className="btn sm" href={i.link}>Open</a>}
            </span>
          </li>
        ))}
      </ul>
      <p className="small muted">Nothing here runs by itself. Each button shows what it will do and asks first. Optional items can be skipped.</p>
      {flow.node}
    </Card>
  );
}

/** The newest daily report against the one before it. */
export function ChangesCard() {
  const q = useQuery<ChangesData>('/api/changes');
  const d = q.data;
  return (
    <Card title="What changed since the last run" actions={d?.available && d.to ? <span className="small muted">{ago(d.from)} to {ago(d.to)}</span> : undefined}>
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !d ? <SkeletonCards n={1} h={80} /> : !d.available ? <Empty icon="info" title="Nothing to compare yet">{d.reason}</Empty>
        : d.items.length === 0 ? <Empty icon="check" title="No changes">The last two daily reports match on everything Guardian compares.</Empty> : (
          <div className="stack">
            {d.items.map((i) => (
              <div key={i.label} className="row spread">
                <span>{i.label}</span>
                <span className="row tight"><span className="small t2">{i.from ? `${i.from} -> ${i.to}` : i.to}</span><Badge tone={i.tone}>{i.delta}</Badge></span>
              </div>
            ))}
            <p className="small muted" style={{ margin: 0 }}>Compared: {fmtFull(d.from)} and {fmtFull(d.to)}.</p>
          </div>
        )}
    </Card>
  );
}

/** Points per factor behind the health score (from the report), so the number is never a mystery. */
export function ScoreExplain({ report, metrics = [] }: { report: Report | null; metrics?: Metric[] }) {
  const trend = deductionTrend(metrics);
  const reasons = (report?.healthReasons || []).map((r) => { const m = /^-(\d+)\s+(.*)$/.exec(r); return m ? { points: Number(m[1]), text: m[2] } : { points: 0, text: r }; });
  if (!report || report.healthScore == null) return null;
  const total = reasons.reduce((a, r) => a + r.points, 0);
  return (
    <details className="small score-explain">
      <summary>How is this score worked out?</summary>
      <p className="t2" style={{ margin: '6px 0' }}>It starts at 100 and loses points for each problem found at the last scan.</p>
      {reasons.length === 0 ? <p className="t2" style={{ margin: 0 }}>Nothing was deducted: no factor Guardian checks was found wanting.</p> : (
        <table className="t" aria-label="Health score deductions"><thead><tr><th>Factor</th><th className="r">Points</th></tr></thead>
          <tbody>{reasons.map((r) => <tr key={r.text}><td>{r.text}</td><td className="r num">-{r.points}</td></tr>)}<tr><td><b>Score</b></td><td className="r num"><b>{report.healthScore} (100 - {total})</b></td></tr></tbody></table>
      )}
      {trend.items.length > 0 && (
        <div style={{ marginTop: 8 }}><b>Most frequent deductions over the last {trend.runs} runs</b>
          <ul className="plain-list">{trend.items.map((i) => <li key={i.text}>{i.text}: in {i.runs} of {trend.runs} runs, about -{i.avgPoints} points each time{i.latest ? ' (still present)' : ''}</li>)}</ul></div>
      )}
    </details>
  );
}

/** Safe Mode dry run: what the agents WOULD do with Safe Mode off, from the latest scan. Runs nothing. */
export function SafeModePreview() {
  const [open, setOpen] = useState(false);
  const q = useQuery<DryRun>(open ? '/api/safemode/preview' : null);
  return (
    <div className="stack">
      <div className="row"><button className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide the dry run' : 'Preview what Safe Mode off would do'}</button><span className="small muted">Read only. Nothing is run or changed.</span></div>
      {open && (q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <SkeletonCards n={1} h={90} /> : (
        <div className="stack">
          {q.data.basedOn.scan && <p className="small muted" style={{ margin: 0 }}>Based on the scan from {fmtFull(q.data.basedOn.scan)} ({q.data.basedOn.processes} processes) and your current settings.</p>}
          <div className="notice"><b>Would happen automatically ({q.data.wouldDo.length}):</b>
            {q.data.wouldDo.length === 0 ? <div className="small">Nothing. With your current settings, turning Safe Mode off would change nothing.</div> : <ul className="plain-list">{q.data.wouldDo.map((l, i) => <li key={i}><b>{l.label}.</b> <span className="t2">{l.detail}</span></li>)}</ul>}</div>
          <div className="notice ok"><b>Would not happen:</b><ul className="plain-list">{q.data.wouldNotDo.map((l, i) => <li key={i}><b>{l.label}.</b> <span className="t2">{l.detail}</span></li>)}</ul></div>
          {q.data.notes.map((n) => <p key={n} className="small muted" style={{ margin: 0 }}>{n}</p>)}
        </div>
      ))}
    </div>
  );
}
