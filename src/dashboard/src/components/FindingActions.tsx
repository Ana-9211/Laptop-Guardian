import { Badge, Icon, KV, RiskBadge, Sep } from './ui';
import { ActionButton, useActionFlow } from './ActionFlow';
import type { ActionOffer, Finding, HistoryItem } from '../types';
import { ago, fmtFull, TONE_BY_RESULT } from '../format';
import { confidenceLabel, kindLabel } from '../labels';

type Flow = ReturnType<typeof useActionFlow>;

const ADMIN_BADGE = { yes: { tone: 'warn', text: 'Administrator permission' }, maybe: { tone: 'warn', text: 'May need administrator permission' }, no: { tone: 'ok', text: 'No administrator needed' } } as const;

/** One allowlisted action with everything the user needs before pressing the button. */
export function ActionOfferCard({ offer, flow }: { offer: ActionOffer; flow: Flow }) {
  const admin = ADMIN_BADGE[offer.admin];
  const tone = offer.risk === 'HIGH' || offer.risk === 'MEDIUM' ? 'danger' : 'primary';
  return (
    <div className={`offer ${offer.eligible ? '' : 'is-off'}`}>
      <div className="row spread">
        <div className="row tight"><b>{offer.label}</b><RiskBadge risk={String(offer.risk)} /></div>
        <ActionButton flow={flow} actionId={offer.actionId} params={offer.params} label={offer.label} tone={offer.eligible ? tone : undefined} disabled={!offer.eligible} icon={offer.admin === 'yes' ? 'elevate' : 'bolt'} title={offer.eligible ? undefined : offer.ineligibleReason || undefined} />
      </div>
      <p className="t2">{offer.summary}</p>
      {!offer.eligible && <div className="notice crit small" role="note"><b>Not available:</b> {offer.ineligibleReason}</div>}
      <div className="row tight small"><Badge tone={admin.tone}>{admin.text}</Badge><Badge tone={offer.reversible ? 'ok' : 'crit'}>{offer.reversible ? 'Reversible' : 'Not reversible'}</Badge>{offer.long && <Badge tone="info">Takes a few minutes</Badge>}</div>
      <details className="exact"><summary>Impact and exact action</summary>
        <div className="stack">
          <div><span className="eyebrow">Impact</span><p className="t2">{offer.consequences}</p></div>
          <div><span className="eyebrow">Undo</span><p className="t2">{offer.undo}</p></div>
          <KV items={[['Action', <code key="id">{offer.actionId}</code>], ...Object.entries(offer.params).map(([k, v]): [string, React.ReactNode] => [k, <code key={k}>{String(v)}</code>])]} />
        </div>
      </details>
    </div>
  );
}

export function AttemptList({ attempts }: { attempts: HistoryItem[] }) {
  if (!attempts.length) return <p className="small muted">No previous attempts.</p>;
  return (
    <div className="timeline">
      {attempts.map((a) => (
        <div className="tl" key={a.id}>
          <span className={`dot ${TONE_BY_RESULT[a.result] || 'info'}`} />
          <div className="minw0">
            <div className="row tight"><b>{a.label}</b><Badge tone={TONE_BY_RESULT[a.result] || ''}>{a.result}</Badge>{a.verified && <Badge tone="ok">verified</Badge>}</div>
            <div className="small muted">{ago(a.ts)}<Sep />{fmtFull(a.ts)}</div>
            {(a.message || a.error) && <div className="small t2">{a.error || a.message}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Everything about one finding, in the order the user needs it: what, why, evidence, then each possible fix. */
export function FindingDetail({ finding, flow }: { finding: Finding; flow: Flow }) {
  return (
    <div className="stack-lg">
      <div className="row"><RiskBadge risk={String(finding.risk)} /><Badge tone="outline">{confidenceLabel(finding.confidence)}</Badge><Badge tone="outline">{kindLabel(finding.kind)}</Badge></div>
      <section><div className="eyebrow">What it is</div><p>{finding.what}</p></section>
      <section><div className="eyebrow">Why it was flagged</div>{finding.why.length ? <ul className="plain-list">{finding.why.map((w) => <li key={w}>{w}</li>)}</ul> : <p className="muted">No reason recorded.</p>}</section>
      {finding.evidence.length > 0 && <section><div className="eyebrow">Evidence</div><KV items={finding.evidence.map((e): [string, React.ReactNode] => [e.label, <span key={e.label} className="mono-wrap">{e.value}</span>])} /></section>}
      {finding.ai && finding.ai.what_is_it && <section><div className="eyebrow">AI explanation (text only, never executed)</div><p className="t2">{finding.ai.what_is_it}</p></section>}
      <section>
        <div className="eyebrow">What you can do</div>
        <div className="stack">
          {finding.actions.map((o) => <ActionOfferCard key={`${o.actionId}:${JSON.stringify(o.params)}`} offer={o} flow={flow} />)}
          {finding.manual && <div className="offer"><div className="row spread"><b>{finding.manual.label}</b><a className="btn sm" href={finding.manual.href}>Open</a></div><p className="t2">{finding.manual.reason}</p></div>}
          <a className="btn sm" href={finding.investigate.href} style={{ justifySelf: 'start' }}><Icon name="search" size={13} />{finding.investigate.label}</a>
        </div>
      </section>
      <section><div className="eyebrow">Previous attempts</div><AttemptList attempts={finding.attempts} /></section>
    </div>
  );
}
