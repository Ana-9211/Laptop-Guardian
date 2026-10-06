import { useState } from 'react';
import type { NetConnection } from '../../types';
import { Badge, Card, Drawer, Icon, KV } from '../ui';
import { ActionButton } from '../ActionFlow';
import { ago, fmtFull, NA } from '../../format';
import { type Flow, addr, signedBadge, DurationSelect } from './shared';

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
      <Card title="What you can do">
        <div className="stack">
          <div className="row">
            <ActionButton flow={flow} actionId="process.stop" params={{ pid: conn.pid, name: p.name.replace(/\.exe$/i, ''), ...(p.path ? { path: p.path } : {}), ...(p.startTime ? { startTime: p.startTime } : {}) }} label="Stop process" tone="danger" />
            {p.path && !listening && <ActionButton flow={flow} actionId="firewall.block-program" params={{ path: p.path, direction: 'Outbound', duration }} label="Block program" tone="danger" icon="elevate" />}
            {conn.remoteAddress && !listening && <ActionButton flow={flow} actionId="firewall.block-remote" params={{ remote: conn.remoteAddress, duration }} label="Block address" icon="elevate" />}
            {listening && <ActionButton flow={flow} actionId="firewall.block-port" params={{ port: conn.localPort, protocol: conn.proto, duration }} label="Block port" tone="danger" icon="elevate" />}
            <a className="btn sm" href={`#/processes?name=${encodeURIComponent(p.name)}`}><Icon name="search" size={13} />Investigate</a>
          </div>
          {(p.path || conn.remoteAddress || listening) && <DurationSelect value={duration} onChange={setDuration} />}
          <p className="small muted">Each button first shows the exact rule or action, re-checks the live target, and refuses protected Windows and security programs, DNS and DHCP ports, and your gateway or DNS servers. Blocks are Windows Firewall rules in the Laptop Guardian group that you can remove at any time.</p>
        </div>
      </Card>
    </Drawer>
  );
}
