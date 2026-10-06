import { useState } from 'react';
import { ApiError, network } from '../../api';
import type { NetworkCurrent } from '../../types';
import { Badge, Card, Col, DataTable, Empty, useToast } from '../ui';
import { ActionButton } from '../ActionFlow';
import { fmtFull } from '../../format';
import { type Flow } from './shared';

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
