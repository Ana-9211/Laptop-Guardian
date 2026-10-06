import { usePageState } from '../state/pageState';
import { useOverview } from '../state/overview';
import { Badge, Card, Empty, ErrorState, KV, PageHead, SkeletonCards, Stat, Tabs } from '../components/ui';
import { HealthActions } from '../components/HealthActions';
import { QuickActions } from '../components/QuickActions';
import { LineChart, Range, RangeSelect, filterRange, SERIES_COLORS } from '../components/Chart';
import { ago, fmtDate, fmtMB, pct, NA } from '../format';
import type { Any } from '../types';

type Tab = 'cpu' | 'ram' | 'disk' | 'battery' | 'windows' | 'defender' | 'firewall' | 'network';
const yn = (v: unknown, good = 'Yes', bad = 'No') => <Badge tone={v ? 'ok' : 'crit'} dot>{v ? good : bad}</Badge>;

export default function Health() {
  const ov = useOverview();
  const [ps, setPs] = usePageState('health', { tab: 'cpu', range: '30' });
  const tab = (['cpu', 'ram', 'disk', 'battery', 'windows', 'defender', 'firewall', 'network'].includes(ps.tab) ? ps.tab : 'cpu') as Tab; const range = ([7, 30, 90].includes(Number(ps.range)) ? Number(ps.range) : 30) as Range;
  const setTab = (t: Tab) => setPs({ tab: t }); const setRange = (r: Range) => setPs({ range: String(r) });
  const o = ov.data; const d = o?.daily; const s: Any = d?.sections || {};
  if (ov.error) return <div className="page"><ErrorState error={ov.error} onRetry={ov.reload} /></div>;
  if (!o) return <div className="page"><PageHead title="Health" /><SkeletonCards /></div>;
  if (!d) return <div className="page"><PageHead title="Health" /><Card><Empty icon="health" title="No health data yet">Run a daily scan to populate this page.</Empty></Card></div>;
  const m = filterRange(o.metrics, range); const x = m.map((r) => r.ts);
  const sys = s.system || {}; const wh = s.windowsHealth || {}; const def = s.defender || {}; const net = s.network || {}; const fw = s.firewall || {}; const bat = sys.battery;

  return (
    <div className="page">
      <PageHead title="Health" sub={`At last scan (${ago(d.generatedAt)}), not live. Numbers come from the daily report; run a scan for fresh ones.`} actions={['cpu', 'ram', 'disk', 'battery'].includes(tab) ? <RangeSelect value={range} onChange={setRange} /> : undefined} />
      <HealthActions />
      <QuickActions set="health" />
      <Tabs<Tab> value={tab} onChange={setTab} label="Health areas" items={[{ id: 'cpu', label: 'CPU' }, { id: 'ram', label: 'RAM' }, { id: 'disk', label: 'Disk' }, { id: 'battery', label: 'Battery' }, { id: 'windows', label: 'Windows' }, { id: 'defender', label: 'Defender' }, { id: 'firewall', label: 'Firewall' }, { id: 'network', label: 'Network' }]}>

      {tab === 'cpu' && <>
        <div className="grid g4"><Stat label="Usage now" value={sys.cpu?.usagePct?.toFixed(0) ?? NA} unit="%" bar={sys.cpu?.usagePct} href="/processes?tab=high" /><Stat label="Cores / threads" value={`${sys.cpu?.cores ?? NA} / ${sys.cpu?.logical ?? NA}`} sub={sys.cpu?.name} /><Stat label="Load" value={typeof sys.load === 'object' ? (sys.load?.processorQueue ?? NA) : (sys.load ?? NA)} sub="Processor queue length" /><Stat label="Temperature" value={sys.temperature?.available ? `${sys.temperature.celsius}` : 'n/a'} unit={sys.temperature?.available ? '\u00b0C' : undefined} sub={sys.temperature?.available ? '' : 'No reliable sensor exposed by Windows'} /></div>
        <Card title="CPU usage per scan"><LineChart title="CPU usage" x={x} unit="%" min={0} max={100} digits={0} area series={[{ id: 'c', label: 'CPU', color: SERIES_COLORS.cpu, values: m.map((r) => r.cpuPct) }]} hideLegend /></Card>
        <Card title="Top CPU processes" flush><table className="t"><thead><tr><th>Process</th><th className="r">CPU</th><th className="r">RAM</th></tr></thead><tbody>{!(s.processes?.topCpu || []).length && <tr><td colSpan={9} className="small muted">Nothing was reported for this section in the last scan.</td></tr>}{(s.processes?.topCpu || []).map((p: Any) => <tr key={p.name}><td>{p.name}</td><td className="r num">{pct(p.cpuPct, 1)}</td><td className="r num">{fmtMB(p.memoryMB)}</td></tr>)}</tbody></table></Card>
      </>}
      {tab === 'ram' && <>
        <div className="grid g4"><Stat label="Used" value={sys.ram?.usedPct?.toFixed(0) ?? NA} unit="%" bar={sys.ram?.usedPct} sub={`${sys.ram?.usedGB} of ${sys.ram?.totalGB} GB`} href="/processes?tab=high" /><Stat label="Available" value={sys.ram?.freeGB ?? NA} unit=" GB" href="/processes?tab=high" /><Stat label="Pagefile" value={sys.pagefile ? Math.round(sys.pagefile.usedMB) : NA} unit=" MB used" sub={`of ${sys.pagefile?.sizeMB ?? NA} MB`} /></div>
        <Card title="RAM usage per scan"><LineChart title="RAM usage" x={x} unit="%" min={0} max={100} digits={0} area series={[{ id: 'r', label: 'RAM', color: SERIES_COLORS.ram, values: m.map((r) => r.ramPct) }]} hideLegend /></Card>
        <Card title="Top memory processes" flush><table className="t"><thead><tr><th>Process</th><th className="r">RAM</th><th className="r">CPU</th></tr></thead><tbody>{!(s.processes?.topMemory || []).length && <tr><td colSpan={9} className="small muted">Nothing was reported for this section in the last scan.</td></tr>}{(s.processes?.topMemory || []).map((p: Any) => <tr key={p.name}><td>{p.name}</td><td className="r num">{fmtMB(p.memoryMB)}</td><td className="r num">{pct(p.cpuPct, 1)}</td></tr>)}</tbody></table></Card>
      </>}
      {tab === 'disk' && <>
        <div className="grid g3">{(sys.disks || []).map((dk: Any) => <Card key={dk.drive} title={`${dk.drive} - ${dk.type} - ${dk.fs}`} actions={<Badge tone={dk.health === 'Healthy' ? 'ok' : 'warn'} dot>{dk.health || 'Unknown'}</Badge>}><div className="stack"><div className="stat" style={{ padding: 0 }}><div className="value">{dk.freeGB?.toFixed(0)}<small> GB free of {dk.totalGB?.toFixed(0)}</small></div><div className="bar"><i className={dk.freePct < 8 ? 'crit' : dk.freePct < 15 ? 'warn' : ''} style={{ width: `${dk.usedPct}%` }} /></div></div><div className="small muted">{dk.freePct?.toFixed(1)}% free</div></div></Card>)}</div>
        <Card title="Free space"><LineChart title="Free disk space" x={x} unit=" GB" area series={[{ id: 'f', label: 'Free', color: SERIES_COLORS.disk, values: m.map((r) => r.diskFreeGB) }]} hideLegend /></Card>
        <Card title="Reclaimable by safe cleanup"><KV items={[['Temp files', fmtMB(s.storage?.tempMB)], ['Crash dumps', fmtMB(s.storage?.crashDumpMB)], ['Caches', fmtMB(s.storage?.cacheMB)], ['Old installers', fmtMB(s.storage?.installersMB)]]} /></Card>
      </>}
      {tab === 'battery' && (bat?.present ? <div className="grid g3"><Stat label="Charge" value={bat.pct} unit="%" bar={bat.pct} tone={bat.pct < 20 && !bat.onAC ? 'warn' : ''} /><Stat label="Power" value={bat.onAC ? 'AC' : 'Battery'} sub={bat.charging ? 'Charging' : 'Not charging'} /><Card title="Charge per scan"><LineChart title="Battery" x={x} unit="%" min={0} max={100} digits={0} series={[{ id: 'b', label: 'Battery', color: 'var(--accent)', values: m.map((r) => r.batteryPct) }]} hideLegend height={120} /></Card></div> : <Card><Empty icon="health" title="No battery detected">This device reports no battery, or Windows did not expose one.</Empty></Card>)}
      {tab === 'windows' && (
        <div className="grid g2">
          <Card title="System"><KV items={[['Windows', `${sys.os} (${sys.build})`], ['Boot time', fmtDate(sys.bootTime)], ['Uptime', `${sys.uptimeHours} h`], ['Pending reboot', yn(!wh.pendingReboot, 'None', 'Required')]]} /></Card>
          <Card title="Windows Update"><KV items={[['Status', wh.windowsUpdate?.status], ['Pending updates', wh.windowsUpdate?.pendingCount], ['Last installed', fmtDate(wh.windowsUpdate?.lastInstalled)]]} /></Card>
          <Card title="Integrity checks"><KV items={[['SFC', `${wh.sfc?.ran ? 'Ran' : 'Not run'} - ${wh.sfc?.result || NA}`], ['DISM', `${wh.dism?.ran ? 'Ran' : 'Not run'} - ${wh.dism?.result || NA}`], ['Component store', wh.componentStore?.reclaimable ? `${wh.componentStore.reclaimable} reclaimable` : NA]]} /><p className="small muted" style={{ marginTop: 8 }}>SFC and DISM run in the weekly deep analysis, not daily.</p></Card>
          <Card title="Event log errors (24 h)"><KV items={[['System', wh.eventErrors?.system], ['Application', wh.eventErrors?.application]]} />{(wh.eventErrors?.top || []).map((e: Any) => <div key={`${e.source}${e.id}`} className="notice" style={{ marginTop: 8 }}><b>{e.source} {e.id}</b> x{e.count}<div className="small">{e.message}</div></div>)}</Card>
          <Card title="Services"><KV items={[['Running', s.services?.running], ['Stopped', s.services?.stopped], ['Failed', (s.services?.failed || []).join(', ') || 'none'], ['Auto-start but stopped', (s.services?.autoStartStopped || []).join(', ') || 'none']]} /></Card>
        </div>
      )}
      {tab === 'defender' && (
        <div className="grid g2">
          <Card title="Protection"><KV items={[['Defender', yn(def.enabled, 'Enabled', 'Disabled')], ['Real-time protection', yn(def.realTimeProtection, 'On', 'Off')], ['Signature version', def.sigVersion], ['Signature age', `${def.sigAgeDays ?? '?'} days`], ['Last quick scan', fmtDate(def.lastQuickScan)]]} /></Card>
          <Card title="Latest scan" actions={<Badge tone={def.scan?.result === 'Clean' ? 'ok' : 'warn'} dot>{def.scan?.ran ? def.scan.result : 'Not run'}</Badge>}>
            <KV items={[['Duration', def.scan?.durationSec ? `${Math.round(def.scan.durationSec / 60)} min` : NA], ['Threats', def.threats ?? 0]]} />
            {(def.scan?.threats || []).map((t: Any) => <div key={t.name} className="notice warn" style={{ marginTop: 8 }}><b>{t.name}</b> - {t.severity} - {t.status}</div>)}</Card>
          <Card title="Detections over time"><LineChart title="Threats" x={x} min={0} digits={0} series={[{ id: 't', label: 'Threats detected', color: 'var(--crit)', values: m.map((r) => r.defenderThreats) }]} hideLegend height={140} /></Card>
          <Card title="Signature age over time"><LineChart title="Signature age" x={x} unit=" d" min={0} digits={0} series={[{ id: 's', label: 'Age', color: SERIES_COLORS.ram, values: m.map((r) => r.defenderSigAgeDays) }]} hideLegend height={140} /></Card>
        </div>
      )}
      {tab === 'firewall' && <Card title="Profiles" flush><table className="t"><thead><tr><th>Profile</th><th>State</th><th>Inbound default</th><th>Outbound default</th></tr></thead><tbody>{!(fw.profiles || []).length && <tr><td colSpan={9} className="small muted">Nothing was reported for this section in the last scan.</td></tr>}{(fw.profiles || []).map((p: Any) => <tr key={p.name}><td>{p.name}</td><td>{yn(p.enabled, 'Enabled', 'Disabled')}</td><td>{p.defaultInbound}</td><td>{p.defaultOutbound}</td></tr>)}</tbody></table>{(fw.problems || []).map((p: string) => <div key={p} className="notice warn" style={{ margin: 12 }}>{p}</div>)}{!(fw.problems || []).length && <div className="small muted" style={{ padding: 12 }}>No obvious configuration problems. Guardian never changes firewall rules on its own.</div>}</Card>}
      {tab === 'network' && (
        <div className="grid g2">
          <Card title="Connectivity"><KV items={[['Internet', yn(net.internet, 'Reachable', 'Unreachable')], ['DNS', yn(net.dnsOk, 'Resolving', 'Failing')], ['Gateway', `${net.gateway || NA} ${net.gatewayOk ? '' : '(unreachable)'}`], ['Latency', net.latencyMs != null ? `${net.latencyMs} ms` : NA], ['DNS servers', (net.dnsServers || []).join(', ')]]} /></Card>
          <Card title="Adapters" flush><table className="t"><thead><tr><th>Name</th><th>Status</th><th>Speed</th><th>Type</th></tr></thead><tbody>{!(net.adapters || []).length && <tr><td colSpan={9} className="small muted">Nothing was reported for this section in the last scan.</td></tr>}{(net.adapters || []).map((a: Any) => <tr key={a.name}><td>{a.name}</td><td><Badge tone={a.status === 'Up' ? 'ok' : ''} dot>{a.status}</Badge></td><td className="num">{a.speed}</td><td>{a.type}</td></tr>)}</tbody></table></Card>
        </div>
      )}
      </Tabs>
    </div>
  );
}
