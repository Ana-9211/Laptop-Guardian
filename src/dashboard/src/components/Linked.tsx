import type { ReactNode } from 'react';
import { Badge, RiskBadge } from './ui';

/** A risk chip that opens the same page filtered to that risk. */
export function RiskLink({ risk, to }: { risk?: string; to: string }) {
  return <a className="chip-link" href={`#${to}`} title={`Show only ${risk || 'UNKNOWN'} items`} onClick={(e) => e.stopPropagation()}><RiskBadge risk={risk} /></a>;
}
/** A count or status badge that opens a filtered view. */
export function BadgeLink({ to, tone, children, title }: { to: string; tone?: string; children: ReactNode; title?: string }) {
  return <a className="chip-link" href={`#${to}`} title={title} onClick={(e) => e.stopPropagation()}><Badge tone={tone}>{children}</Badge></a>;
}
