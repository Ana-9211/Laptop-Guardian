import { useStatus } from '../state/StatusProvider';
import { NAV } from '../nav';
import { ago } from '../format';
import { Icon, Tip } from './ui';

function BrandMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent-soft)" />
      <path d="M16 5l9 3.5v7.2c0 5.2-3.6 9.2-9 11.3-5.4-2.1-9-6.1-9-11.3V8.5z" fill="none" stroke="var(--accent)" strokeWidth="2.2" />
      <path d="M11 16.5l3.4 3.2L21 12.8" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface SidebarProps { page: string; open: boolean; collapsed: boolean; openRecommendations: number; onToggleCollapse: () => void }

export function Sidebar({ page, open, collapsed, openRecommendations, onToggleCollapse }: SidebarProps) {
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
      {NAV.map((n) => {
        const link = (
          <a className="item" href={`#/${n.id}`} aria-current={page === n.id ? 'page' : undefined} aria-label={collapsed ? n.label : undefined}>
            <Icon name={n.icon} /><span className="label">{n.label}</span>
            {n.id === 'recommendations' && openRecommendations > 0 && <span className="count" aria-label={`${openRecommendations} open`}>{openRecommendations}</span>}
          </a>
        );
        return (
          <div key={n.id} className="nav-entry">
            {n.group && <div className="nav-group">{n.group}</div>}
            {collapsed ? <Tip text={n.label} block>{link}</Tip> : link}
          </div>
        );
      })}
      <div className="nav-foot">
        <div className="row small muted"><span className={`dot ${footTone}`} /><span className="foot-text">{footText}</span></div>
        <div className="small muted foot-text">Local only, 127.0.0.1</div>
        <Tip text={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <button className="btn ghost sm nav-collapse" onClick={onToggleCollapse} aria-pressed={collapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><Icon name="sidebar" size={14} /><span className="foot-text">{collapsed ? '' : 'Collapse'}</span></button>
        </Tip>
      </div>
    </nav>
  );
}
