import type { Any, Report } from '../types';
import { Badge, Card, Expander, KV } from './ui';
import { ScoreRing } from './Chart';
import { ActionTimeline } from './common';
import { fmtDate, fmtFull, fmtMB, scoreTone } from '../format';

const STATUS_TONE: Record<string, string> = { complete: 'ok', partial: 'warn', failed: 'crit', timeout: 'crit', skipped: '', incomplete: 'warn' };

export function ReportView({ r }: { r: Report }) {
  const s: Any = r.sections || {};
  const w: Any = r.weekly;
  return (
    <div className="stack-lg">
      <Card>
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          <ScoreRing score={r.healthScore} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="row tight"><h2 style={{ fontSize: 17 }}>{r.summary?.headline || `${r.type} report`}</h2><Badge tone={STATUS_TONE[r.status]} dot>{r.status}</Badge><Badge tone={scoreTone(r.healthScore)}>Score {r.healthScore ?? '—'}</Badge></div>
            <div className="small muted">{r.type === 'weekly' ? `Week ${r.id}` : r.id} · generated {fmtFull(r.generatedAt)} · took {r.durationSec != null ? (r.durationSec > 120 ? `${Math.round(r.durationSec / 60)} min` : `${r.durationSec} s`) : '—'} · {r.host?.name}</div>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>{(r.summary?.bullets || []).map((b) => <li key={b}>{b}</li>)}</ul>
            {(r.incomplete || []).map((i) => <div key={i} className="notice warn" style={{ marginTop: 8 }}>Incomplete: {i}</div>)}
          </div>
        </div>
      </Card>

      {r.ai?.briefing && <Card title="AI briefing"><p className="t2" style={{ maxWidth: '72ch' }}>{r.ai.briefing}</p></Card>}
      {r.ai?.patterns && r.ai.patterns.length > 0 && <Card title="Patterns found" flush>{r.ai.patterns.map((p) => <Expander key={p.title} head={<b>{p.title}</b>}><p className="t2">{p.detail}</p>{(p.evidence || []).map((e) => <div key={e} className="mono-block">{e}</div>)}</Expander>)}</Card>}

      {w?.phases && <Card title="Weekly phases" flush><table className="t"><thead><tr><th>Phase</th><th>Status</th><th>Started</th><th>Finished</th><th>Detail</th></tr></thead><tbody>{w.phases.map((p: Any) => <tr key={p.name}><td><b>{p.name}</b></td><td><Badge tone={STATUS_TONE[p.status]} dot>{p.status}</Badge></td><td className="small">{fmtDate(p.startedAt)}</td><td className="small">{fmtDate(p.finishedAt)}</td><td className="t2">{p.detail}</td></tr>)}</tbody></table>
        {w.shutdown && <div className="small muted" style={{ padding: 12 }}>Shutdown: {w.shutdown.planned ? 'planned' : 'not planned'} · {w.shutdown.initiated ? 'initiated' : 'not initiated'} · {w.shutdown.reason}</div>}</Card>}
      {w?.recurring?.length > 0 && <Card title="Recurring problems">{w.recurring.map((x: Any) => <div key={x.title} className="row spread"><span><b>{x.title}</b> <span className="muted">{x.detail}</span></span><Badge tone="warn">{x.days} days</Badge></div>)}</Card>}

      <Card title="Details" flush>
        {s.system && <Expander defaultOpen head={<b>System</b>}><KV items={[['OS', `${s.system.os} (${s.system.build})`], ['Uptime', `${s.system.uptimeHours} h`], ['CPU', `${s.system.cpu?.name} · ${s.system.cpu?.usagePct}%`], ['RAM', `${s.system.ram?.usedGB} / ${s.system.ram?.totalGB} GB (${s.system.ram?.usedPct}%)`], ['Pagefile', `${s.system.pagefile?.usedMB} / ${s.system.pagefile?.sizeMB} MB`], ...(s.system.disks || []).map((d: Any): [string, string] => [`Disk ${d.drive}`, `${d.freeGB} GB free of ${d.totalGB} GB · ${d.type} · ${d.health || 'health unknown'}`]), ['Battery', s.system.battery?.present ? `${s.system.battery.pct}%${s.system.battery.onAC ? ' on AC' : ''}` : 'none']]} /></Expander>}
        {s.storage && <Expander head={<b>Storage</b>}><KV items={[['Temp', fmtMB(s.storage.tempMB)], ['Crash dumps', fmtMB(s.storage.crashDumpMB)], ['Caches', fmtMB(s.storage.cacheMB)], ['Installers', fmtMB(s.storage.installersMB)], ['Downloads', `${s.storage.downloads?.count} files · ${s.storage.downloads?.sizeGB} GB`], ['Duplicate candidates', s.storage.duplicateCandidates]]} /></Expander>}
        {s.processes && <Expander head={<b>Processes</b>}><KV items={[['Total', s.processes.total], ['Flagged', s.processes.flagged], ['Persistent', s.processes.persistent], ['High resource', s.processes.highResource]]} /></Expander>}
        {s.services && <Expander head={<b>Services</b>}><KV items={[['Running / stopped', `${s.services.running} / ${s.services.stopped}`], ['Failed', (s.services.failed || []).join(', ') || 'none'], ['Third-party', (s.services.thirdParty || []).map((x: Any) => x.display || x.name).join(', ') || 'none']]} /></Expander>}
        {s.startup && <Expander head={<b>Startup ({s.startup.count})</b>}>{(s.startup.items || []).map((i: Any, k: number) => <div key={k} className="row small"><Badge>{i.kind}</Badge><b>{i.name}</b><span className="muted trunc">{i.location}</span></div>)}</Expander>}
        {s.defender && <Expander head={<b>Defender</b>}><KV items={[['Enabled', String(s.defender.enabled)], ['Real-time', String(s.defender.realTimeProtection)], ['Signatures', `${s.defender.sigVersion} (${s.defender.sigAgeDays} d)`], ['Scan', s.defender.scan?.ran ? `${s.defender.scan.result} in ${Math.round((s.defender.scan.durationSec || 0) / 60)} min` : 'not run'], ['Threats', s.defender.threats]]} /></Expander>}
        {s.firewall && <Expander head={<b>Firewall</b>}><KV items={[...(s.firewall.profiles || []).map((p: Any): [string, string] => [p.name, p.enabled ? 'Enabled' : 'Disabled']), ['Problems', (s.firewall.problems || []).join('; ') || 'none']]} /></Expander>}
        {s.windowsHealth && <Expander head={<b>Windows health</b>}><KV items={[['Pending reboot', String(s.windowsHealth.pendingReboot)], ['Updates', `${s.windowsHealth.windowsUpdate?.pendingCount} pending · ${s.windowsHealth.windowsUpdate?.status}`], ['Event errors', `${s.windowsHealth.eventErrors?.system} system · ${s.windowsHealth.eventErrors?.application} application`], ['SFC', `${s.windowsHealth.sfc?.result}`], ['DISM', `${s.windowsHealth.dism?.result}`]]} /></Expander>}
        {s.network && <Expander head={<b>Network</b>}><KV items={[['Internet', String(s.network.internet)], ['DNS', String(s.network.dnsOk)], ['Gateway', s.network.gateway], ['Latency', s.network.latencyMs != null ? `${s.network.latencyMs} ms` : '—']]} /></Expander>}
        {s.cleanup && <Expander head={<b>Cleanup</b>}><div className="small muted">{s.cleanup.safeMode ? 'Safe mode was on: nothing was deleted.' : `${fmtMB(s.cleanup.totalFreedMB)} freed.`}</div>{(s.cleanup.items || []).map((i: Any, k: number) => <div key={k} className="row small"><Badge tone={i.result === 'success' ? 'ok' : 'warn'}>{i.kind}</Badge><span className="path">{i.path}</span><span className="num">{fmtMB(i.freedMB)}</span></div>)}</Expander>}
        {s.diskHealth && <Expander head={<b>Disk health</b>}>{s.diskHealth.map((d: Any) => <div key={d.drive} className="small"><b>{d.drive}</b> {d.model} · {d.mediaType} · {d.health}{d.wearPct != null ? ` · wear ${d.wearPct}%` : ''}</div>)}</Expander>}
      </Card>

      {(r.errors || []).length > 0 && <Card title="Errors" flush>{r.errors!.map((e, i) => <Expander key={i} head={<><Badge tone="crit">{e.source}</Badge><span className="trunc">{e.message}</span></>}><div className="mono-block">{e.message}</div></Expander>)}</Card>}
      {(r.actions || []).length > 0 && <Card title="Actions in this run"><ActionTimeline rows={r.actions!} max={20} /></Card>}
      <div className="small muted">{(r.recommendations || []).length} recommendations were open during this run.</div>
    </div>
  );
}
