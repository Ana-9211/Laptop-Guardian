import { useEffect, useId, useState } from 'react';
import { ApiError, api, network, useQuery } from '../../api';
import type { DeepEvent, NetworkCurrent } from '../../types';
import { Badge, Card, Col, DataTable, DownloadButton, Empty, ErrorState, Sep, useConfirm, useOverlay, useToast } from '../ui';
import { ActionButton } from '../ActionFlow';
import { fmtFull } from '../../format';
import { type Flow, addr, type DnsLookup } from './shared';

function AckDialog({ onClose, onStart, busy }: { onClose: () => void; onStart: () => void; busy: boolean }) {
  const ref = useOverlay(onClose); const tid = useId(); const [ok, setOk] = useState(false);
  return (
    <>
      <div className="scrim" style={{ zIndex: 65 }} onClick={onClose} />
      <div className="dialog wide" role="alertdialog" aria-modal="true" aria-labelledby={tid} ref={ref} tabIndex={-1}>
        <div className="card-body">
          <h2 id={tid}>Start Deep Network Guard?</h2>
          <div className="notice warn"><b>This records private information.</b> While it runs, Guardian samples your connection table every few seconds and saves when each connection opens and closes: addresses, ports, the program, and timing. It does <b>not</b> capture packets or their contents.</div>
          <ul className="plain-list"><li>Everything stays on this laptop in <code>data/network</code>. It is never sent to Gemini or anywhere else.</li><li>You choose how long it is kept and a size cap; the oldest data is deleted first.</li><li>A banner is shown on every page while it runs. You can stop, export or delete the data at any time.</li><li>It is off by default and only starts after this confirmation.</li></ul>
          <label className="ack"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /><span>I understand what is recorded and where it is kept.</span></label>
        </div>
        <div className="dialog-foot"><button className="btn" onClick={onClose} data-autofocus>Cancel</button><button className="btn primary" disabled={!ok || busy} onClick={onStart}>{busy ? 'Starting...' : 'Start Deep Network Guard'}</button></div>
      </div>
    </>
  );
}

/** Deep Network Guard: explicit opt-in, retention and size controls, live events, export and delete. */
export function DeepPanel({ current, flow, reload }: { current: NetworkCurrent; flow: Flow; reload: () => void }) {
  const toast = useToast(); const d = current.deep; const s = current.settings.deep;
  const [ack, setAck] = useState(false); const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(s.retentionDays); const [mb, setMb] = useState(s.maxMB); const [sec, setSec] = useState(s.sampleSec);
  const events = useQuery<{ items: DeepEvent[] }>(d.active ? '/api/network/deep/events?limit=100' : null);
  const reloadEvents = events.reload;
  useEffect(() => { if (!d.active) return; const t = setInterval(reloadEvents, 5000); return () => clearInterval(t); }, [d.active, reloadEvents]);
  const { confirm: ask, node: confirmNode } = useConfirm();
  const [showLog, setShowLog] = useState(false);
  const dnsLog = useQuery<{ available: boolean; enabled: boolean | null; reason: string | null; items: DnsLookup[] }>(showLog ? '/api/network/dns-log' : null);
  const logOn = dnsLog.data ? dnsLog.data.enabled : null;
  const lookupCols: Col<DnsLookup>[] = [
    { key: 'ts', label: 'Time', sort: (r) => r.ts, render: (r) => <span className="small nowrap">{fmtFull(r.ts)}</span> },
    { key: 'name', label: 'Name', sort: (r) => r.name, render: (r) => <span className="mono-wrap">{r.name}</span> },
    { key: 'type', label: 'Type', render: (r) => r.type },
    { key: 'results', label: 'Answer', render: (r) => <span className="mono-wrap small">{r.results}</span> },
    { key: 'pid', label: 'Program (PID)', align: 'r', render: (r) => <span className="num">{r.pid}</span> },
  ];
  const run = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); toast('ok', ok); reload(); events.reload(); } catch (e) { toast('error', (e as ApiError).message); } finally { setBusy(false); setAck(false); } };
  const save = () => run(() => api.put('/api/config', { network: { deep: { retentionDays: days, maxMB: mb, sampleSec: sec } } }), 'Deep mode settings saved.');
  const evCols: Col<DeepEvent>[] = [
    { key: 'ts', label: 'Time', sort: (e) => e.ts, render: (e) => <span className="small nowrap">{fmtFull(e.ts)}</span> },
    { key: 'type', label: 'Event', render: (e) => <Badge tone={e.type === 'open' ? 'info' : ''}>{e.type}</Badge> },
    { key: 'proc', label: 'Program', render: (e) => `${e.process || 'pid'} (${e.pid})` },
    { key: 'conn', label: 'Connection', render: (e) => <span className="mono-wrap small">{e.proto} {addr(e.localAddress, e.localPort)}{e.remoteAddress ? ` -> ${addr(e.remoteAddress, e.remotePort)}` : ''}</span> },
    { key: 'dur', label: 'Lasted', align: 'r', render: (e) => (e.durationSec != null ? <span className="num">{e.durationSec}s</span> : '') },
  ];
  return (
    <div className="stack-lg">
      <Card title="Deep Network Guard" actions={<Badge tone={d.active ? 'warn' : ''} dot>{d.active ? 'Recording' : 'Off'}</Badge>}>
        <div className="stack">
          <p className="t2">An explicit, opt-in mode that records when each network connection opens and closes, so you can see connection age, history and bursts. {current.privacy}</p>
          <div className="notice"><b>Not recorded:</b> packet contents, web addresses, headers, passwords or files. Deep mode samples the Windows connection table; it is not a packet capture.</div>
          {d.active
            ? <div className="row"><button className="btn danger" disabled={busy} onClick={() => void run(() => network.deepStop(), 'Deep Network Guard stopped.')}>Stop recording</button><span className="small muted">Running since {d.startedAt ? fmtFull(d.startedAt) : 'now'}<Sep />{d.eventsThisSession} events this session</span></div>
            : <button className="btn primary" style={{ justifySelf: 'start' }} onClick={() => setAck(true)}>Start Deep Network Guard</button>}
        </div>
      </Card>
      <Card title="Storage and retention" actions={<Badge tone="outline">{d.storageMB} MB used of {d.maxMB} MB</Badge>}>
        <div className="stack">
          <div className="bar" aria-hidden="true"><i className={d.storageMB > d.maxMB * 0.8 ? 'warn' : ''} style={{ width: `${Math.min(100, (d.storageMB / Math.max(1, d.maxMB)) * 100)}%` }} /></div>
          <div className="row">
            <label className="field"><span>Keep for (days)</span><input type="number" min={1} max={90} value={days} onChange={(e) => setDays(+e.target.value)} /></label>
            <label className="field"><span>Size cap (MB)</span><input type="number" min={5} max={2000} value={mb} onChange={(e) => setMb(+e.target.value)} /></label>
            <label className="field"><span>Sample every (s)</span><input type="number" min={2} max={60} value={sec} onChange={(e) => setSec(+e.target.value)} /></label>
            <button className="btn" disabled={busy || (days === s.retentionDays && mb === s.maxMB && sec === s.sampleSec)} onClick={() => void save()}>Save</button>
          </div>
          <div className="row">
            <DownloadButton path="/api/network/deep/export" method="POST" body={{ format: 'csv' }} name="laptop-guardian-network-events.csv">Export CSV</DownloadButton>
            <DownloadButton path="/api/network/deep/export" method="POST" body={{ format: 'jsonl' }} name="laptop-guardian-network-events.jsonl">Export JSON lines</DownloadButton>
            <button className="btn danger" disabled={busy || d.files === 0} onClick={() => ask({ title: 'Delete the recorded network data?', confirmLabel: 'Delete recorded data', danger: true, body: `${d.files} day file${d.files === 1 ? '' : 's'} (${d.storageMB} MB) of connection history will be deleted from this laptop. This cannot be undone.`, onConfirm: () => run(() => network.deepDelete(), 'Recorded network data deleted.') })}>Delete recorded data</button>
          </div>
        </div>
      </Card>
      <Card title="DNS lookups by program (optional)">
        <div className="stack">
          <p className="t2">Windows can log which program asked for which name. That log is off by default. Turning it on needs administrator permission and records names only.</p>
          <div className="row">
            {logOn !== true && <ActionButton flow={flow} actionId="deep.dnslog-enable" params={{}} label="Turn on DNS history log" icon="elevate" />}
            {logOn !== false && <ActionButton flow={flow} actionId="deep.dnslog-disable" params={{}} label="Turn off DNS history log" icon="elevate" />}
            <button className="btn sm" onClick={() => { setShowLog(true); dnsLog.reload(); }}>{dnsLog.data ? 'Refresh lookups' : 'Show recent lookups'}</button>
            {logOn != null && <Badge tone={logOn ? 'warn' : ''} dot>DNS history log is {logOn ? 'on' : 'off'}</Badge>}
          </div>
          {dnsLog.error && <ErrorState error={dnsLog.error} onRetry={dnsLog.reload} />}
          {dnsLog.data && !dnsLog.data.available && <div className="notice small">{dnsLog.data.reason}</div>}
          {dnsLog.data && dnsLog.data.available && <DataTable<DnsLookup> label="Recent DNS lookups" cols={lookupCols} rows={dnsLog.data.items} rowKey={(r) => `${r.ts}|${r.name}|${r.pid}`} initialSort={{ key: 'ts', dir: -1 }} empty={<Empty icon="info" title="No lookups recorded yet">Lookups appear after the log has been on for a while.</Empty>} />}
        </div>
      </Card>
      {d.active && <Card title="Latest connection events" flush>{events.data ? <DataTable<DeepEvent> label="Deep events" cols={evCols} rows={events.data.items} rowKey={(e) => `${e.ts}|${e.type}|${e.localPort}|${e.remoteAddress}|${e.remotePort}|${e.pid}`} empty={<Empty icon="activity" title="Waiting for the first sample" />} /> : <div className="pad small muted">Loading...</div>}</Card>}
      {confirmNode}
      {ack && <AckDialog busy={busy} onClose={() => setAck(false)} onStart={() => void run(() => network.deepStart(), 'Deep Network Guard started.')} />}
    </div>
  );
}
