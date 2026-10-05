import { useEffect, useState } from 'react';
import { useQuery } from '../api';
import type { ActionEvent } from '../types';
import { Badge, Card, Empty, ErrorState, Expander, PageHead, SearchBox, SkeletonCards } from '../components/ui';
import { fmtFull, sevTone } from '../format';
import { useHash } from '../router';

const CATS = ['scan', 'process', 'ai', 'file', 'cleanup', 'defender', 'windows', 'policy', 'shutdown', 'config', 'system'];

export default function Logs() {
  const { params } = useHash();
  const [q, setQ] = useState(params.get('q') ?? ''); const [dq, setDq] = useState(params.get('q') ?? ''); // deep links such as #/logs?q=<event id> arrive pre-filtered
  const [cat, setCat] = useState(''); const [sev, setSev] = useState(''); const [limit, setLimit] = useState(200);
  useEffect(() => { const t = setTimeout(() => setDq(q), 250); return () => clearTimeout(t); }, [q]);
  const qs = new URLSearchParams({ limit: String(limit), ...(cat && { category: cat }), ...(sev && { severity: sev }), ...(dq && { q: dq }) }).toString();
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
          <button className="btn" onClick={res.reload}>Refresh</button>
        </div>
        {res.error ? <div style={{ padding: 14 }}><ErrorState error={res.error} onRetry={res.reload} /></div> : !res.data ? <div style={{ padding: 14 }}><SkeletonCards n={1} /></div> : rows.length === 0 ? <Empty icon="logs" title="No log entries match" /> : (
          <div>
            {rows.map((a) => (
              <Expander key={a.id} head={
                <span className="row" style={{ gap: 10, flexWrap: 'nowrap', minWidth: 0, flex: 1 }}>
                  <span className="num small muted" style={{ width: 130, flex: 'none' }}>{fmtFull(a.ts)}</span>
                  <Badge tone={sevTone(a.severity)} dot>{a.severity}</Badge>
                  <Badge tone="outline">{a.category}</Badge>
                  <b className="mono trunc" style={{ fontSize: 12.5 }}>{a.action}</b>
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
