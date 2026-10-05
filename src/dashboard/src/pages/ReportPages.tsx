import { useState } from 'react';
import { useOverview } from '../state/overview';
import { go } from '../router';
import { useQuery } from '../api';
import type { ActionEvent, ReportRow } from '../types';
import { Badge, Card, Col, DataTable, Empty, ErrorState, PageHead, SkeletonCards, Tabs } from '../components/ui';
import { BarChart, LineChart, Range, RangeSelect, filterRange, SERIES_COLORS } from '../components/Chart';
import { ReportView } from '../components/ReportView';
import { ActionTimeline, RunButtons, useRun } from '../components/common';
import { fmtDate, fmtFull, scoreTone, NA } from '../format';

const historyCols = (type: string): Col<ReportRow>[] => [
  { key: 'id', label: type === 'daily' ? 'Date' : 'Week', sort: (r) => r.id, render: (r) => <b>{r.id}</b> },
  { key: 'gen', label: 'Generated', sort: (r) => r.generatedAt, render: (r) => <span className="small t2">{fmtFull(r.generatedAt)}</span> },
  { key: 'score', label: 'Health', sort: (r) => r.healthScore ?? -1, align: 'r', render: (r) => <Badge tone={scoreTone(r.healthScore)}>{r.healthScore ?? NA}</Badge> },
  { key: 'status', label: 'Status', render: (r) => <Badge tone={r.status === 'complete' ? 'ok' : 'warn'} dot>{r.status}</Badge> },
  { key: 'sum', label: 'Summary', render: (r) => <span className="t2 trunc" style={{ maxWidth: 380, display: 'inline-block' }}>{r.summary?.headline}</span> },
];

export function DailyPage() {
  const ov = useOverview();
  const [tab, setTab] = useState<'latest' | 'history' | 'metrics' | 'actions'>('latest');
  const [range, setRange] = useState<Range>(30);
  const list = useQuery<ReportRow[]>(tab === 'history' ? '/api/reports?type=daily' : null);
  const acts = useQuery<ActionEvent[]>(tab === 'actions' ? '/api/actions?limit=300' : null);
  const d = ov.data?.daily;
  const m = filterRange(ov.data?.metrics || [], range); const x = m.map((r) => r.ts);
  return (
    <div className="page">
      <PageHead title="Daily" sub={`A fast audit${ov.data?.next.daily ? `, next one ${fmtDate(ov.data.next.daily)}` : ' (the daily schedule is off in Settings)'}. Observes, recommends, and performs only the cleanup and blacklist actions you authorized.`} actions={<RunButtons onStarted={ov.reload} />} />
      <Tabs value={tab} onChange={setTab} label="Daily views" items={[{ id: 'latest', label: 'Current report' }, { id: 'history', label: 'History' }, { id: 'metrics', label: 'Metrics' }, { id: 'actions', label: 'Actions' }]}>
      {tab === 'latest' && (ov.error ? <ErrorState error={ov.error} onRetry={ov.reload} /> : !ov.data ? <SkeletonCards /> : d ? <ReportView r={d} /> : <Card><Empty icon="daily" title="No daily report yet">Run a daily scan, or wait for the scheduled run.</Empty></Card>)}
      {tab === 'history' && (list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <SkeletonCards n={2} /> : <Card flush><DataTable label="Daily reports" cols={historyCols('daily')} rows={list.data} rowKey={(r) => r.id} onRow={(r) => go(`/reports?type=daily&id=${r.id}`)} initialSort={{ key: 'id', dir: -1 }} empty={<Empty title="No daily reports" />} /></Card>)}
      {tab === 'metrics' && (
        <>
          <div className="row"><RangeSelect value={range} onChange={setRange} /></div>
          <div className="grid g2">
            <Card title="CPU and RAM"><LineChart title="CPU and RAM" x={x} unit="%" min={0} max={100} digits={0} series={[{ id: 'c', label: 'CPU', color: SERIES_COLORS.cpu, values: m.map((r) => r.cpuPct) }, { id: 'r', label: 'RAM', color: SERIES_COLORS.ram, values: m.map((r) => r.ramPct) }]} /></Card>
            <Card title="Disk usage"><LineChart title="Disk usage" x={x} unit="%" digits={1} series={[{ id: 'd', label: 'Used', color: SERIES_COLORS.disk, values: m.map((r) => r.diskUsedPct) }]} hideLegend /></Card>
            <Card title="Free disk space"><LineChart title="Free disk space" x={x} unit=" GB" area series={[{ id: 'f', label: 'Free', color: SERIES_COLORS.disk, values: m.map((r) => r.diskFreeGB) }]} hideLegend /></Card>
            <Card title="Process count"><LineChart title="Processes" x={x} digits={0} series={[{ id: 'p', label: 'Processes', color: SERIES_COLORS.cpu, values: m.map((r) => r.processCount) }]} hideLegend /></Card>
            <Card title="Flagged processes"><BarChart emptyHint="Appears after the first daily scan." title="Flagged" x={x} values={m.map((r) => r.flaggedCount)} color="var(--s2)" /></Card>
            <Card title="Recommendations"><BarChart emptyHint="Appears after the first daily scan." title="Recommendations" x={x} values={m.map((r) => r.recommendationCount)} color="var(--s3)" /></Card>
            <Card title="Actions taken"><BarChart emptyHint="Appears after the first daily scan." title="Actions" x={x} values={m.map((r) => r.actionCount)} color="var(--s1)" /></Card>
            <Card title="Errors"><BarChart emptyHint="Appears after the first daily scan." title="Errors" x={x} values={m.map((r) => r.errorCount)} color="var(--crit)" /></Card>
            <Card title="Startup applications"><LineChart title="Startup items" x={x} digits={0} series={[{ id: 's', label: 'Startup items', color: SERIES_COLORS.ram, values: m.map((r) => r.startupCount) }]} hideLegend /></Card>
            <Card title="Service failures"><BarChart emptyHint="Appears after the first daily scan." title="Service failures" x={x} values={m.map((r) => r.serviceFailures)} color="var(--crit)" /></Card>
          </div>
        </>
      )}
      {tab === 'actions' && (acts.error ? <ErrorState error={acts.error} onRetry={acts.reload} /> : !acts.data ? <SkeletonCards n={1} /> : <Card title="Daily-run actions">{acts.data.filter((a) => a.runType === 'daily').length ? <ActionTimeline rows={acts.data.filter((a) => a.runType === 'daily')} max={60} /> : <Empty title="No daily actions recorded" />}</Card>)}
      </Tabs>
    </div>
  );
}

export function WeeklyPage() {
  const ov = useOverview();
  const [tab, setTab] = useState<'latest' | 'history' | 'analysis'>('latest');
  const list = useQuery<ReportRow[]>(tab !== 'latest' ? '/api/reports?type=weekly' : null);
  const { busy, start } = useRun();
  const w = ov.data?.weekly;
  const sc = ov.data?.safety;
  return (
    <div className="page">
      <PageHead title="Weekly" sub={`Deep analysis${ov.data?.next.weekly ? `, next one ${fmtDate(ov.data.next.weekly)}` : ' (the weekly schedule is off in Settings)'}: integrity checks, a full Defender scan, storage review and pattern analysis${ov.data?.safety.weeklyShutdown ? ', followed by a controlled shutdown' : ''}.`} actions={<button className="btn" disabled={!!busy} onClick={() => start('weekly', ov.reload)}>{busy ? 'Starting...' : 'Run weekly analysis (no shutdown)'}</button>} />
      {sc && (!sc.weeklyShutdown) && <div className="notice">Weekly shutdown is off. The machine stays on after analysis.</div>}
      <Tabs value={tab} onChange={setTab} label="Weekly views" items={[{ id: 'latest', label: 'Current report' }, { id: 'history', label: 'History' }, { id: 'analysis', label: 'Analysis' }]}>
      {tab === 'latest' && (ov.error ? <ErrorState error={ov.error} onRetry={ov.reload} /> : !ov.data ? <SkeletonCards /> : w ? <ReportView r={w} /> : <Card><Empty icon="weekly" title="No weekly report yet">The first deep analysis runs at the scheduled time on Saturday.</Empty></Card>)}
      {tab === 'history' && (list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <SkeletonCards n={2} /> : <Card flush><DataTable label="Weekly reports" cols={historyCols('weekly')} rows={list.data} rowKey={(r) => r.id} onRow={(r) => go(`/reports?type=weekly&id=${r.id}`)} initialSort={{ key: 'id', dir: -1 }} empty={<Empty title="No weekly reports" />} /></Card>)}
      {tab === 'analysis' && (
        <div className="stack-lg">
          <Card title="Health score by week">{list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : list.data ? <LineChart emptyTitle="No weekly reports yet" emptyHint="The chart appears after the first weekly analysis has finished." title="Weekly health" x={[...list.data].reverse().map((r) => r.generatedAt)} min={0} max={100} digits={0} series={[{ id: 'h', label: 'Health', color: 'var(--accent)', values: [...list.data].reverse().map((r) => r.healthScore) }]} hideLegend /> : <SkeletonCards n={1} />}</Card>
          {w?.ai?.briefing ? <Card title="Latest AI analysis"><p className="t2" style={{ maxWidth: '72ch' }}>{w.ai.briefing}</p></Card> : <Card><Empty icon="info" title="No AI analysis">Enable Gemini in Settings to get weekly pattern analysis.</Empty></Card>}
          {w?.weekly?.recurring?.length ? <Card title="Recurring problems">{w.weekly.recurring.map((x: { title: string; days: number; detail: string }) => <div key={x.title} className="row spread"><span><b>{x.title}</b> <span className="muted">{x.detail}</span></span><Badge tone="warn">{x.days} days</Badge></div>)}</Card> : null}
        </div>
      )}
      </Tabs>
    </div>
  );
}
