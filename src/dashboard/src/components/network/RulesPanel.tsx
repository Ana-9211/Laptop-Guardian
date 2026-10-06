import { useState } from 'react';
import type { NetFirewallRule } from '../../types';
import { Badge, Card, Col, DataTable, Empty } from '../ui';
import { ActionButton } from '../ActionFlow';
import { fmtFull } from '../../format';
import { type Flow, DurationSelect } from './shared';

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
  const portOk = /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  const ready = kind === 'program' ? !!prog : kind === 'port' ? portOk : remote.trim().length > 1;
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
              <label className="field"><span>Local port</span><input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} placeholder="e.g. 3389" aria-invalid={port !== '' && !portOk ? true : undefined} aria-describedby="port-hint" />{port !== '' && !portOk && <span id="port-hint" className="hint warn-text" role="alert">Enter a port from 1 to 65535.</span>}</label>
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
