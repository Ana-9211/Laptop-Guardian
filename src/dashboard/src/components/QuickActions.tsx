import { useState } from 'react';
import { Card } from './ui';
import { ActionButton, useActionFlow } from './ActionFlow';
import { useStatus } from '../state/StatusProvider';

type Item = { actionId: string; label: string; params?: Record<string, string | number>; hint: string };
const SETS: Record<'health' | 'storage', { title: string; items: Item[] }> = {
  health: { title: 'Maintenance actions', items: [
    { actionId: 'scan.run-now', label: 'Run a daily scan', params: { kind: 'daily' }, hint: 'Refresh the numbers on this page.' },
    { actionId: 'scan.run-now', label: 'Run a weekly analysis', params: { kind: 'weekly' }, hint: 'Longer; never shuts the laptop down when started here.' },
    { actionId: 'system.run-windows-update-scan', label: 'Check for Windows updates', hint: 'Search only; nothing is installed.' },
    { actionId: 'defender.quick-scan', label: 'Defender quick scan', hint: 'Needs administrator permission.' },
    { actionId: 'defender.update-signatures', label: 'Update Defender signatures', hint: 'Needs administrator permission.' },
    { actionId: 'dns.flush', label: 'Flush DNS cache', hint: 'Needs administrator permission.' },
    { actionId: 'system.open-settings', label: 'Open Windows Update', params: { page: 'windows-update' }, hint: 'Install updates yourself in Windows.' },
    { actionId: 'system.open-settings', label: 'Open startup apps', params: { page: 'startup-apps' }, hint: 'Choose what starts with Windows.' },
  ] },
  storage: { title: 'Cleanup actions', items: [
    { actionId: 'storage.clean-temp', label: 'Clean temporary files', params: { scope: 'temp' }, hint: 'Your temp folder, files older than your age setting.' },
    { actionId: 'storage.clean-temp', label: 'Clean caches and crash dumps', params: { scope: 'all' }, hint: 'Regenerable data only.' },
    { actionId: 'cleanup.empty-recycle-bin', label: 'Empty the Recycle Bin', hint: 'Permanent.' },
    { actionId: 'system.open-settings', label: 'Open Windows Storage', params: { page: 'storage' }, hint: 'Windows Storage Sense.' },
    { actionId: 'system.open-settings', label: 'Open Apps & features', params: { page: 'apps-features' }, hint: 'Uninstall programs.' },
  ] },
};

/** Always-available buttons for the common maintenance actions of a page. Each goes through the same plan, confirm, verify flow. */
export function QuickActions({ set }: { set: 'health' | 'storage' }) {
  const { check } = useStatus();
  const flow = useActionFlow(() => { void check(true); });
  const [open, setOpen] = useState(false);
  const s = SETS[set];
  return (
    <Card title={s.title} actions={<button className="btn sm ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>}>
      {open && (
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {s.items.map((i) => <ActionButton key={i.label} actionId={i.actionId} params={i.params || {}} label={i.label} title={i.hint} flow={flow} />)}
        </div>
      )}
      {!open && <p className="small muted">Scans, updates, cleanup and shortcuts to the matching Windows pages. Every action shows what it will do first.</p>}
      {flow.node}
    </Card>
  );
}
