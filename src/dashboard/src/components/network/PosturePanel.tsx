import { useQuery } from '../../api';
import type { NetworkCurrent } from '../../types';
import { Badge, Card, DataTable, DownloadButton, ErrorState, KV } from '../ui';
import { ActionButton } from '../ActionFlow';
import type { Flow } from './shared';
import { fmtFull } from '../../format';

interface FwEvent { ts: string; eventId: number; result: string; direction: string; protocol: string; pid: number; application: string; remoteAddress: string; remotePort: number; localPort: number }
interface FwLog { available: boolean; reason: string | null; items: FwEvent[] }

/** Posture score with every deduction, and the Windows Filtering Platform log (allowed and blocked connections) with its on/off buttons. */
export function PosturePanel({ current, flow }: { current: NetworkCurrent; flow: Flow }) {
  const log = useQuery<FwLog>('/api/network/fw-events?hours=24');
  const p = current.posture;
  return (
    <>
      {p && (
        <Card title="Firewall posture" actions={<Badge tone={p.score >= 85 ? 'ok' : p.score >= 65 ? 'warn' : 'crit'}>{p.score} / 100</Badge>}>
          <KV items={p.reasons.map((r, i): [string, React.ReactNode] => [`${r.points === 0 ? 'OK' : r.points}`, <span key={i}>{r.reason}</span>])} />
          <p className="small muted">Windows Firewall does the blocking. Guardian audits it, explains what it finds and only ever changes rules it created itself.</p>
        </Card>
      )}
      <Card title="Connection log (Windows Filtering Platform)" actions={<span className="row tight">
        <ActionButton actionId="setup.enable-firewall-audit" params={{}} label="Turn on connection logging" flow={flow} />
        <ActionButton actionId="setup.disable-firewall-audit" params={{}} label="Turn it off" flow={flow} />
        <DownloadButton path="/api/network/fw-events/export" method="POST" body={{ hours: 24 }} name="laptop-guardian-firewall-log.csv" className="btn sm">Export CSV</DownloadButton></span>}>
        {log.error ? <ErrorState error={log.error} onRetry={log.reload} /> : !log.data ? <p className="small muted">Reading the Security log...</p>
          : !log.data.available ? <div className="notice warn">{log.data.reason} Turning logging on also needs administrator permission; Windows asks first. The log uses disk space and records addresses, ports and programs, never packet contents.</div>
          : log.data.items.length === 0 ? <p className="small muted">{log.data.reason || 'No events in the last 24 hours.'}</p>
          : <DataTable<FwEvent> label="Firewall events" rows={log.data.items} rowKey={(e) => `${e.ts}|${e.pid}|${e.remoteAddress}|${e.remotePort}|${e.eventId}`} initialSort={{ key: 'ts', dir: -1 }} cols={[
            { key: 'ts', label: 'Time', render: (e) => fmtFull(e.ts), sort: (e) => e.ts },
            { key: 'result', label: 'Result', render: (e) => <Badge tone={e.result === 'allowed' || e.result === 'bind-allowed' ? 'ok' : 'warn'}>{e.result}</Badge>, sort: (e) => e.result },
            { key: 'dir', label: 'Direction', render: (e) => e.direction || '-', sort: (e) => e.direction },
            { key: 'proto', label: 'Protocol', render: (e) => e.protocol, sort: (e) => e.protocol },
            { key: 'remote', label: 'Remote', render: (e) => `${e.remoteAddress}:${e.remotePort}`, sort: (e) => e.remoteAddress },
            { key: 'app', label: 'Program', render: (e) => <span className="mono small">{e.application || `pid ${e.pid}`}</span>, sort: (e) => e.application },
          ]} />}
      </Card>
    </>
  );
}
