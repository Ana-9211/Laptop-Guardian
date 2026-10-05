import { useMemo, useState } from 'react';
import { useOverview } from '../state/overview';
import { go } from '../router';
import { useQuery } from '../api';
import type { ActionEvent, Recommendation } from '../types';
import { Badge, Card, Empty, ErrorState, Expander, PageHead, SkeletonCards, Stat } from '../components/ui';
import { LineChart, RangeSelect, Range, filterRange, ScoreRing, SERIES_COLORS, Sparkline } from '../components/Chart';
import { RecCard, ActionTimeline, RunButtons } from '../components/common';
import { AttentionCard, TaskStatusCard } from '../components/AttentionPanels';
import { ago, fmtDate, fmtFull, until, scoreTone, NA } from '../format';

export default function Overview() {
  const ov = useOverview();
  const recs = useQuery<{ items: Recommendation[] }>('/api/recommendations?status=open');
  const acts = useQuery<ActionEvent[]>('/api/actions?limit=12');
  const [range, setRange] = useState<Range>(30);
  const o = ov.data;
  const metrics = useMemo(() => filterRange(o?.metrics || [], range), [o, range]);
  const last = o?.metrics?.[o.metrics.length - 1];

  if (ov.error) return <div className="page"><ErrorState error={ov.error} onRetry={ov.reload} /></div>;
  if (!o) return <div className="page"><PageHead title="Overview" /><SkeletonCards n={8} /></div>;
  const d = o.daily; const sys = d?.sections?.system; const def = d?.sections?.defender; const fw = d?.sections?.firewall; const wu = d?.sections?.windowsHealth?.windowsUpdate;
  const x = metrics.map((m) => m.ts);
  const diskFree = sys?.disks?.[0]?.freePct ?? last?.diskFreePct;
  const diskTone = diskFree == null ? '' : diskFree < 8 ? 'crit' : diskFree < 15 ? 'warn' : 'ok';
  // Defender history keeps quarantined/removed items (status 2, 3, 4, 102-104); only the rest are unresolved.
  const handledStatus = new Set(['2', '3', '4', '102', '103', '104']);
  const activeThreats = Array.isArray(def?.scan?.threats) ? def.scan.threats.filter((t: { status?: unknown }) => !handledStatus.has(String(t.status))).length : (def?.threats || 0);
  const secProblems = [!def?.enabled && 'Defender is off', !def?.realTimeProtection && 'Real-time protection off', activeThreats > 0 && `${activeThreats} unresolved threat(s)`, (def?.sigAgeDays ?? 0) > 2 && 'Signatures outdated', fw?.profiles?.some((p: { enabled: boolean }) => !p.enabled) && 'Firewall profile disabled'].filter(Boolean) as string[];
  const secTone = !d ? '' : secProblems.length ? 'warn' : 'ok';
  const errors = d?.errors || [];
  const bat = sys?.battery;

  return (
    <div className="page">
      <PageHead title="Overview" sub={d ? `${d.host?.name || 'This laptop'} - ${d.host?.os || ''} ${d.host?.build || ''}` : 'No scan has completed yet.'} actions={<RunButtons onStarted={ov.reload} />} />
      {!d && <div className="notice">No daily report exists yet. That is normal right after installing: run a daily scan with the button above (it only observes), or wait for the 7 PM scheduled run.</div>}

      <div className="split">
        <AttentionCard />
        <TaskStatusCard />
      </div>

      <div className="grid g4">
        <div className="card stat">
          <div className="label">Overall health</div>
          <div className="row" style={{ gap: 12, marginTop: 2 }}><ScoreRing score={d?.healthScore} /><div><div className="small t2">{d?.summary?.headline || NA}</div><Badge tone={scoreTone(d?.healthScore)} dot>{d?.healthScore == null ? 'No data' : d.healthScore >= 85 ? 'Healthy' : d.healthScore >= 70 ? 'Needs attention' : 'Degraded'}</Badge></div></div>
        </div>
        <Stat label="Security" tone={secTone} value={d ? (secProblems.length ? `${secProblems.length} issue${secProblems.length > 1 ? 's' : ''}` : 'Protected') : NA} sub={secProblems[0] || (def ? `Signatures ${def.sigAgeDays ?? '?'} d old` : '')} />
        <Stat label="Storage (C:)" tone={diskTone} value={diskFree != null ? diskFree.toFixed(0) : NA} unit="% free" sub={sys?.disks?.[0] ? `${sys.disks[0].freeGB} GB of ${sys.disks[0].totalGB} GB` : ''} bar={sys?.disks?.[0]?.usedPct} spark={<Sparkline values={o.metrics.slice(-30).map((m) => m.diskFreeGB)} color="var(--s3)" />} />
        <Stat label="RAM" tone={(sys?.ram?.usedPct ?? 0) > 90 ? 'crit' : (sys?.ram?.usedPct ?? 0) > 80 ? 'warn' : ''} value={sys?.ram?.usedPct?.toFixed(0) ?? NA} unit="%" sub={sys?.ram ? `${sys.ram.usedGB} / ${sys.ram.totalGB} GB` : ''} bar={sys?.ram?.usedPct} spark={<Sparkline values={o.metrics.slice(-30).map((m) => m.ramPct)} color="var(--s2)" />} />
        <Stat label="CPU" tone={(sys?.cpu?.usagePct ?? 0) > 85 ? 'warn' : ''} value={sys?.cpu?.usagePct?.toFixed(0) ?? NA} unit="%" sub={sys?.cpu?.name?.replace(/\(R\)|\(TM\)/g, '')} bar={sys?.cpu?.usagePct} spark={<Sparkline values={o.metrics.slice(-30).map((m) => m.cpuPct)} color="var(--s1)" />} />
        <Stat label="Battery" value={bat?.present ? `${bat.pct}` : 'n/a'} unit={bat?.present ? '%' : undefined} sub={bat?.present ? (bat.onAC ? (bat.charging ? 'Charging' : 'On AC') : 'On battery') : 'No battery detected'} bar={bat?.present ? bat.pct : undefined} tone={bat?.present && bat.pct < 20 && !bat.onAC ? 'warn' : ''} />
        <Stat label="Last scan" value={ago(d?.generatedAt)} sub={d ? `${fmtFull(d.generatedAt)} - ${d.status}` : 'Never'} tone={d?.status === 'complete' ? 'ok' : d ? 'warn' : ''} />
        <div className="card stat">
          <div className="label">Next scheduled scan</div>
          <div className="value" style={{ fontSize: 20 }}>{until(o.next.daily)}</div>
          <div className="sub">Daily {fmtDate(o.next.daily)}</div>
          <div className="sub">Weekly {fmtDate(o.next.weekly)}{o.next.shutdown ? ` - shutdown ${fmtDate(o.next.shutdown)}` : ''}</div>
        </div>
      </div>

      <div className="row spread"><h2>Trends</h2><RangeSelect value={range} onChange={setRange} /></div>
      <div className="grid g3">
        <Card title="System health score"><LineChart title="Health score" x={x} height={180} min={0} max={100} area series={[{ id: 'h', label: 'Health', color: 'var(--accent)', values: metrics.map((m) => m.healthScore) }]} hideLegend digits={0} threshold={{ value: 85, label: 'healthy' }} /></Card>
        <Card title="Storage"><LineChart title="Disk" x={x} height={180} unit=" GB" series={[{ id: 'free', label: 'Free space', color: SERIES_COLORS.disk, values: metrics.map((m) => m.diskFreeGB) }]} area /></Card>
        <Card title="CPU and RAM"><LineChart title="CPU and RAM" x={x} height={180} unit="%" min={0} max={100} digits={0} series={[{ id: 'cpu', label: 'CPU', color: SERIES_COLORS.cpu, values: metrics.map((m) => m.cpuPct) }, { id: 'ram', label: 'RAM', color: SERIES_COLORS.ram, values: metrics.map((m) => m.ramPct) }]} /></Card>
      </div>

      <div className="split">
        <Card title="Recent recommendations" actions={<a className="small" href="#/recommendations">View all ({o.openRecommendations})</a>}>
          {recs.error ? <ErrorState error={recs.error} onRetry={recs.reload} /> : !recs.data ? <SkeletonCards n={2} /> : recs.data.items.length === 0 ? <Empty icon="check" title="Nothing needs your attention">Open recommendations appear here after each scan.</Empty> : (
            <div className="grid g2">{recs.data.items.slice(0, 6).map((r) => <RecCard key={r.id} rec={r} onOpen={(x) => go(r.kind === 'process' ? `/processes?rec=${x.id}` : '/recommendations')} />)}</div>
          )}
        </Card>
        <Card title="Recent actions" actions={<a className="small" href="#/logs">Open log</a>}>
          {!acts.data ? <SkeletonCards n={1} /> : acts.data.length === 0 ? <Empty title="No actions yet" /> : <ActionTimeline rows={acts.data} max={8} />}
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Security status">
          {!d ? <Empty title="No scan data" /> : (
            <div className="stack">
              <div className="row spread"><span>Microsoft Defender</span><Badge tone={def?.enabled ? 'ok' : 'crit'} dot>{def?.enabled ? 'Enabled' : 'Off'}</Badge></div>
              <div className="row spread"><span>Real-time protection</span><Badge tone={def?.realTimeProtection ? 'ok' : 'crit'} dot>{def?.realTimeProtection ? 'On' : 'Off'}</Badge></div>
              <div className="row spread"><span>Signatures</span><span className="num t2">{def?.sigVersion || NA} - {def?.sigAgeDays ?? '?'} d old</span></div>
              <div className="row spread"><span>Last quick scan</span><span className="t2">{def?.scan?.ran ? def.scan.result : 'not run'} - {ago(def?.lastQuickScan)}</span></div>
              <div className="row spread"><span>Firewall</span><span className="row tight">{(fw?.profiles || []).map((p: { name: string; enabled: boolean }) => <Badge key={p.name} tone={p.enabled ? 'ok' : 'crit'} dot>{p.name}</Badge>)}</span></div>
              <div className="row spread"><span>Windows Update</span><Badge tone={(wu?.pendingCount || 0) > 0 ? 'warn' : 'ok'} dot>{(wu?.pendingCount || 0) > 0 ? `${wu.pendingCount} pending` : wu?.status || 'Up to date'}</Badge></div>
            </div>
          )}
        </Card>
        <Card title="Weekly AI briefing" actions={o.weekly && <span className="small muted">{o.weekly.id}</span>}>
          {o.weekly?.ai?.briefing ? (
            <div className="stack"><p className="t2" style={{ maxWidth: '68ch' }}>{o.weekly.ai.briefing}</p>
              {o.weekly.ai.patterns?.slice(0, 3).map((p) => <div key={p.title} className="notice"><b>{p.title}.</b> {p.detail}</div>)}
              <div className="small muted">Generated by Gemini from structured metadata, then validated locally. It never executes commands.</div></div>
          ) : <Empty icon="info" title={o.ai.enabled ? 'No briefing yet' : 'AI analysis is off'}>{o.ai.enabled ? 'The weekly run writes a briefing after the weekly analysis.' : 'Turn on Gemini in Settings for weekly pattern analysis. Everything else works without it.'}</Empty>}
        </Card>
      </div>

      <Card title="Recent errors" actions={<Badge tone={errors.length ? 'warn' : 'ok'}>{errors.length}</Badge>} className="" flush>
        {errors.length === 0 ? <Empty icon="check" title="No errors in the latest report" /> : errors.map((e, i) => (
          <Expander key={i} head={<><Badge tone="crit">{e.source}</Badge><span className="trunc">{e.message}</span></>}>
            <div className="mono-block">{e.message}</div><div className="small muted">{fmtFull(e.ts)}</div>
          </Expander>
        ))}
      </Card>
    </div>
  );
}
