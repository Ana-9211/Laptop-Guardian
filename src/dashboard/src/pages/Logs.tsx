import { useEffect, useState } from 'react';
import { useQuery } from '../api';
import type { ActionEvent } from '../types';
import { Badge, Card, Empty, ErrorState, Expander, PageHead, SearchBox, SkeletonCards } from '../components/ui';
import { fmtFull, sevTone } from '../format';
import { usePageState } from '../state/pageState';
import { CsvButton } from '../components/CsvButton';

const CATS = ['scan', 'process', 'ai', 'file', 'cleanup', 'defender', 'windows', 'policy', 'shutdown', 'config', 'system', 'remediation', 'network'];

export default function Logs() {
  // Filters live in the address bar (a link such as #/logs?q=<event id> or ?sev=error arrives pre-filtered, and a refresh keeps them) and in this browser's storage.
  const [ps, setPs] = usePageState('logs', { q: '', category: '', sev: '', arch: '' });
  const q = ps.q; const cat = CATS.includes(ps.category) ? ps.category : ''; const sev = ['info', 'warning', 'error'].includes(ps.sev) ? ps.sev : ''; const [limit, setLimit] = useState(200);
  const archived = ps.arch === '1'; const setArchived = (v: boolean) => setPs({ arch: v ? '1' : '' });
  const setQ = (v: string) => setPs({ q: v }); const setCat = (v: string) => setPs({ category: v }); const setSev = (v: string) => setPs({ sev: v });
  const [dq, setDq] = useState(q);
  useEffect(() => { const t = setTimeout(() => setDq(q), 250); return () => clearTimeout(t); }, [q]);
  const qs = new URLSearchParams({ limit: String(limit), ...(cat && { category: cat }), ...(sev && { severity: sev }), ...(dq && { q: dq }), ...(archived && { archived: '1' }) }).toString();
  const res = useQuery<ActionEvent[]>(`/api/actions?${qs}`);
  const rows = res.data || [];
  return (
    <div className="page">
      <PageHead title="Logs" sub="Every observation, recommendation, AI request and action, newest first. The file is append-only: data/actions/actions.jsonl." />
      <Card flush>
        <div className="filters">
          <SearchBox value={q} onChange={setQ} placeholder="Search action, target, reason or error" />
          <select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
          <select aria-label="Severity" value={sev} onChange={(e) => setSev(e.target.value)}><option value="">Any severity</option><option>info</option><option>warning</option><option>error</option></select>
          <label className="row tight small" title="Also search the monthly archive files (older audit rows), up to 8 MB per search"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />Include archived</label>
          <button className="btn" onClick={res.reload}>Refresh</button>
          <CsvButton name="laptop-guardian-log" rows={rows} cols={[{ label: 'Time', get: (a: ActionEvent) => a.ts }, { label: 'Severity', get: (a: ActionEvent) => a.severity }, { label: 'Category', get: (a: ActionEvent) => a.category }, { label: 'Action', get: (a: ActionEvent) => a.action }, { label: 'Target', get: (a: ActionEvent) => a.target }, { label: 'Result', get: (a: ActionEvent) => a.result }, { label: 'Actor', get: (a: ActionEvent) => a.actor }, { label: 'Reason', get: (a: ActionEvent) => a.reason }, { label: 'Error', get: (a: ActionEvent) => a.error }, { label: 'Id', get: (a: ActionEvent) => a.id }]} />
        </div>
        {res.error ? <div style={{ padding: 14 }}><ErrorState error={res.error} onRetry={res.reload} /></div> : !res.data ? <div style={{ padding: 14 }}><SkeletonCards n={1} /></div> : rows.length === 0 ? <Empty icon="logs" title="No log entries match" /> : (
          <div>
            {rows.map((a) => (
              <Expander key={a.id} head={
                <span className="row" style={{ gap: 10, flexWrap: 'nowrap', minWidth: 0, flex: 1 }}>
                  <span className="num small muted" style={{ width: 130, flex: 'none' }}>{fmtFull(a.ts)}</span>
                  <Badge tone={sevTone(a.severity)} dot>{a.severity}</Badge>
                  <Badge tone="outline">{a.category}</Badge>
                  {a.archived && <Badge tone="outline">archived</Badge>}<b className="mono trunc" style={{ fontSize: 12.5 }}>{a.action}</b>
                  <span className="t2 trunc">{a.target}</span>
                  <span style={{ flex: 1 }} />
                  {a.result && <Badge tone={a.result === 'success' ? 'ok' : a.result === 'failure' || a.result === 'timeout' ? 'crit' : ''}>{a.result}</Badge>}
                </span>}>
                <dl className="kv" style={{ margin: 0 }}>
                  {([['Actor', a.actor], ['Reason', a.reason], ['Related recommendation', a.relatedRecommendation], ['Run', a.runType], ['ID', a.id]] as [string, string | null | undefined][]).filter(([, v]) => v).map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}
                </dl>
                {a.error && <div className="mono-block" style={{ color: 'var(--crit)' }}>{a.error}</div>}
              </Expander>
            ))}
            {rows.length >= limit && <div style={{ padding: 12, textAlign: 'center' }}><button className="btn" onClick={() => setLimit(limit + 300)}>Load more</button></div>}
          </div>
        )}
      </Card>
    </div>
  );
}
