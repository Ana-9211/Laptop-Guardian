import { useFindings } from '../state/findings';
import { ActionOfferCard } from './FindingActions';
import type { useActionFlow } from './ActionFlow';

/** The fixes Guardian offers for one recommendation (everything except the plain stop, which has its own button). */
export function RecFixes({ recId, flow }: { recId: string; flow: ReturnType<typeof useActionFlow> }) {
  const q = useFindings();
  if (q.error) return <p className="small muted">Fix options are unavailable: {q.error.message}</p>;
  if (!q.data) return <p className="small muted">Checking what can be fixed...</p>;
  const f = q.data.findings.find((x) => x.recommendationId === recId);
  const offers = (f?.actions || []).filter((a) => a.actionId !== 'process.stop');
  if (!offers.length) return <p className="small t2">No automatic restart fix applies{f?.manual ? `: ${f.manual.reason}` : '.'}</p>;
  return <div className="stack">{offers.map((o) => <ActionOfferCard key={`${o.actionId}:${JSON.stringify(o.params)}`} offer={o} flow={flow} />)}</div>;
}
