import { Component, ReactNode, useEffect, useState } from 'react';
import { Icon, ToastProvider, Tip, Badge } from './components/ui';
import { useQuery } from './api';
import type { Overview } from './types';
import { useHash } from './router';
import { useTheme, nextTheme, themeLabel } from './theme';
import { findNav, groupOf } from './nav';
import { useNavCollapsed } from './layoutPrefs';
import { OverviewContext } from './state/overview';
import { StatusProvider, useStatus } from './state/StatusProvider';
import { ConnectionPill, RefreshButton, StatusRail, contextSubtitle } from './components/StatusBar';
import { ScanBanner } from './components/ScanBanner';
import { Sidebar } from './components/Sidebar';

/** A rendering bug on one page must not blank the whole app: show the error with a way out; navigating resets it. */
class PageBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="page"><div className="error-state" role="alert">
        <Icon name="warn" size={20} />
        <div className="grow"><b>This page failed to display</b><div className="small t2">{this.state.err.message.slice(0, 300)}</div><div className="small muted">The rest of Laptop Guardian is unaffected. Try another page, or Refresh status.</div></div>
        <button className="btn" onClick={() => this.setState({ err: null })}>Try again</button>
      </div></div>
    );
  }
}

function Shell() {
  const { path } = useHash();
  const pageId = path.split('/')[1] || 'overview';
  const nav = findNav(pageId);
  const Page = nav.page;
  const [theme, setTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useNavCollapsed();
  const { status, live } = useStatus();
  const overview = useQuery<Overview>('/api/overview'); // reloaded by the status provider (one poll loop), not by its own timer
  const o = overview.data;

  useEffect(() => { setMenuOpen(false); document.title = `${nav.label} - Laptop Guardian`; window.scrollTo(0, 0); }, [nav.label]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <OverviewContext.Provider value={overview}>
      <div className="shell" data-collapsed={collapsed}>
        <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
        {menuOpen && <div className="nav-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
        <Sidebar page={nav.id} open={menuOpen} collapsed={collapsed} openRecommendations={o?.openRecommendations ?? 0} onToggleCollapse={toggleCollapsed} />
        <div className="main">
          <header className="topbar">
            <Tip text="Open navigation"><button className="btn ghost icon-btn menu-btn" aria-label="Toggle navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><Icon name="menu" /></button></Tip>
            <div className="crumb">
              <div className="crumb-path">{groupOf(nav.id)}</div>
              <div className="title">{nav.label}</div>
              <div className="subtitle">{contextSubtitle(status, live)}</div>
            </div>
            <div className="grow" />
            <ConnectionPill />
            <RefreshButton />
            {o?.ai && <Tip text={o.ai.enabled ? 'Gemini analysis is enabled. Structured metadata only is sent.' : 'Gemini analysis is off. Nothing leaves this machine.'}><Badge tone={o.ai.enabled ? 'info' : ''}>{o.ai.enabled ? 'AI on' : 'AI off'}</Badge></Tip>}
            <Tip text="Switch between light, dark and automatic theme">
              <button className="btn ghost icon-btn" aria-label={`Theme: ${themeLabel(theme)}. Switch theme`} onClick={() => setTheme(nextTheme(theme))}>
                <Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor'} /><span className="small theme-label">{themeLabel(theme)}</span>
              </button>
            </Tip>
          </header>
          {live.scan.phase === 'running' && <div className="scan-progress" role="progressbar" aria-label="Scan in progress" />}
          <StatusRail />
          <ScanBanner />
          <main id="main" tabIndex={-1} className="main-focus"><PageBoundary key={nav.id}><Page /></PageBoundary></main>
        </div>
      </div>
    </OverviewContext.Provider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <StatusProvider>
        <Shell />
      </StatusProvider>
    </ToastProvider>
  );
}
