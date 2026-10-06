import { type ReactNode } from 'react';
import { riskTone, NA } from '../../format';

export function Badge({ tone = '', children, dot, title }: { tone?: string; children: ReactNode; dot?: boolean; title?: string }) {
  return <span className={`badge ${tone}`} title={title}>{dot && <i />}{children}</span>;
}
/** Dot separator drawn with CSS so it renders identically everywhere (no font-dependent glyphs). */
export const Sep = () => <span className="sep" aria-hidden="true" />;
export const RiskBadge = ({ risk }: { risk?: string }) => <Badge tone={riskTone(risk)} dot>{risk || 'UNKNOWN'}</Badge>;

export function Card({ title, actions, children, flush, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && <header className="card-head"><h2>{title}</h2>{actions}</header>}
      <div className={`card-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, unit, sub, tone, bar, spark, tip }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; tone?: string; bar?: number; spark?: ReactNode; tip?: string }) {
  return (
    <div className="card stat" title={tip}>
      <div className="label">{tone && <span className={`dot ${tone}`} />}{label}</div>
      <div className="value">{value}{unit && <small>{unit}</small>}</div>
      <div className="sub">{sub}</div>
      {bar != null && <div className="bar" aria-hidden="true"><i className={tone === 'crit' ? 'crit' : tone === 'warn' ? 'warn' : ''} style={{ width: `${Math.min(100, Math.max(0, bar))}%` }} /></div>}
      {spark && <div className="spark">{spark}</div>}
    </div>
  );
}

export function KV({ items }: { items: [string, ReactNode][] }) {
  return <dl className="kv" style={{ margin: 0 }}>{items.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v ?? NA}</dd></div>)}</dl>;
}

/* ---------- sortable table ---------- */
