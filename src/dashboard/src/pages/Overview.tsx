import { useMemo, useState } from 'react';
import { useOverview } from '../state/overview';
import { go } from '../router';
import { useQuery } from '../api';
import type { ActionEvent, Overview as OverviewT, Recommendation } from '../types';
import { Badge, Card, Empty, ErrorState, Expander, Icon, PageHead, RiskBadge, Sep, Skeleton, SkeletonCards, Tabs } from '../components/ui';
import { LineChart, RangeSelect, Range, filterRange, ScoreRing, SERIES_COLORS, Sparkline } from '../components/Chart';
import { ActionTimeline, RunButtons } from '../components/common';
import { AttentionCard, TaskStatusCard } from '../components/AttentionPanels';
import { useStatus } from '../state/StatusProvider';
import { ago, fmtFull, until, scoreTone, NA, riskTone } from '../format';

type Trend = 'health' | 'storage' | 'load';

interface VitalProps { label: string; value: string; unit?: string; sub?: string; tone?: string; bar?: number; spark?: (number | null | undefined)[]; sparkColor?: string; href: string; hint: string }
/** One vital sign. The whole tile is a link to the page that explains it. */
function Vital({ label, value, unit, sub, tone, bar, spark, sparkColor, href, hint }: VitalProps) {
  return (
    <a className="vital" href={href} data-tone={tone || undefined} aria-label={`${label}: ${value}${unit || ''}. ${hint}`}>
      <span className="eyebrow">{tone && <i className={`dot ${tone}`} />}{label}</span>
      <span className="v-value">{value}{unit && <small>{unit}</small>}</span>
      {bar != null && <span className="bar" aria-hidden="true"><i className={tone === 'crit' ? 'crit' : tone === 'warn' ? 'warn' : ''} style={{ width: `${Math.min(100, Math.max(0, bar))}%` }} /></span>}
      <span className="small muted trunc">{sub || ' '}</span>
      {spark && <span className="spark"><Sparkline values={spark} color={sparkColor} w={64} h={22} /></span>}
    </a>
  );
}

function RecList({ items }: { items: Recommendation[] }) {
  return (
    <div className="list">
      {items.map((r) => (
        <button key={r.id} className="list-row" data-tone={riskTone(r.risk) || undefined} onClick={() => go(r.kind === 'process' ? `/processes?rec=${r.id}` : '/recommendations')}>
          <span className="what">
            <b className="trunc">{r.title}</b>
            <span className="small t2 trunc">{r.whatIsIt || r.whyFlagged?.[0] || r.suggestedAction}</span>
            <span className="small muted">{r.kind}<Sep />{(r.consecutiveDays ?? 0) > 1 ? `${r.consecutiveDays} days in a row` : `seen ${ago(r.lastSeen)}`}</span>
          </span>
          <RiskBadge risk={r.risk} />
          <Icon name="chev" size={14} />
        </button>
      ))}
    </div>
  );
}

/** Same shape as the loaded hero, so the page does not jump when data arrives. */
function OverviewSkeleton() {
  return (
    <>
      <section className="hero card" role="status" aria-label="Loading">
        <div className="hero-main">
          <Skeleton h={104} w={104} />
          <div className="hero-text"><Skeleton h={11} w={90} /><Skeleton h={26} w={200} /><Skeleton h={13} w="70%" /></div>
        </div>
        <div className="vitals">{Array.from({ length: 5 }, (_, i) => <div key={i} className="vital"><Skeleton h={11} w={70} /><Skeleton h={24} w={80} /><Skeleton h={12} w="60%" /></div>)}</div>
      </section>
      <div className="split"><SkeletonCards n={1} h={160} /><SkeletonCards n={1} h={160} /></div>
    </>
  );
}

const verdict =(score?: number) => (score == null ? 'No data yet' : score >= 85 ? 'Healthy' : score >= 70 ? 'Needs attention' : 'Degraded');

export default function Overview() {
  const ov = useOverview();
  const { status } = useStatus();
  const recs = useQuery<{ items: Recommendation[] }>('/api/recommendations?status=open');
  const acts = useQuery<ActionEvent[]>('/api/actions?limit=12');
  const [range, setRange] = useState<Range>(30);
  const [trend, setTrend] = useState<Trend>('health');
  const o: OverviewT | null = ov.data;
  const metrics = useMemo(() => filterRange(o?.metrics || [], range), [o, range]);
  const last = o?.metrics?.[o.metrics.length - 1];

  if (ov.error) return <div className="page"><ErrorState error={ov.error} onRetry={ov.reload} /></div>;
  if (!o) return <div className="page" aria-busy="true"><PageHead title="Overview" sub="Loading the latest scan..." /><OverviewSkeleton /></div>;
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
  const openRecs = recs.data?.items || [];
  const attention = status?.attention.filter((a) => a.level !== 'info').length ?? 0; // "info" items are FYI, not problems
  const scanText = d ? `${d.status === 'complete' ? 'Daily scan completed' : `Daily scan finished (${d.status})`} ${ago(d.generatedAt)}` : 'No scan has completed yet';

  return (
    <div className="page">
      <PageHead title="Overview" sub={d ? `${d.host?.name || 'This laptop'}${d.host?.os ? ` - ${d.host.os} ${d.host.build || ''}` : ''}` : 'Waiting for the first scan.'} actions={<RunButtons onStarted={ov.reload} />} />
      {!d && <div className="notice">No daily report exists yet. That is normal right after installing: run a daily scan with the button above (it only observes), or wait for the scheduled run.</div>}

      <section className="hero card" aria-label="Laptop health summary">
        <div className="hero-main">
          <ScoreRing score={d?.healthScore} size={104} />
          <div className="hero-text">
            <span className="eyebrow">Overall health</span>
            <h2 className="verdict" data-tone={scoreTone(d?.healthScore) || undefined}>{verdict(d?.healthScore)}</h2>
            <p className="t2">{d?.summary?.headline || 'Scan results will summarise your laptop here.'}</p>
            <div className="row hero-meta small muted">
              <span className="row tight"><Icon name="clock" size={13} />{scanText}</span><Sep />
              <span>{attention === 0 ? 'Nothing needs attention' : attention === 1 ? '1 item needs attention' : `${attention} items need attention`}</span><Sep />
              <span>Next daily scan {until(o.next.daily)}</span>
            </div>
          </div>
          <div className="hero-actions">
            <a className="btn" href={`#/${d ? 'daily' : 'reports'}`}>{d ? 'Open latest report' : 'Open reports'}</a>
            <a className="btn" href="#/recommendations">Review recommendations{o.openRecommendations ? ` (${o.openRecommendations})` : ''}</a>
          </div>
        </div>
        <div className="vitals">
          <Vital label="Security" href="#/health" hint="Open Health" tone={secTone} value={d ? (secProblems.length ? `${secProblems.length} issue${secProblems.length > 1 ? 's' : ''}` : 'Protected') : NA} sub={secProblems[0] || (def ? `Signatures ${def.sigAgeDays ?? '?'} d old` : '')} />
          <Vital label="Storage (C:)" href="#/files" hint="Open Files and Storage" tone={diskTone} value={diskFree != null ? diskFree.toFixed(0) : NA} unit="% free" bar={sys?.disks?.[0]?.usedPct} sub={sys?.disks?.[0] ? `${sys.disks[0].freeGB} of ${sys.disks[0].totalGB} GB` : ''} spark={o.metrics.slice(-30).map((m) => m.diskFreeGB)} sparkColor="var(--s3)" />
          <Vital label="Memory" href="#/health" hint="Open Health" tone={(sys?.ram?.usedPct ?? 0) > 90 ? 'crit' : (sys?.ram?.usedPct ?? 0) > 80 ? 'warn' : ''} value={sys?.ram?.usedPct?.toFixed(0) ?? NA} unit="%" bar={sys?.ram?.usedPct} sub={sys?.ram ? `${sys.ram.usedGB} / ${sys.ram.totalGB} GB` : ''} spark={o.metrics.slice(-30).map((m) => m.ramPct)} sparkColor="var(--s2)" />
          <Vital label="CPU" href="#/processes" hint="Open Processes" tone={(sys?.cpu?.usagePct ?? 0) > 85 ? 'warn' : ''} value={sys?.cpu?.usagePct?.toFixed(0) ?? NA} unit="%" bar={sys?.cpu?.usagePct} sub={sys?.cpu?.name?.replace(/\(R\)|\(TM\)/g, '')} spark={o.metrics.slice(-30).map((m) => m.cpuPct)} sparkColor="var(--s1)" />
          <Vital label="Battery" href="#/health" hint="Open Health" tone={bat?.present && bat.pct < 20 && !bat.onAC ? 'warn' : ''} value={bat?.present ? `${bat.pct}` : 'n/a'} unit={bat?.present ? '%' : undefined} bar={bat?.present ? bat.pct : undefined} sub={bat?.present ? (bat.onAC ? (bat.charging ? 'Charging' : 'On AC') : 'On battery') : 'No battery detected'} />
        </div>
      </section>

      <div className="split">
        <div className="col">
          <AttentionCard />
          <Card title="Open recommendations" flush actions={<a className="small" href="#/recommendations">View all ({o.openRecommendations})</a>}>
            {recs.error ? <div className="pad"><ErrorState error={recs.error} onRetry={recs.reload} /></div> : !recs.data ? <div className="pad"><SkeletonCards n={1} /></div> : openRecs.length === 0 ? <Empty icon="check" title="Nothing to review">Open recommendations appear here after each scan.</Empty> : <RecList items={openRecs.slice(0, 5)} />}
          </Card>
        </div>
        <div className="col">
          <TaskStatusCard />
          <Card title="Recent activity" actions={<a className="small" href="#/logs">Open log</a>}>
            {!acts.data ? <SkeletonCards n={1} /> : acts.data.length === 0 ? <Empty icon="activity" title="No activity yet">Scans, recommendations and your own actions are listed here.</Empty> : <ActionTimeline rows={acts.data} max={6} />}
          </Card>
        </div>
      </div>

      <Card title="Trends" actions={<RangeSelect value={range} onChange={setRange} />}>
        <div className="stack">
          <Tabs<Trend> label="Trend" value={trend} onChange={setTrend} items={[{ id: 'health', label: 'Health score' }, { id: 'storage', label: 'Free space' }, { id: 'load', label: 'CPU and RAM' }]} />
          {trend === 'health' && <LineChart title="Health score" x={x} height={220} min={0} max={100} area series={[{ id: 'h', label: 'Health', color: 'var(--accent)', values: metrics.map((m) => m.healthScore) }]} hideLegend digits={0} threshold={{ value: 85, label: 'healthy' }} />}
          {trend === 'storage' && <LineChart title="Free disk space" x={x} height={220} unit=" GB" area series={[{ id: 'free', label: 'Free space', color: SERIES_COLORS.disk, values: metrics.map((m) => m.diskFreeGB) }]} />}
          {trend === 'load' && <LineChart title="CPU and RAM" x={x} height={220} unit="%" min={0} max={100} digits={0} series={[{ id: 'cpu', label: 'CPU', color: SERIES_COLORS.cpu, values: metrics.map((m) => m.cpuPct) }, { id: 'ram', label: 'RAM', color: SERIES_COLORS.ram, values: metrics.map((m) => m.ramPct) }]} />}
        </div>
      </Card>

      <div className="split even">
        <Card title="Security status" actions={<a className="small" href="#/health">Open Health</a>}>
          {!d ? <Empty title="No scan data" /> : (
            <div className="stack">
              <div className="row spread"><span>Microsoft Defender</span><Badge tone={def?.enabled ? 'ok' : 'crit'} dot>{def?.enabled ? 'Enabled' : 'Off'}</Badge></div>
              <div className="row spread"><span>Real-time protection</span><Badge tone={def?.realTimeProtection ? 'ok' : 'crit'} dot>{def?.realTimeProtection ? 'On' : 'Off'}</Badge></div>
              <div className="row spread"><span>Signatures</span><span className="num t2">{def?.sigVersion || NA}<Sep />{def?.sigAgeDays ?? '?'} d old</span></div>
              <div className="row spread"><span>Last quick scan</span><span className="t2">{def?.scan?.ran ? def.scan.result : 'not run'}<Sep />{ago(def?.lastQuickScan)}</span></div>
              <div className="row spread"><span>Firewall</span><span className="row tight">{(fw?.profiles || []).map((p: { name: string; enabled: boolean }) => <Badge key={p.name} tone={p.enabled ? 'ok' : 'crit'} dot>{p.name}</Badge>)}</span></div>
              <div className="row spread"><span>Windows Update</span><Badge tone={(wu?.pendingCount || 0) > 0 ? 'warn' : 'ok'} dot>{(wu?.pendingCount || 0) > 0 ? `${wu.pendingCount} pending` : wu?.status || 'Up to date'}</Badge></div>
            </div>
          )}
        </Card>
        <Card title="Weekly AI briefing" actions={o.weekly ? <a className="small" href="#/weekly">{o.weekly.id}</a> : undefined}>
          {o.weekly?.ai?.briefing ? (
            <div className="stack"><p className="t2 measure">{o.weekly.ai.briefing}</p>
              {o.weekly.ai.patterns?.slice(0, 3).map((p) => <div key={p.title} className="notice"><b>{p.title}.</b> {p.detail}</div>)}
              <div className="small muted">Generated by Gemini from structured metadata, then validated locally. It never executes commands.</div></div>
          ) : <Empty icon="info" title={o.ai.enabled ? 'No briefing yet' : 'AI analysis is off'}>{o.ai.enabled ? 'The weekly run writes a briefing after the weekly analysis.' : 'Turn on Gemini in Settings for weekly pattern analysis. Everything else works without it.'}</Empty>}
        </Card>
      </div>

      <Card title="Recent errors" actions={<Badge tone={errors.length ? 'warn' : 'ok'}>{errors.length}</Badge>} flush>
        {errors.length === 0 ? <Empty icon="check" title="No errors in the latest report" /> : errors.map((e, i) => (
          <Expander key={i} head={<><Badge tone="crit">{e.source}</Badge><span className="trunc">{e.message}</span></>}>
            <div className="mono-block">{e.message}</div><div className="small muted">{fmtFull(e.ts)}</div>
          </Expander>
        ))}
      </Card>
    </div>
  );
}
