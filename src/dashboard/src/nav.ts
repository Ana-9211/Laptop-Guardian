import type { ComponentType } from 'react';
import type { IconName } from './components/ui';
import Overview from './pages/Overview';
import { DailyPage, WeeklyPage } from './pages/ReportPages';
import Processes from './pages/Processes';
import Files from './pages/Files';
import Health from './pages/Health';
import Reports from './pages/Reports';
import Logs from './pages/Logs';
import Recommendations from './pages/Recommendations';
import { BlacklistPage, WhitelistPage } from './pages/Policy';
import Settings from './pages/Settings';

export interface NavItem { id: string; label: string; icon: IconName; page: ComponentType; group?: string }

/** The twelve pages, in sidebar order. `group` starts a new labelled section. */
export const NAV: NavItem[] = [
  { group: 'Monitor', id: 'overview', label: 'Overview', icon: 'overview', page: Overview },
  { id: 'daily', label: 'Daily', icon: 'daily', page: DailyPage },
  { id: 'weekly', label: 'Weekly', icon: 'weekly', page: WeeklyPage },
  { id: 'processes', label: 'Processes', icon: 'processes', page: Processes },
  { id: 'files', label: 'Files & Storage', icon: 'files', page: Files },
  { id: 'health', label: 'Health', icon: 'health', page: Health },
  { group: 'Records', id: 'reports', label: 'Reports', icon: 'reports', page: Reports },
  { id: 'logs', label: 'Logs', icon: 'logs', page: Logs },
  { id: 'recommendations', label: 'Recommendations', icon: 'recs', page: Recommendations },
  { group: 'Policy', id: 'blacklist', label: 'Blacklist', icon: 'blacklist', page: BlacklistPage },
  { id: 'whitelist', label: 'Whitelist', icon: 'whitelist', page: WhitelistPage },
  { id: 'settings', label: 'Settings', icon: 'settings', page: Settings },
];
/** The section label ("Monitor", "Records", "Policy") a page belongs to. */
export function groupOf(id: string): string {
  let group = '';
  for (const n of NAV) { if (n.group) group = n.group; if (n.id === id) return group; }
  return group;
}
export const findNav =(id: string): NavItem => NAV.find((n) => n.id === id) ?? NAV[0];
