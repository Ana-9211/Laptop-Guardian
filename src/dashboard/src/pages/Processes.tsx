import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '../api';
import type { Policy, Process, Recommendation } from '../types';
import { Badge, Card, Col, DataTable, Empty, ErrorState, PageHead, RiskBadge, SearchBox, SkeletonCards, Tabs, Tip } from '../components/ui';
import { ProcessDrawer } from '../components/ProcessDrawer';
import { fmtMB, pct, fmtDate, NA } from '../format';
import { go, useHash, useBack } from '../router';
import { usePageState } from '../state/pageState';
import { CsvButton } from '../components/CsvButton';
import { flagLabel } from '../labels';

type Tab = 'all' | 'flagged' | 'persistent' | 'high' | 'recommended' | 'blacklisted' | 'whitelisted';

export default function Processes() {
  const procs = useQuery<{ generatedAt: string | null; processes: Process[] }>('/api/processes');
  const recs = useQuery<{ items: Recommendation[] }>('/api/recommendations');
  const { params } = useHash();
  const [ps, setPs] = usePageState('processes', { tab: 'all', q: '' });
  const tab = (['all', 'flagged', 'persistent', 'high', 'recommended', 'blacklisted', 'whitelisted'].includes(ps.tab) ? ps.tab : 'all') as Tab; const q = ps.q;
  const setTab = (t: Tab) => setPs({ tab: t }); const setQ = (v: string) => setPs({ q: v });
  const back = useBack();
  const [sel, setSel] = useState<Process | null>(null);
  const reload = () => { procs.reload(); recs.reload(); };

  const list = useMemo(() => procs.data?.processes ?? [], [procs.data]);
  const recById = useMemo(() => new Map((recs.data?.items || []).map((r) => [r.id, r])), [recs.data]);

  // Deep link: #/processes?rec=<id> or ?name=<name>
  useEffect(() => {
    const rec = params.get('rec'); const name = params.get('name');
    const p = list.find((x) => (rec && x.recommendationId === rec) || (name && x.name === name));
    if (p) setSel(p);
  }, [params, list]);

  const counts = useMemo(() => ({
    all: list.length,
    flagged: list.filter((p) => (p.flags || []).some((f) => f !== 'whitelisted')).length,
    persistent: list.filter((p) => p.persistent).length,
    high: list.filter((p) => (p.flags || []).some((f) => f === 'high-cpu' || f === 'high-memory')).length,
    recommended: list.filter((p) => p.recommendationId).length,
    blacklisted: list.filter((p) => p.policy === 'blacklist').length,
    whitelisted: list.filter((p) => p.policy === 'whitelist').length,
  }), [list]);

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return list.filter((p) => {
      const f = p.flags || [];
      if (tab === 'flagged' && !f.some((x) => x !== 'whitelisted')) return false;
      if (tab === 'persistent' && !p.persistent) return false;
      if (tab === 'high' && !f.some((x) => x === 'high-cpu' || x === 'high-memory')) return false;
      if (tab === 'recommended' && !p.recommendationId) return false;
      if (tab === 'blacklisted' && p.policy !== 'blacklist') return false;
      if (tab === 'whitelisted' && p.policy !== 'whitelist') return false;
      return !t || `${p.name} ${p.path || ''} ${p.publisher || ''} ${p.pid}`.toLowerCase().includes(t);
    });
  }, [list, tab, q]);

  const cols: Col<Process>[] = [
    { key: 'name', label: 'Process', sort: (p) => p.name.toLowerCase(), render: (p) => <span className="row tight" style={{ flexWrap: 'nowrap' }}><b>{p.name}</b>{(p.instances || 1) > 1 && <Tip text={`${p.instances} running instances`}><span className="muted num small">x{p.instances}</span></Tip>}</span> },
    { key: 'pid', label: 'PID', sort: (p) => p.pid, render: (p) => <span className="num muted">{p.pid}</span>, align: 'r' },
    { key: 'cpu', label: 'CPU', sort: (p) => p.cpuPct, render: (p) => <span className="num">{pct(p.cpuPct, 1)}</span>, align: 'r' },
    { key: 'ram', label: 'RAM', sort: (p) => p.memoryMB, render: (p) => <span className="num">{fmtMB(p.memoryMB)}</span>, align: 'r' },
    { key: 'pub', label: 'Publisher', sort: (p) => (p.publisher || '').toLowerCase(), render: (p) => p.publisher ? <span className="trunc" style={{ maxWidth: 160, display: 'inline-block' }}>{p.publisher}</span> : <span className="muted">none</span> },
    { key: 'signed', label: 'Signed', sort: (p) => (p.signed ? 1 : 0), render: (p) => <Badge tone={p.signed ? 'ok' : 'warn'} dot>{p.signed ? 'Yes' : p.signature === 'Unknown' ? 'Unknown' : 'No'}</Badge> },
    { key: 'path', label: 'Path', render: (p) => <Tip text={p.path || 'Path not accessible'}><span className="path trunc" style={{ display: 'inline-block' }}>{p.path || NA}</span></Tip> },
    { key: 'persist', label: 'Persistence', sort: (p) => (p.persistent ? 1 : 0), render: (p) => p.persistent ? <span className="row tight">{[...new Set([...(p.startupEntries || []).map((s) => s.kind), ...((p.services || []).length ? ['service'] : [])])].map((k) => <Badge key={k} tone="info">{k}</Badge>)}{!p.startupEntries?.length && !p.services?.length && <Badge tone="info">yes</Badge>}</span> : <span className="muted">n/a</span> },
    { key: 'status', label: 'Status', render: (p) => <span className="row tight" style={{ flexWrap: 'nowrap' }}>{(p.flags || []).filter((f) => ['high-cpu', 'high-memory', 'unusual-location'].includes(f)).slice(0, 1).map((f) => <Badge key={f} tone="warn">{flagLabel(f)}</Badge>)}</span> },
    { key: 'rec', label: 'Recommendation', sort: (p) => recById.get(p.recommendationId || '')?.suggestedAction || '~', render: (p) => { const r = recById.get(p.recommendationId || ''); return r ? <span className="row tight" style={{ flexWrap: 'nowrap' }}><RiskBadge risk={r.risk} /><span className="small t2 trunc" style={{ maxWidth: 130 }}>{r.suggestedAction}</span></span> : <span className="muted">n/a</span>; } },
    { key: 'policy', label: 'Policy', sort: (p) => p.policy || 'none', render: (p) => p.policy && p.policy !== 'none' ? <Badge tone={p.policy === 'blacklist' ? 'crit' : 'accent'}>{p.policy}</Badge> : <span className="muted">n/a</span> },
  ];

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: counts.all }, { id: 'flagged', label: 'Flagged', count: counts.flagged }, { id: 'persistent', label: 'Persistent', count: counts.persistent },
    { id: 'high', label: 'High resource', count: counts.high }, { id: 'recommended', label: 'Recommended', count: counts.recommended },
    { id: 'blacklisted', label: 'Blacklisted', count: counts.blacklisted }, { id: 'whitelisted', label: 'Whitelisted', count: counts.whitelisted },
  ];
  const close = () => { setSel(null); if (params.get('rec') || params.get('name')) go('/processes'); };
  const selRec = sel ? recById.get(sel.recommendationId || '') : null;

  return (
    <div className="page">
      <PageHead title="Processes" sub={procs.data?.generatedAt ? `Snapshot from ${fmtDate(procs.data.generatedAt)}. Processes with the same name are grouped. Select a row for evidence, commands and actions.` : 'Snapshot of running processes from the latest scan.'} />
      {procs.error ? <ErrorState error={procs.error} onRetry={reload} /> : !procs.data ? <SkeletonCards n={4} h={140} /> : (
        <Card flush>
          <Tabs value={tab} onChange={setTab} items={tabs} label="Process filters" listStyle={{ padding: '0 14px' }} panelStyle={{ gap: 0 }}>
          <div className="filters"><SearchBox value={q} onChange={setQ} placeholder="Search name, path, publisher or PID" /><span className="small muted">{rows.length} of {list.length}</span><CsvButton name="laptop-guardian-processes" rows={rows} cols={[{ label: 'Process', get: (p: Process) => p.name }, { label: 'PID', get: (p: Process) => p.pid }, { label: 'CPU %', get: (p: Process) => p.cpuPct }, { label: 'RAM MB', get: (p: Process) => p.memoryMB }, { label: 'Publisher', get: (p: Process) => p.publisher }, { label: 'Signed', get: (p: Process) => p.signed }, { label: 'Path', get: (p: Process) => p.path }, { label: 'Persistent', get: (p: Process) => p.persistent }, { label: 'Flags', get: (p: Process) => (p.flags || []).join('; ') }, { label: 'Policy', get: (p: Process) => p.policy }]} /></div>
          <DataTable label="Processes" cols={cols} rows={rows} rowKey={(p) => `${p.name}:${p.pid}`} onRow={setSel} selected={sel ? `${sel.name}:${sel.pid}` : null} initialSort={{ key: 'ram', dir: -1 }} persistKey="processes"
            empty={<Empty icon="processes" title={list.length ? 'No processes match' : 'No process snapshot yet'}>{list.length ? 'Try another filter or clear the search.' : 'Run a daily scan to collect the first snapshot.'}</Empty>} />
          </Tabs>
        </Card>
      )}
      {sel && <ProcessDrawer proc={sel} rec={selRec} onClose={close} onChanged={() => { reload(); }} back={params.get('rec') || params.get('name') ? back : null} />}
    </div>
  );
}

export type { Policy };
