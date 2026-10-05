import { useStatus } from '../state/StatusProvider';
import { NAV } from '../nav';
import { ago } from '../format';
import { Icon } from './ui';

function BrandMark() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--accent-soft)" />
      <path d="M16 5l9 3.5v7.2c0 5.2-3.6 9.2-9 11.3-5.4-2.1-9-6.1-9-11.3V8.5z" fill="none" stroke="var(--accent)" strokeWidth="2.2" />
      <path d="M11 16.5l3.4 3.2L21 12.8" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Sidebar({ page, open, openRecommendations }: { page: string; open: boolean; openRecommendations: number }) {
  const { status, live } = useStatus();
  const running = live.scan.phase === 'running' ? live.scan : null;
  const footTone = live.link === 'offline' ? 'crit' : running ? 'info' : 'ok';
  const footText = live.link === 'offline' ? 'Bridge offline' : running ? `Running ${running.type}...` : `Last scan ${status?.reports.daily ? ago(status.reports.daily.generatedAt) : 'never'}`;
  return (
    <nav className={`nav ${open ? 'open' : ''}`} aria-label="Primary">
      <div className="brand">
        <BrandMark />
        <div><b>Laptop Guardian</b><small>Local audit &amp; maintenance</small></div>
      </div>
      {NAV.map((n) => (
        <div key={n.id} className="nav-entry">
          {n.group && <div className="nav-group">{n.group}</div>}
          <a className="item" href={`#/${n.id}`} aria-current={page === n.id ? 'page' : undefined}>
            <Icon name={n.icon} />{n.label}
            {n.id === 'recommendations' && openRecommendations > 0 && <span className="count">{openRecommendations}</span>}
          </a>
        </div>
      ))}
      <div className="nav-foot">
        <div className="row small muted"><span className={`dot ${footTone}`} />{footText}</div>
        <div className="small muted">Local only, 127.0.0.1</div>
      </div>
    </nav>
  );
}
