import { Badge } from '../ui';
import { useActionFlow } from '../ActionFlow';


export type Flow = ReturnType<typeof useActionFlow>;
export interface DnsLookup { ts: string; name: string; type: string; results: string; pid: number }
export const DURATIONS = [{ id: '1h', label: '1 hour' }, { id: '24h', label: '24 hours' }, { id: '7d', label: '7 days' }, { id: 'permanent', label: 'Keep until I remove it' }];

export const addr = (a: string, p: number) => (a ? (a.includes(':') ? `[${a}]:${p}` : `${a}:${p}`) : `*:${p}`);
export const signedBadge = (p: { signed: boolean | null }) => (p.signed === true ? <Badge tone="ok" dot>Signed</Badge> : p.signed === false ? <Badge tone="warn" dot>Unsigned</Badge> : <Badge tone="outline">Unknown</Badge>);

export function DurationSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <label className="row tight small">Remind me to review after <select aria-label="When to remind me to review this rule" value={value} onChange={(e) => onChange(e.target.value)}>{DURATIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></label>;
}

/** Everything about one connection or listener, with every available action and its exact scope shown before confirming. */
