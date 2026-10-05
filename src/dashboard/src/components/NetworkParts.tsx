import { ReactNode, useEffect, useId, useState } from 'react';
import { ApiError, api, network, useQuery } from '../api';
import type { DeepEvent, NetConnection, NetFirewallRule, NetworkCurrent } from '../types';
import { Badge, Card, Col, DataTable, Drawer, Empty, Icon, KV, Sep, useOverlay, useToast } from './ui';
import { ActionButton, useActionFlow } from './ActionFlow';
import { ago, fmtFull, NA } from '../format';

type Flow = ReturnType<typeof useActionFlow>;
export const DURATIONS = [{ id: '1h', label: '1 hour' }, { id: '24h', label: '24 hours' }, { id: '7d', label: '7 days' }, { id: 'permanent', label: 'Keep until I remove it' }];

export const addr = (a: string, p: number) => (a ? (a.includes(':') ? `[${a}]:${p}` : `${a}:${p}`) : `*:${p}`);
export const signedBadge = (p: { signed: boolean | null }) => (p.signed === true ? <Badge tone="ok" dot>Signed</Badge> : p.signed === false ? <Badge tone="warn" dot>Unsigned</Badge> : <Badge tone="outline">Unknown</Badge>);

function DurationSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <label className="row tight small">Remind me to review after <select aria-label="When to remind me to review this rule" value={value} onChange={(e) => onChange(e.target.value)}>{DURATIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></label>;
}

/** Everything about one connection or listener, with every available action and its exact scope shown before confirming. */
export function ConnectionDrawer({ conn, siblings, onClose, flow }: { conn: NetConnection; siblings: NetConnection[]; onClose: () => void; flow: Flow }) {
  const [duration, setDuration] = useState('24h');
  const p = conn.process; const listening = /listen/i.test(conn.state);
  const dests = [...new Set(siblings.filter((c) => c.pid === conn.pid && c.remoteAddress).map((c) => c.remoteAddress))];
  return (
    <Drawer title={<span className="row">{p.name}<span className="muted num small">PID {conn.pid}</span></span>} sub={<span className="row tight">{signedBadge(p)}{p.persistent && <Badge tone="info">Starts with Windows</Badge>}<Badge tone="outline">{conn.proto} {conn.state}</Badge></span>} onClose={onClose}>
      <Card title="Connection">
        <KV items={[['Local', <span key="l" className="mono-wrap">{addr(conn.localAddress, conn.localPort)}</span>], ['Remote', conn.remoteAddress ? <span key="r" className="mono-wrap">{addr(conn.remoteAddress, conn.remotePort)}</span> : 'none (listening)'], ['State', conn.state], ['Opened', conn.created ? `${ago(conn.created)} (${fmtFull(conn.created)})` : 'not reported by Windows'], ['Same program has', `${siblings.filter((c) => c.pid === conn.pid).length} connections to ${dests.length} address${dests.length === 1 ? '' : 'es'}`]]} />
      </Card>
      <Card title="Program">
        <KV items={[['Path', <span key="p" className="mono-wrap">{p.path || 'unreadable (may need elevation)'}</span>], ['Publisher', p.publisher || NA], ['Owner', p.owner || 'not available without elevation'], ['Signature', p.signed === true ? 'Valid' : p.signed === false ? 'Not signed' : 'Unknown'], ['Starts automatically', p.persistent ? 'Yes' : 'Not known to']]} />
      </Card>
      <Card title="What you can do" actions={<DurationSelect value={duration} onChange={setDuration} />}>
        <div className="stack">
          <div className="row">
            <ActionButton flow={flow} actionId="process.stop" params={{ pid: conn.pid, name: p.name.replace(/\.exe$/i, ''), ...(p.path ? { path: p.path } : {}) }} label="Stop process" tone="danger" />
            {p.path && !listening && <ActionButton flow={flow} actionId="firewall.block-program" params={{ path: p.path, direction: 'Outbound', duration }} label="Block program" tone="danger" icon="elevate" />}
            {conn.remoteAddress && !listening && <ActionButton flow={flow} actionId="firewall.block-remote" params={{ remote: conn.remoteAddress, duration }} label="Block address" icon="elevate" />}
            {listening && <ActionButton flow={flow} actionId="firewall.block-port" params={{ port: conn.localPort, protocol: conn.proto, duration }} label="Block port" tone="danger" icon="elevate" />}
            <a className="btn sm" href="#/processes"><Icon name="search" size={13} />Investigate</a>
          </div>
          <p className="small muted">Each button first shows the exact rule or action, re-checks the live target, and refuses protected Windows and security programs, DNS and DHCP ports, and your gateway or DNS servers. Blocks are Windows Firewall rules in the Laptop Guardian group that you can remove at any time.</p>
        </div>
      </Card>
    </Drawer>
  );
}

const ruleTarget = (r: NetFirewallRule) => r.program || (r.localPort && r.localPort !== 'Any' ? `${r.protocol} port ${r.localPort}` : r.remoteAddress && r.remoteAddress !== 'Any' ? r.remoteAddress : 'any');

/** Guardian-owned firewall rules plus the three guarded "create rule" forms. */
export function RulesPanel({ rules, flow, programs }: { rules: NetFirewallRule[]; flow: Flow; programs: { name: string; path: string }[] }) {
  const [duration, setDuration] = useState('24h');
  const [kind, setKind] = useState<'program' | 'port' | 'address'>('program');
  const [prog, setProg] = useState(''); const [port, setPort] = useState(''); const [proto, setProto] = useState('TCP'); const [remote, setRemote] = useState('');
  const [dir, setDir] = useState('Outbound');
  const cols: Col<NetFirewallRule>[] = [
    { key: 'name', label: 'Rule', sort: (r) => r.displayName, render: (r) => <span className="stack tight"><b>{r.displayName.replace(/^Laptop Guardian: /, '')}</b><span className="mono small muted">{r.name}</span></span> },
    { key: 'effect', label: 'Effect', render: (r) => <span className="row tight"><Badge tone={r.action === 'Block' ? 'crit' : 'ok'}>{r.action}</Badge><Badge tone="outline">{r.direction}</Badge></span> },
    { key: 'target', label: 'Applies to', render: (r) => <span className="mono-wrap small">{ruleTarget(r)}</span> },
    { key: 'state', label: 'State', render: (r) => <span className="row tight"><Badge tone={r.enabled ? 'ok' : ''} dot>{r.enabled ? 'On' : 'Off'}</Badge>{r.expired && <Badge tone="warn">Expired: review</Badge>}{!r.expired && r.expiresAt && <Badge tone="info">Until {fmtFull(r.expiresAt)}</Badge>}</span> },
    { key: 'act', label: '', render: (r) => <span className="row tight">
      <ActionButton flow={flow} actionId={r.enabled ? 'firewall.disable-rule' : 'firewall.enable-rule'} params={{ name: r.name }} label={r.enabled ? 'Disable rule' : 'Enable rule'} icon="elevate" />
      <ActionButton flow={flow} actionId="firewall.remove-rule" params={{ name: r.name }} label="Remove rule" tone="danger" icon="elevate" /></span> },
  ];
  const submit = () => {
    if (kind === 'program') void flow.run('firewall.block-program', { path: prog, direction: dir, duration }, 'Block program');
    else if (kind === 'port') void flow.run('firewall.block-port', { port, protocol: proto, duration }, 'Block port');
    else void flow.run('firewall.block-remote', { remote, duration }, 'Block address');
  };
  const ready = kind === 'program' ? !!prog : kind === 'port' ? /^\d{1,5}$/.test(port) : remote.trim().length > 1;
  return (
    <div className="stack-lg">
      <Card title="Laptop Guardian firewall rules" flush actions={<Badge tone="outline">{rules.length} rule{rules.length === 1 ? '' : 's'}</Badge>}>
        <DataTable<NetFirewallRule> label="Guardian firewall rules" cols={cols} rows={rules} rowKey={(r) => r.name}
          empty={<Empty icon="shield" title="No Guardian rules">Rules you create here live in their own Windows Firewall group. Guardian never touches your other firewall rules.</Empty>} />
      </Card>
      <Card title="Create a rule">
        <div className="stack">
          <p className="small muted">Guardian only creates rules in the Laptop Guardian group. You review the exact rule and its consequences, then confirm; Windows asks for administrator permission.</p>
          <div className="seg" role="group" aria-label="Rule type">{(['program', 'port', 'address'] as const).map((k) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{k === 'program' ? 'Block a program' : k === 'port' ? 'Block an inbound port' : 'Block an address'}</button>)}</div>
          <div className="row">
            {kind === 'program' && <>
              <label className="field"><span>Program</span><select value={prog} onChange={(e) => setProg(e.target.value)}><option value="">Choose a running program</option>{programs.map((p) => <option key={p.path} value={p.path}>{p.name} - {p.path}</option>)}</select></label>
              <label className="field"><span>Direction</span><select value={dir} onChange={(e) => setDir(e.target.value)}><option>Outbound</option><option>Inbound</option></select></label></>}
            {kind === 'port' && <>
              <label className="field"><span>Local port</span><input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} placeholder="e.g. 3389" /></label>
              <label className="field"><span>Protocol</span><select value={proto} onChange={(e) => setProto(e.target.value)}><option>TCP</option><option>UDP</option></select></label></>}
            {kind === 'address' && <label className="field grow"><span>IP address or range (CIDR)</span><input value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="203.0.113.7 or 198.51.100.0/24" /></label>}
            <DurationSelect value={duration} onChange={setDuration} />
            <button className="btn primary" disabled={!ready} onClick={submit}>Review rule</button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** DNS cache, history, the opt-in filtering policy, and the one-click flush. */
export function DnsPanel({ current, flow, reload }: { current: NetworkCurrent; flow: Flow; reload: () => void }) {
  const toast = useToast(); const [domain, setDomain] = useState(''); const [busy, setBusy] = useState(false); const [showAck, setShowAck] = useState(false);
  const f = current.dns.filtering;
  const toggle = async (enabled: boolean) => { setBusy(true); try { await network.dnsFiltering(enabled); toast('ok', enabled ? 'DNS filtering is on.' : 'DNS filtering is off.'); reload(); } catch (e) { toast('error', (e as ApiError).message); } finally { setBusy(false); setShowAck(false); } };
  const cache: Col<NetworkCurrent['dns']['cache'][number]>[] = [
    { key: 'name', label: 'Name', sort: (r) => r.name, render: (r) => <span className="mono-wrap">{r.name}</span> },
    { key: 'type', label: 'Type', render: (r) => r.type }, { key: 'data', label: 'Answer', render: (r) => <span className="mono-wrap">{r.data}</span> },
    { key: 'ttl', label: 'TTL', align: 'r', render: (r) => <span className="num">{r.ttl}s</span> },
  ];
  const hist: Col<NetworkCurrent['dns']['history'][number]>[] = [
    { key: 'ts', label: 'First seen', sort: (r) => r.ts, render: (r) => <span className="small nowrap">{fmtFull(r.ts)}</span> },
    { key: 'name', label: 'Name', render: (r) => <span className="mono-wrap">{r.name}</span> }, { key: 'data', label: 'Answer', render: (r) => <span className="mono-wrap">{r.data}</span> },
  ];
  return (
    <div className="stack-lg">
      <Card title="DNS cache" flush actions={<ActionButton flow={flow} actionId="dns.flush" params={{}} label="Flush DNS cache" icon="elevate" />}>
        <DataTable<NetworkCurrent['dns']['cache'][number]> label="DNS cache" cols={cache} rows={current.dns.cache} rowKey={(r) => `${r.name}|${r.data}`} empty={<Empty icon="info" title="The DNS cache is empty">Names appear here after programs look them up.</Empty>} />
      </Card>
      <Card title="DNS filtering (optional)" actions={<Badge tone={f.enabled ? 'warn' : ''} dot>{f.enabled ? 'On' : 'Off'}</Badge>}>
        <div className="stack">
          <p className="t2">Guardian can block exact host names by adding them to a clearly marked <b>Laptop Guardian section of the Windows hosts file</b>. It does not install a DNS proxy and never changes your DNS servers. Wildcards are not supported, programs that use their own encrypted DNS (DoH) can bypass it, and every change needs administrator permission and can be rolled back in one click.</p>
          {!f.enabled ? (showAck
            ? <div className="notice warn"><b>Turn on DNS filtering?</b> Blocks only affect this laptop and only exact names. You can roll back every block at any time.<div className="row" style={{ marginTop: 8 }}><button className="btn primary sm" disabled={busy} onClick={() => void toggle(true)}>I understand, turn it on</button><button className="btn sm" onClick={() => setShowAck(false)}>Cancel</button></div></div>
            : <button className="btn" style={{ justifySelf: 'start' }} onClick={() => setShowAck(true)}>Turn on DNS filtering</button>)
            : <>
              <div className="row"><label className="field grow"><span>Block a host name</span><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="tracker.example.net" /></label><button className="btn primary" disabled={domain.trim().length < 4} onClick={() => void flow.run('dns.block-domain', { domain: domain.trim().toLowerCase() }, 'Block domain')}>Review block</button></div>
              <div><div className="eyebrow">Active blocks ({f.blocked.length})</div>
                {f.blocked.length === 0 ? <p className="small muted">No blocks.</p> : <ul className="plain-list">{f.blocked.map((d) => <li key={d} className="row spread"><span className="mono-wrap">{d}</span><ActionButton flow={flow} actionId="dns.unblock-domain" params={{ domain: d }} label="Unblock domain" icon="elevate" /></li>)}</ul>}</div>
              <div className="row">{f.blocked.length > 0 && <ActionButton flow={flow} actionId="dns.rollback" params={{}} label="Roll back all DNS blocks" tone="danger" icon="elevate" />}<button className="btn" disabled={busy || f.blocked.length > 0} onClick={() => void toggle(false)} title={f.blocked.length ? 'Roll back the blocks first' : undefined}>Turn off DNS filtering</button></div></>}
        </div>
      </Card>
      <Card title="DNS names seen over time" flush>
        <DataTable<NetworkCurrent['dns']['history'][number]> label="DNS history" cols={hist} rows={current.dns.history} rowKey={(r) => `${r.ts}|${r.name}|${r.data}`} initialSort={{ key: 'ts', dir: -1 }} empty={<Empty icon="info" title="No history yet">Each snapshot remembers new names from the Windows DNS cache.</Empty>} />
      </Card>
    </div>
  );
}
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
  useEffect(() => { if (!d.active) return; const t = setInterval(() => events.reload(), 5000); return () => clearInterval(t); }, [d.active, events]);
  const [showLog, setShowLog] = useState(false);
  const dnsLog = useQuery<{ available: boolean; enabled: boolean | null; reason: string | null; items: { ts: string; name: string; type: string; results: string; pid: number }[] }>(showLog ? '/api/network/dns-log' : null);
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
            <a className="btn" href="/api/network/deep/export?format=csv" download>Export CSV</a>
            <a className="btn" href="/api/network/deep/export?format=jsonl" download>Export JSON lines</a>
            <button className="btn danger" disabled={busy || d.files === 0} onClick={() => void run(() => network.deepDelete(), 'Recorded network data deleted.')}>Delete recorded data</button>
          </div>
        </div>
      </Card>
      <Card title="DNS lookups by program (optional)">
        <div className="stack">
          <p className="t2">Windows can log which program asked for which name. That log is off by default. Turning it on needs administrator permission and records names only.</p>
          <div className="row"><ActionButton flow={flow} actionId="deep.dnslog-enable" params={{}} label="Turn on DNS history log" icon="elevate" /><ActionButton flow={flow} actionId="deep.dnslog-disable" params={{}} label="Turn off DNS history log" icon="elevate" /><button className="btn sm" onClick={() => { setShowLog(true); dnsLog.reload(); }}>Show recent lookups</button></div>
          {dnsLog.data && (dnsLog.data.available ? <p className="small muted">{dnsLog.data.items.length} recent lookups.</p> : <div className="notice small">{dnsLog.data.reason}</div>)}
        </div>
      </Card>
      {d.active && <Card title="Latest connection events" flush>{events.data ? <DataTable<DeepEvent> label="Deep events" cols={evCols} rows={events.data.items} rowKey={(e) => `${e.ts}|${e.type}|${e.localPort}|${e.remoteAddress}|${e.remotePort}|${e.pid}`} empty={<Empty icon="activity" title="Waiting for the first sample" />} /> : <div className="pad small muted">Loading...</div>}</Card>}
      {ack && <AckDialog busy={busy} onClose={() => setAck(false)} onStart={() => void run(() => network.deepStart(), 'Deep Network Guard started.')} />}
    </div>
  );
}

export function SectionNote({ children }: { children: ReactNode }) { return <p className="small muted">{children}</p>; }
