import { useRemediationHistory } from '../state/findings';
import { useMemo, useState } from 'react';
import { ApiError, network, useQuery } from '../api';
import type { ActionEvent, Finding, NetConnection, NetHistoryRow, NetworkCurrent } from '../types';
import { Badge, Card, Col, DataTable, Drawer, Empty, ErrorState, PageHead, SearchBox, Sep, SkeletonCards, Stat, Tabs, useToast, Icon } from '../components/ui';
import { LineChart, RangeSelect, Range, filterRange, SERIES_COLORS } from '../components/Chart';
import { useActionFlow } from '../components/ActionFlow';
import { AttemptList, FindingDetail } from '../components/FindingActions';
import { ActionTimeline } from '../components/common';
import { DohCard } from '../components/network/DohCard';
import { PosturePanel } from '../components/network/PosturePanel';
import { ConnectionDrawer, DeepPanel, DnsPanel, RulesPanel, addr, signedBadge } from '../components/NetworkParts';
import { useStatus } from '../state/StatusProvider';
import { useHash, go, useBack } from '../router';
import { usePageState } from '../state/pageState';
import { RiskLink } from '../components/Linked';
import { CsvButton } from '../components/CsvButton';
import { ago } from '../format';
import { confidenceLabel } from '../labels';

type Tab = 'overview' | 'connections' | 'listening' | 'dns' | 'firewall' | 'findings' | 'deep';
const TONE_BY_RISK: Record<string, string> = { HIGH: 'crit', MEDIUM: 'warn', LOW: 'ok' };

export default function NetworkGuard() {
  const { params } = useHash();
  const { check } = useStatus();
  const toast = useToast();
  const q = useQuery<NetworkCurrent>('/api/network/current');
  const hist = useQuery<{ items: NetHistoryRow[] }>('/api/network/history?range=90');
  const acts = useQuery<ActionEvent[]>('/api/actions?category=network&limit=12');
  const fixes = useRemediationHistory();
  const [ps, setPs] = usePageState('network', { tab: 'overview', range: '30', q: '', state: '', unsigned: '', risk: '' });
  const tab = (['overview', 'connections', 'listening', 'dns', 'firewall', 'findings', 'deep'].includes(ps.tab) ? ps.tab : 'overview') as Tab;
  const range = ([7, 30, 90].includes(Number(ps.range)) ? Number(ps.range) : 30) as Range; const text = ps.q; const state = ps.state; const onlyUnsigned = ps.unsigned === '1';
  const setTab = (t: Tab) => setPs({ tab: t }); const setRange = (r: Range) => setPs({ range: String(r) }); const setText = (v: string) => setPs({ q: v }); const setState = (v: string) => setPs({ state: v }); const setOnlyUnsigned = (v: boolean) => setPs({ unsigned: v ? '1' : '' });
  const back = useBack();
  const [sel, setSel] = useState<NetConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () => { q.reload(); hist.reload(); void check(true); };
  const flow = useActionFlow(reload);
  const cur = q.data;
  const snap = cur?.snapshot ?? null;
  const conns = useMemo(() => snap?.connections ?? [], [snap]);
  const active = useMemo(() => conns.filter((c) => !/listen/i.test(c.state)), [conns]);
  const listeners = useMemo(() => conns.filter((c) => /listen/i.test(c.state)), [conns]);
  const allFindings = useMemo(() => cur?.findings ?? [], [cur]);
  const findings = useMemo(() => allFindings.filter((f) => !ps.risk || f.risk === ps.risk), [allFindings, ps.risk]);
  const openFinding = params.get('finding'); const shownFinding = openFinding ? allFindings.find((f) => f.id === openFinding) ?? null : null;

  const takeSnapshot = async () => { setBusy(true); try { await network.snapshot(); toast('ok', 'Network snapshot taken.'); reload(); } catch (e) { toast('error', (e as ApiError).message); } finally { setBusy(false); } };

  const programs = useMemo(() => { const m = new Map<string, string>(); for (const c of conns) if (c.process.path && !m.has(c.process.path)) m.set(c.process.path, c.process.name); return [...m].map(([path, name]) => ({ name, path })).sort((a, b) => a.name.localeCompare(b.name)); }, [conns]);
  const talkers = useMemo(() => {
    const m = new Map<number, { conn: NetConnection; n: number; dests: Set<string> }>();
    for (const c of active) { if (!c.remoteAddress) continue; const g = m.get(c.pid) ?? { conn: c, n: 0, dests: new Set<string>() }; g.n++; g.dests.add(c.remoteAddress); m.set(c.pid, g); }
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 12);
  }, [active]);

  const shown = useMemo(() => active.filter((c) => (!state || c.state === state) && (!onlyUnsigned || c.process.signed === false) && (!text || `${c.process.name} ${c.remoteAddress} ${c.localPort} ${c.remotePort} ${c.pid} ${c.process.path || ''}`.toLowerCase().includes(text.toLowerCase()))), [active, state, onlyUnsigned, text]);
  const states = useMemo(() => [...new Set(active.map((c) => c.state))].sort(), [active]);
  const metrics = filterRange(hist.data?.items ?? [], range);

  const connCols: Col<NetConnection>[] = [
    { key: 'proc', label: 'Program', sort: (c) => c.process.name.toLowerCase(), render: (c) => <span className="stack tight"><b>{c.process.name}</b><span className="small muted num">PID {c.pid}</span></span> },
    { key: 'sig', label: 'Signature', sort: (c) => String(c.process.signed), render: (c) => signedBadge(c.process) },
    { key: 'remote', label: 'Remote', sort: (c) => c.remoteAddress, render: (c) => <span className="mono-wrap">{addr(c.remoteAddress, c.remotePort)}</span> },
    { key: 'local', label: 'Local', render: (c) => <span className="mono-wrap muted">{addr(c.localAddress, c.localPort)}</span> },
    { key: 'state', label: 'State', sort: (c) => c.state, render: (c) => <Badge tone={/established/i.test(c.state) ? 'info' : ''}>{c.state}</Badge> },
    { key: 'age', label: 'Opened', render: (c) => (c.created ? <span className="small muted">{ago(c.created)}</span> : <span className="small muted">n/a</span>) },
    { key: 'auto', label: '', render: (c) => (c.process.persistent ? <Badge tone="info">auto-start</Badge> : null) },
  ];
  const listenCols: Col<NetConnection>[] = [
    { key: 'port', label: 'Port', align: 'r', sort: (c) => c.localPort, render: (c) => <b className="num">{c.localPort}</b> },
    { key: 'addr', label: 'Reachable on', render: (c) => <span className="mono-wrap">{c.localAddress}</span>, sort: (c) => c.localAddress },
    { key: 'exposure', label: 'Exposure', render: (c) => (c.localAddress.startsWith('127.') || c.localAddress === '::1' ? <Badge tone="ok">this laptop only</Badge> : <Badge tone="warn">network</Badge>) },
    { key: 'proc', label: 'Program', sort: (c) => c.process.name.toLowerCase(), render: (c) => <span className="stack tight"><b>{c.process.name}</b><span className="small muted num">PID {c.pid}</span></span> },
    { key: 'sig', label: 'Signature', render: (c) => signedBadge(c.process) },
  ];
  const findCols: Col<Finding>[] = [
    { key: 'title', label: 'Finding', sort: (f) => f.title, render: (f) => <span className="stack tight"><b>{f.title}</b><span className="small muted trunc" style={{ maxWidth: 560 }}>{f.what}</span></span> },
    { key: 'risk', label: 'Risk', sort: (f) => ['HIGH', 'MEDIUM', 'LOW'].indexOf(String(f.risk)), render: (f) => <RiskLink risk={String(f.risk)} to={`/network?tab=findings&risk=${f.risk}`} /> },
    { key: 'conf', label: 'Confidence', align: 'r', sort: (f) => f.confidence, render: (f) => <span className="num" title={confidenceLabel(f.confidence)}>{Math.round(f.confidence * 100)}%</span> },
    { key: 'fix', label: 'Available actions', render: (f) => <span className="row tight">{f.actions.filter((a) => a.eligible).slice(0, 3).map((a) => <Badge key={a.label} tone={a.admin === 'yes' ? 'warn' : 'accent'}>{a.label}</Badge>)}</span> },
  ];
  const talkCols: Col<(typeof talkers)[number]>[] = [
    { key: 'p', label: 'Program', render: (t) => <b>{t.conn.process.name}</b> }, { key: 's', label: 'Signature', render: (t) => signedBadge(t.conn.process) },
    { key: 'n', label: 'Connections', align: 'r', sort: (t) => t.n, render: (t) => <span className="num">{t.n}</span> }, { key: 'd', label: 'Destinations', align: 'r', sort: (t) => t.dests.size, render: (t) => <span className="num">{t.dests.size}</span> },
  ];

  const stale = cur?.ageSec != null && cur.ageSec > 2 * 3600;
  return (
    <div className="page">
      <PageHead title="Network Guard" sub="What is talking to the network, which program owns it, and Windows Firewall rules that Guardian manages. A local safety layer on top of Defender and Windows Firewall, never a replacement for them."
        actions={<><span className="small muted">{snap ? `Snapshot ${ago(snap.generatedAt)}` : 'No snapshot yet'}</span><button className="btn primary" disabled={busy} onClick={() => void takeSnapshot()}><span className={busy ? 'spin' : ''} style={{ display: 'inline-flex' }}><Icon name="refresh" size={14} /></span>{busy ? 'Reading connections...' : 'Take snapshot now'}</button></>} />
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !cur ? <SkeletonCards n={4} /> : (
        <>
          {!snap && <div className="notice">No network snapshot exists yet. Standard visibility reads the Windows connection tables when you press <b>Take snapshot now</b> (and hourly while the dashboard service runs). It never captures traffic.</div>}
          {stale && <div className="notice warn">This snapshot is {ago(snap?.generatedAt)}. Take a new one for current data.</div>}
          <Tabs<Tab> label="Network Guard" value={tab} onChange={setTab} items={[{ id: 'overview', label: 'Overview' }, { id: 'connections', label: 'Connections', count: active.length }, { id: 'listening', label: 'Listening ports', count: listeners.length + (snap?.udp.length ?? 0) }, { id: 'dns', label: 'DNS' }, { id: 'firewall', label: 'Firewall', count: cur.rules.length }, { id: 'findings', label: 'Findings', count: allFindings.length }, { id: 'deep', label: 'Deep mode' }]}>

          {tab === 'overview' && snap && (
            <div className="stack-lg">
              <div className="grid g4">
                <Stat label="Active connections" value={String(active.filter((c) => /established/i.test(c.state)).length)} sub={`${new Set(active.map((c) => c.remoteAddress).filter(Boolean)).size} remote addresses`} href="/network?tab=connections&state=Established" />
                <Stat label="Listening ports" value={String(listeners.length + snap.udp.length)} sub={`${listeners.length} TCP, ${snap.udp.length} UDP`} href="/network?tab=listening" />
                <Stat label="Unsigned programs online" value={String(new Set(active.filter((c) => c.process.signed === false && c.remoteAddress).map((c) => c.pid)).size)} tone={active.some((c) => c.process.signed === false && c.remoteAddress) ? 'warn' : 'ok'} sub="with outbound connections" href="/network?tab=connections&unsigned=1" />
                <Stat label="Findings" value={String(allFindings.length)} tone={allFindings.some((f) => f.risk === 'HIGH') ? 'crit' : allFindings.length ? 'warn' : 'ok'} sub={allFindings.length ? 'open the Findings tab' : 'nothing unusual'} href="/network?tab=findings&risk=" />
              </div>
              <div className="split">
                <Card title="Mode" actions={<Badge tone={cur.deep.active ? 'warn' : 'ok'} dot>{cur.deep.active ? 'Deep Network Guard on' : 'Standard visibility'}</Badge>}>
                  <div className="stack"><p className="t2"><b>Standard visibility</b> takes a periodic snapshot of connections, listeners, DNS and firewall state. {cur.settings.snapshot.auto ? `Automatic every ${cur.settings.snapshot.everyMinutes} minutes while the dashboard service runs.` : 'Automatic snapshots are off.'} Kept {cur.settings.snapshot.retentionDays} days, up to {cur.settings.snapshot.maxMB} MB.</p>
                    <p className="t2"><b>Deep Network Guard</b> is a separate opt-in mode for connection history and bursts. It is off unless you start it.</p>
                    <div className="row tight">{snap.firewall.profiles.map((p) => <Badge key={p.name} tone={p.enabled ? 'ok' : 'crit'} dot>{p.name} firewall {p.enabled ? 'on' : 'OFF'}</Badge>)}</div></div>
                </Card>
                <Card title="Top programs by connections" flush>
                  <DataTable label="Top network programs" cols={talkCols} rows={talkers} rowKey={(t) => String(t.conn.pid)} onRow={(t) => setSel(t.conn)} empty={<Empty icon="info" title="No outbound connections" />} />
                </Card>
              </div>
              <div className="split even">
                <Card title="Firewall and DNS changes" actions={<a className="small" href="#/actions">Action Center history</a>}>
                  {fixes.error ? <ErrorState error={fixes.error} onRetry={fixes.reload} /> : fixes.data ? <AttemptList attempts={fixes.data.items.filter((h) => h.category === 'firewall' || /^(dns|deep)\./.test(h.actionId)).slice(0, 6)} /> : <p className="small muted">Loading...</p>}
                </Card>
                <Card title="Network activity log" actions={<a className="small" href="#/logs?q=network">Open log</a>}>
                  {acts.error ? <ErrorState error={acts.error} onRetry={acts.reload} /> : acts.data && acts.data.length ? <ActionTimeline rows={acts.data} max={6} /> : <p className="small muted">Snapshots, Deep Network Guard and DNS-policy events appear here.</p>}
                </Card>
              </div>
              <Card title="Trend" actions={<RangeSelect value={range} onChange={setRange} />}>
                {hist.error && <ErrorState error={hist.error} onRetry={hist.reload} />}
                <LineChart emptyTitle="No snapshots in this range" emptyHint="Each network snapshot adds a point. Take one with the button above, or wait for the hourly one." title="Connections over time" x={metrics.map((m) => m.ts)} height={200} digits={0} series={[{ id: 'e', label: 'Established', color: SERIES_COLORS.cpu, values: metrics.map((m) => m.established) }, { id: 'r', label: 'Remote addresses', color: SERIES_COLORS.disk, values: metrics.map((m) => m.remoteAddresses) }, { id: 'l', label: 'Listening', color: SERIES_COLORS.ram, values: metrics.map((m) => m.listening) }]} />
              </Card>
            </div>
          )}

          {tab === 'connections' && (
            <Card flush>
              <div className="filters">
                <SearchBox value={text} onChange={setText} placeholder="Search program, address, port or PID" />
                <select aria-label="State" value={state} onChange={(e) => setState(e.target.value)}><option value="">Any state</option>{states.map((s) => <option key={s}>{s}</option>)}</select>
                <label className="row tight small"><input type="checkbox" checked={onlyUnsigned} onChange={(e) => setOnlyUnsigned(e.target.checked)} />Unsigned only</label>
                <span className="small muted">{shown.length} of {active.length}</span>
                <CsvButton name="laptop-guardian-connections" rows={shown} cols={[{ label: 'Program', get: (c: NetConnection) => c.process.name }, { label: 'PID', get: (c: NetConnection) => c.pid }, { label: 'Protocol', get: (c: NetConnection) => c.proto }, { label: 'State', get: (c: NetConnection) => c.state }, { label: 'Local', get: (c: NetConnection) => `${c.localAddress}:${c.localPort}` }, { label: 'Remote', get: (c: NetConnection) => (c.remoteAddress ? `${c.remoteAddress}:${c.remotePort}` : '') }, { label: 'Signed', get: (c: NetConnection) => c.process.signed }, { label: 'Publisher', get: (c: NetConnection) => c.process.publisher }, { label: 'Path', get: (c: NetConnection) => c.process.path }, { label: 'Opened', get: (c: NetConnection) => c.created }]} />
              </div>
              <DataTable<NetConnection> label="Connections" cols={connCols} rows={shown} rowKey={(c) => `${c.proto}|${c.localAddress}:${c.localPort}|${c.remoteAddress}:${c.remotePort}|${c.pid}`} onRow={setSel} initialSort={{ key: 'proc', dir: 1 }} empty={<Empty icon="network" title="No connections match" />} />
            </Card>
          )}

          {tab === 'listening' && (
            <div className="stack-lg">
              <Card flush><DataTable<NetConnection> label="Listening ports" cols={listenCols} rows={listeners} rowKey={(c) => `${c.localAddress}:${c.localPort}|${c.pid}`} onRow={setSel} initialSort={{ key: 'port', dir: 1 }} empty={<Empty icon="network" title="Nothing is listening" />} /></Card>
              {snap && snap.udp.length > 0 && <Card title="UDP endpoints" flush><DataTable label="UDP endpoints" cols={[{ key: 'p', label: 'Port', align: 'r' as const, sort: (u: NetSnapshotUdp) => u.localPort, render: (u: NetSnapshotUdp) => <b className="num">{u.localPort}</b> }, { key: 'a', label: 'Address', render: (u: NetSnapshotUdp) => <span className="mono-wrap">{u.localAddress}</span> }, { key: 'n', label: 'Program', render: (u: NetSnapshotUdp) => `${snap.processes[String(u.pid)]?.name || 'pid'} (${u.pid})` }]} rows={snap.udp} rowKey={(u) => `${u.localAddress}:${u.localPort}|${u.pid}`} empty={null} /></Card>}
            </div>
          )}

          {tab === 'dns' && <><DnsPanel current={cur} flow={flow} reload={reload} /><DohCard current={cur} flow={flow} /></>}
          {tab === 'firewall' && <><PosturePanel current={cur} flow={flow} /><RulesPanel rules={cur.rules} flow={flow} programs={programs} /></>}
          {tab === 'findings' && (
            <Card flush>
              <DataTable<Finding> label="Network findings" cols={findCols} rows={findings} rowKey={(f) => f.id} onRow={(f) => go(`/network?finding=${encodeURIComponent(f.id)}`)} initialSort={{ key: 'risk', dir: 1 }}
                empty={<Empty icon="check" title="Nothing unusual">Explainable rules found no unsigned outbound programs, unexpected listeners or firewall problems in the latest snapshot.</Empty>} />
            </Card>
          )}
          {tab === 'deep' && <DeepPanel current={cur} flow={flow} reload={reload} />}
          </Tabs>
        </>
      )}
      {sel && <ConnectionDrawer conn={sel} siblings={conns} onClose={() => setSel(null)} flow={flow} />}
      {shownFinding && <Drawer title={shownFinding.title} sub={<span className="row tight"><Icon name="network" size={13} />Network Guard<Sep /><Badge tone={TONE_BY_RISK[String(shownFinding.risk)] || ''}>{String(shownFinding.risk)}</Badge></span>} onClose={() => go('/network?tab=findings')} back={back}><FindingDetail finding={shownFinding} flow={flow} /></Drawer>}
      {flow.node}
    </div>
  );
}

type NetSnapshotUdp = { proto: 'UDP'; localAddress: string; localPort: number; pid: number };
