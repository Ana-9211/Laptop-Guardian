import { useState } from 'react';
import { bridge, ApiError } from '../api';
import { useStatus } from '../state/StatusProvider';
import { Icon, useConfirm, useToast } from './ui';

/**
 * Shown when a scheduled task no longer matches Settings (or runs without administrator rights). Two explicit paths:
 *  - a plain re-register, which can never replace an elevated task;
 *  - an administrator re-register, which asks Windows for permission (UAC) and runs only Guardian's own Register action.
 */
export function ScheduleRepairNotice() {
  const { status: s, live, check } = useStatus();
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const [busy, setBusy] = useState(false);
  const tasks = (s?.schedule.tasks || []).filter((t) => t.repair.needed);
  if (!s || tasks.length === 0) return null;
  const needsElevation = tasks.some((t) => t.repair.requiresElevation);
  const run = async (elevate: boolean) => {
    setBusy(true);
    try {
      const r = await bridge.applySchedule(elevate);
      toast(r.elevationRequested || r.registered ? 'ok' : 'warn', r.message || 'Done.');
      await check(true);
    } catch (e) { toast('error', (e as ApiError).message); } finally { setBusy(false); }
  };
  const askElevation = () => confirm({
    title: 'Apply the schedule with administrator permission?',
    confirmLabel: 'Continue to Windows prompt',
    body: (
      <div className="stack">
        <p>Windows will show a permission (UAC) prompt. If you approve it, Laptop Guardian runs <b>only its own Task Scheduler script</b>, once, to re-register these tasks from your Settings:</p>
        <ul className="plain-list">{tasks.map((t) => <li key={t.kind}><b>{t.name}</b>: {t.issues[0] || 'run with administrator rights'}</li>)}</ul>
        <p className="small">Daily and Weekly keep administrator rights so SFC, DISM and the disk check can run. No other command is elevated. If you decline, nothing changes.</p>
      </div>
    ),
    onConfirm: () => run(true),
  });
  return (
    <div className="notice warn repair" role="status">
      <Icon name={needsElevation ? 'elevate' : 'warn'} />
      <div className="grow">
        <b>{live.elevationPending ? 'Waiting for you to approve the Windows prompt' : `${tasks.length} scheduled task${tasks.length > 1 ? 's need' : ' needs'} re-registering`}</b>
        <ul className="plain-list small">{tasks.map((t) => <li key={t.kind}>{t.name}: {t.issues[0] || (t.status === 'missing' ? 'not registered' : 'update needed')}</li>)}</ul>
        {needsElevation && <div className="small muted">These tasks run with administrator rights, so changing them needs Windows permission. Guardian never downgrades them on its own.</div>}
      </div>
      {live.elevationPending ? <span className="small muted">Check the taskbar for the prompt</span>
        : needsElevation ? <button className="btn primary sm" disabled={busy} onClick={askElevation}>Fix with administrator permission</button>
        : <button className="btn primary sm" disabled={busy} onClick={() => void run(false)}>{busy ? 'Working...' : 'Re-register tasks'}</button>}
      {node}
    </div>
  );
}
