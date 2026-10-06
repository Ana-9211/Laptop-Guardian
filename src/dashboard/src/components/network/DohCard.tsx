import type { NetworkCurrent } from '../../types';
import { Badge, Card } from '../ui';
import { ActionButton } from '../ActionFlow';
import type { Flow } from './shared';

const PROVIDERS: { id: string; label: string }[] = [{ id: 'cloudflare', label: 'Cloudflare' }, { id: 'google', label: 'Google' }, { id: 'quad9', label: 'Quad9' }];

/** DNS servers per network interface and the encrypted-DNS (DoH) buttons. Every change is a confirmed, undoable action. */
export function DohCard({ current, flow }: { current: NetworkCurrent; flow: Flow }) {
  const cfg = current.snapshot?.dnsConfig;
  const registered = new Set((cfg?.doh || []).map((d) => d.server));
  return (
    <Card title="DNS servers and encrypted DNS (DoH)">
      {!cfg || cfg.interfaces.length === 0 ? <p className="small muted">Take a network snapshot (Overview) to see which DNS servers each connection uses.</p> : (
        <div className="stack">
          {cfg.interfaces.map((i) => (
            <div key={i.index} className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span><b>{i.alias}</b> <span className="small t2">{i.dnsServers.length ? i.dnsServers.join(', ') : 'automatic'}</span> {i.dnsServers.length > 0 && i.dnsServers.every((s) => registered.has(s)) && <Badge tone="ok" dot>Encrypted</Badge>}</span>
              <span className="row tight">
                {PROVIDERS.map((p) => <ActionButton key={p.id} actionId="dns.doh-enable" params={{ provider: p.id, interfaceIndex: String(i.index) }} label={`Use ${p.label}`} flow={flow} />)}
                <ActionButton actionId="dns.doh-restore" params={{ interfaceIndex: String(i.index) }} label="Restore previous" flow={flow} />
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="small muted" style={{ marginTop: 10 }}>DoH hides your lookups from your network and gives them to the provider you pick. Hosts-file blocking in Guardian only works for lookups that go through Windows: <b>a program that uses its own DoH (many browsers can) bypasses it</b>. Needs administrator permission; Restore puts back exactly what was there.</p>
    </Card>
  );
}
