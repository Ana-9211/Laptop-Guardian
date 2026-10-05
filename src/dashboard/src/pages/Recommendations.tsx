import { useMemo, useState } from 'react';
import { api, ApiError, useQuery } from '../api';
import type { Recommendation } from '../types';
import { Badge, Card, CommandBlock, Drawer, Empty, ErrorState, KV, PageHead, RiskBadge, SearchBox, SkeletonCards, Tabs, useToast } from '../components/ui';
import { RecCard } from '../components/common';
import { go } from '../router';
import { fmtFull } from '../format';
import { useActionFlow } from '../components/ActionFlow';
import { RecFixes } from '../components/RecFixes';

type Tab = 'open' | 'dismissed' | 'ignored' | 'actioned' | 'resolved' | 'all';

export default function Recommendations() {
  const q = useQuery<{ items: Recommendation[] }>('/api/recommendations');
  const toast = useToast();
  const flow = useActionFlow(() => q.reload());
  const [tab, setTab] = useState<Tab>('open');
  const [kind, setKind] = useState('');
  const [risk, setRisk] = useState('');
  const [text, setText] = useState('');
  const [sel, setSel] = useState<Recommendation | null>(null);
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const kinds = useMemo(() => [...new Set(items.map((i) => i.kind))], [items]);
  const count = (s: Tab) => (s === 'all' ? items.length : items.filter((i) => i.status === s).length);
  const rows = items.filter((i) => (tab === 'all' || i.status === tab) && (!kind || i.kind === kind) && (!risk || i.risk === risk) && (!text || `${i.title} ${i.whatIsIt}`.toLowerCase().includes(text.toLowerCase())))
    .sort((a, b) => ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].indexOf(a.risk) - ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].indexOf(b.risk));

  const setStatus = async (r: Recommendation, status: string) => {
    try { await api.post(`/api/recommendations/${r.id}/status`, { status }); toast('ok', `Marked ${status}.`); q.reload(); setSel(null); } catch (e) { toast('error', (e as ApiError).message); }
  };

  return (
    <div className="page">
      <PageHead title="Recommendations" sub="Everything Guardian thinks is worth a look. Nothing here runs by itself: you choose what to do." />
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <SkeletonCards n={3} h={110} /> : (
        <>
          <Tabs<Tab> value={tab} onChange={setTab} label="Status" items={(['open', 'dismissed', 'ignored', 'actioned', 'resolved', 'all'] as Tab[]).map((s) => ({ id: s, label: s[0].toUpperCase() + s.slice(1), count: count(s) }))} />
          <div className="row">
            <SearchBox value={text} onChange={setText} placeholder="Search recommendations" />
            <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All kinds</option>{kinds.map((k) => <option key={k}>{k}</option>)}</select>
            <select aria-label="Risk" value={risk} onChange={(e) => setRisk(e.target.value)}><option value="">Any risk</option>{['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].map((k) => <option key={k}>{k}</option>)}</select>
          </div>
          {rows.length === 0 ? <Card><Empty icon="check" title="No recommendations here">Nothing matches the current filters.</Empty></Card> : <div className="grid gauto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>{rows.map((r) => <RecCard key={r.id} rec={r} onOpen={setSel} />)}</div>}
        </>
      )}
      {sel && (
        <Drawer title={sel.title} onClose={() => setSel(null)} sub={<span className="row tight"><RiskBadge risk={sel.risk} /><Badge tone="outline">Confidence {Math.round((sel.confidence ?? 0) * 100)}%</Badge><Badge>{sel.kind}</Badge></span>}
          footer={<>{sel.kind === 'process' && <button className="btn" onClick={() => go(`/processes?rec=${sel.id}`)}>Open process panel</button>}{sel.status === 'open' ? <><button className="btn" onClick={() => setStatus(sel, 'dismissed')}>Dismiss</button><button className="btn" onClick={() => setStatus(sel, 'ignored')}>Ignore</button><button className="btn primary" onClick={() => setStatus(sel, 'resolved')}>Mark resolved</button></> : <button className="btn" onClick={() => setStatus(sel, 'open')}>Reopen</button>}</>}>
          <Card title="Details"><div className="stack"><p>{sel.whatIsIt}</p><ul style={{ margin: 0, paddingLeft: 18 }}>{(sel.whyFlagged || []).map((w) => <li key={w}>{w}</li>)}</ul>
            <KV items={[['Suggested action', sel.suggestedAction], ['Consequences', sel.consequences], ['First seen', fmtFull(sel.firstSeen)], ['Last seen', fmtFull(sel.lastSeen)], ['Occurrences', sel.occurrences]]} /></div></Card>
          {sel.kind === 'process' && <Card title="Fix options" actions={<a className="small" href={`#/actions?finding=${encodeURIComponent(`rec:${sel.id}`)}`}>Open in Action Center</a>}><RecFixes recId={sel.id} flow={flow} /></Card>}
          {sel.stopCommand && <CommandBlock title="Stop temporarily" cmd={sel.stopCommand} />}
          {sel.preventRestart && <CommandBlock title="Prevent restart" cmd={sel.preventRestart} />}
        </Drawer>
      )}
      {flow.node}
    </div>
  );
}
