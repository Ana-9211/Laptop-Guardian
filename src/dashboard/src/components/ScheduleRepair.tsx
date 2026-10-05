import { useStatus } from '../state/StatusProvider';
import { Icon } from './ui';
import { useActionFlow } from './ActionFlow';

/**
 * Shown when a scheduled task no longer matches Settings (or runs without administrator rights). The fix is the confirmed
 * "Repair schedule" action: a plain re-register can never replace an elevated task; the administrator route asks Windows for
 * permission and runs only Guardian's own Register action.
 */
export function ScheduleRepairNotice() {
  const { status: s, live, check } = useStatus();
  const flow = useActionFlow(() => { void check(true); });
  const tasks = (s?.schedule.tasks || []).filter((t) => t.repair.needed);
  if (!s || tasks.length === 0) return null;
  const needsElevation = tasks.some((t) => t.repair.requiresElevation);
  return (
    <div className="notice warn repair" role="status">
      <Icon name={needsElevation ? 'elevate' : 'warn'} />
      <div className="grow">
        <b>{live.elevationPending ? 'Waiting for you to approve the Windows prompt' : `${tasks.length} scheduled task${tasks.length > 1 ? 's need' : ' needs'} re-registering`}</b>
        <ul className="plain-list small">{tasks.map((t) => <li key={t.kind}>{t.name}: {t.issues[0] || (t.status === 'missing' ? 'not registered' : 'update needed')}</li>)}</ul>
        {needsElevation && <div className="small muted">These tasks run with administrator rights, so changing them needs Windows permission. Guardian never downgrades them on its own.</div>}
      </div>
      {live.elevationPending ? <span className="small muted">Check the taskbar for the prompt</span>
        : <button className="btn primary sm" onClick={() => void flow.run('schedule.repair', {}, needsElevation ? 'Repair with administrator permission' : 'Repair schedule')}>{needsElevation ? 'Repair with administrator permission' : 'Repair schedule'}</button>}
      {flow.node}
    </div>
  );
}
