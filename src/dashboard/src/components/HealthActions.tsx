import { useFindings } from '../state/findings';
import { Badge, Card, Icon, RiskBadge } from './ui';
import { ActionButton, useActionFlow } from './ActionFlow';
import { useStatus } from '../state/StatusProvider';

/** Health findings with a direct, confirmed fix. Hidden when everything is fine. Each row links to the full detail. */
export function HealthActions() {
  const { check } = useStatus();
  const q = useFindings();
  const flow = useActionFlow(() => { q.reload(); void check(true); });
  const items = (q.data?.findings || []).filter((f) => f.kind === 'health');
  if (!items.length) return flow.node;
  return (
    <>
      <Card title="Things you can fix now" actions={<a className="small" href="#/actions">Open Action Center</a>} flush>
        <div className="list">
          {items.map((f) => (
            <div key={f.id} className="list-row static" data-tone={f.risk === 'HIGH' ? 'crit' : f.risk === 'MEDIUM' ? 'warn' : 'info'}>
              <span className="what">
                <b>{f.title}</b>
                <span className="small t2">{f.what}</span>
                <span className="row tight small">{f.actions.filter((a) => a.eligible).map((a) => <Badge key={a.actionId} tone={a.admin === 'yes' ? 'warn' : 'ok'}>{a.admin === 'yes' ? 'Administrator permission' : 'No administrator needed'}</Badge>)}</span>
              </span>
              <RiskBadge risk={String(f.risk)} />
              <span className="row tight">
                {f.actions.filter((a) => a.eligible).map((a) => <ActionButton key={a.actionId + JSON.stringify(a.params)} flow={flow} actionId={a.actionId} params={a.params} label={a.label} tone="primary" icon={a.admin === 'yes' ? 'elevate' : 'bolt'} />)}
                <a className="btn sm" href={`#/actions?finding=${encodeURIComponent(f.id)}`}><Icon name="info" size={13} />Details</a>
              </span>
            </div>
          ))}
        </div>
      </Card>
      {flow.node}
    </>
  );
}
