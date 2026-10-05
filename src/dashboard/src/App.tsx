import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { Icon, ToastProvider, Tip, Badge } from './components/ui';
import { useQuery, Query } from './api';
import type { Overview as OverviewT } from './types';
import { ago } from './format';
import Overview from './pages/Overview';
import { DailyPage, WeeklyPage } from './pages/ReportPages';
import Processes from './pages/Processes';
import Files from './pages/Files';
import Health from './pages/Health';
import Reports from './pages/Reports';
import Logs from './pages/Logs';
import Recommendations from './pages/Recommendations';
import { PolicyPage } from './pages/Policy';
import Settings from './pages/Settings';

/* ---- hash router ---- */
export function useHash() {
  const read = () => window.location.hash.replace(/^#/, '') || '/overview';
  const [h, setH] = useState(read);
  useEffect(() => { const f = () => setH(read()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const [path, qs = ''] = h.split('?');
  return { path, params: new URLSearchParams(qs) };
}
export const go = (to: string) => { window.location.hash = to; };

/* ---- shared overview data ---- */
const OvCtx = createContext<Query<OverviewT> | null>(null);
export const useOverview = () => useContext(OvCtx)!;

/* ---- theme ---- */
type Theme = 'system' | 'light' | 'dark';
function useTheme(): [Theme, (t: Theme) => void] {
  const [t, setT] = useState<Theme>(() => { try { const v = localStorage.getItem('lg-theme'); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; } });
  const set = useCallback((v: Theme) => {
    setT(v);
    try { if (v === 'system') localStorage.removeItem('lg-theme'); else localStorage.setItem('lg-theme', v); } catch { /* storage unavailable */ }
    if (v === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v;
  }, []);
  return [t, set];
}

const NAV: { group?: string; id: string; label: string; icon: string }[] = [
  { group: 'Monitor', id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'daily', label: 'Daily', icon: 'daily' },
  { id: 'weekly', label: 'Weekly', icon: 'weekly' },
  { id: 'processes', label: 'Processes', icon: 'processes' },
  { id: 'files', label: 'Files & Storage', icon: 'files' },
  { id: 'health', label: 'Health', icon: 'health' },
  { group: 'Records', id: 'reports', label: 'Reports', icon: 'reports' },
  { id: 'logs', label: 'Logs', icon: 'logs' },
  { id: 'recommendations', label: 'Recommendations', icon: 'recs' },
  { group: 'Policy', id: 'blacklist', label: 'Blacklist', icon: 'blacklist' },
  { id: 'whitelist', label: 'Whitelist', icon: 'whitelist' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

function Page({ id }: { id: string }): ReactNode {
  switch (id) {
    case 'overview': return <Overview />;
    case 'daily': return <DailyPage />;
    case 'weekly': return <WeeklyPage />;
    case 'processes': return <Processes />;
    case 'files': return <Files />;
    case 'health': return <Health />;
    case 'reports': return <Reports />;
    case 'logs': return <Logs />;
    case 'recommendations': return <Recommendations />;
    case 'blacklist': return <PolicyPage list="blacklist" />;
    case 'whitelist': return <PolicyPage list="whitelist" />;
    case 'settings': return <Settings />;
    default: return <Overview />;
  }
}

export default function App() {
  const { path } = useHash();
  const page = path.split('/')[1] || 'overview';
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const ov = useQuery<OverviewT>('/api/overview');
  const o = ov.data;
  useEffect(() => { setOpen(false); document.title = `${NAV.find((n) => n.id === page)?.label || 'Overview'} · Laptop Guardian`; window.scrollTo(0, 0); }, [page]);
  useEffect(() => { if (!open) return; const f = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); }; document.addEventListener('keydown', f); return () => document.removeEventListener('keydown', f); }, [open]);
  useEffect(() => { const t = setInterval(ov.reload, 60000); return () => clearInterval(t); }, [ov.reload]);

  const safe = o?.safety;
  return (
    <ToastProvider>
      <OvCtx.Provider value={ov}>
        <div className="shell">
          <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
          {open && <div className="nav-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
          <nav className={`nav ${open ? 'open' : ''}`} aria-label="Primary">
            <div className="brand">
              <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--accent-soft)" /><path d="M16 5l9 3.5v7.2c0 5.2-3.6 9.2-9 11.3-5.4-2.1-9-6.1-9-11.3V8.5z" fill="none" stroke="var(--accent)" strokeWidth="2.2" /><path d="M11 16.5l3.4 3.2L21 12.8" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <div><b>Laptop Guardian</b><small>Local audit &amp; maintenance</small></div>
            </div>
            {NAV.map((n) => (
              <div key={n.id} style={{ display: 'contents' }}>
                {n.group && <div className="nav-group">{n.group}</div>}
                <a className="item" href={`#/${n.id}`} aria-current={page === n.id ? 'page' : undefined}>
                  <Icon name={n.icon} />{n.label}
                  {n.id === 'recommendations' && o && o.openRecommendations > 0 && <span className="count">{o.openRecommendations}</span>}
                </a>
              </div>
            ))}
            <div className="nav-foot">
              <div className="row small muted"><span className={`dot ${o?.run?.running ? 'info' : ov.error ? 'crit' : 'ok'}`} />{ov.error ? 'Bridge offline' : o?.run?.running ? `Running ${o.run.running.type}…` : `Last scan ${ago(o?.daily?.generatedAt)}`}</div>
              <div className="small muted">Local only · 127.0.0.1</div>
            </div>
          </nav>
          <div className="main">
            <header className="topbar">
              <button className="btn ghost icon-btn menu-btn" aria-label="Toggle navigation" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="menu" /></button>
              <div className="grow" />
              {safe?.safeMode && <Tip text="Safe mode: agents observe and recommend only. No process is terminated and nothing is cleaned automatically."><a href="#/settings" style={{ textDecoration: 'none' }}><Badge tone="accent" dot>Safe mode</Badge></a></Tip>}
              {safe?.automationPaused && <Badge tone="warn" dot>Automation paused</Badge>}
              {o?.ai && <Tip text={o.ai.enabled ? 'Gemini analysis is enabled. Structured metadata only is sent.' : 'Gemini analysis is off. Nothing leaves this machine.'}><Badge tone={o.ai.enabled ? 'info' : ''}>{o.ai.enabled ? 'AI on' : 'AI off'}</Badge></Tip>}
              <Tip text="Toggle light and dark theme">
                <button className="btn ghost icon-btn" aria-label={`Theme: ${theme}. Switch theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}>
                  <Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'overview'} /><span className="small">{theme === 'system' ? 'Auto' : theme === 'dark' ? 'Dark' : 'Light'}</span>
                </button>
              </Tip>
            </header>
            <main id="main" tabIndex={-1} style={{ outline: 'none' }}><Page id={page} /></main>
          </div>
        </div>
      </OvCtx.Provider>
    </ToastProvider>
  );
}
