import { Badge, Card, Empty, Icon, Sep, SkeletonCards, Tip } from './ui';
import { maintenanceText } from './StatusBar';
import { ScheduleRepairNotice } from './ScheduleRepair';
import { useStatus } from '../state/StatusProvider';
import { fmtDate, fmtFull, ago, NA } from '../format';
import type { TaskRow } from '../types';
import { ActionButton, useActionFlow } from './ActionFlow';

const TONE: Record<string, string> = { ok: 'ok', info: 'info', warn: 'warn', crit: 'crit' };
const LABEL: Record<string, string> = { ok: 'OK', 'never-run': 'Waiting for first run', missing: 'Not installed', disabled: 'Disabled', off: 'Off in Settings', running: 'Running', failed: 'Failed' };
const TASK_BLURB: Record<TaskRow['kind'], string> = {
  dashboard: 'Starts the dashboard at logon',
  weekly: 'Deep analysis; scheduled runs may shut down',
  daily: 'Daily audit',
};

export function AttentionCard() {
  const { status: s, live, check } = useStatus();
  const flow = useActionFlow(() => { void check(true); });
  return (
    <Card title="What needs attention" flush actions={s && <Badge tone={s.attention.some((a) => a.level === 'crit') ? 'crit' : s.attention.some((a) => a.level === 'warn') ? 'warn' : 'ok'}>{s.attention.length}</Badge>}>
      {!s ? (live.link === 'offline' ? <div className="small t2 pad">The bridge is offline, so priorities cannot be computed. Open Laptop Guardian again to restart it.</div> : <div className="pad"><SkeletonCards n={1} /></div>)
        : s.attention.length === 0 ? <Empty icon="check" title="Nothing needs your attention">Security, storage, scheduled maintenance and recommendations all look fine.</Empty>
        : (
          <div className="list" role="list">
            {s.attention.map((a) => {
              const inner = (
                <>
                  <span className="ico"><Icon name={a.level === 'info' ? 'info' : 'warn'} /></span>
                  <span className="what"><b>{a.title}</b><span className="small t2">{a.detail}</span></span>
                  {a.cta && <span className="small muted nowrap">{a.cta}</span>}
                  {a.href && <Icon name="chev" size={14} />}
                </>
              );
              const note = a.noAction || a.manualNote;
              return (
                <div key={a.id} className="attn-item" data-tone={a.level} role="listitem">
                  {a.href ? <a className="list-row" data-tone={a.level} href={a.href}>{inner}</a> : <div className="list-row" data-tone={a.level}>{inner}</div>}
                  {(a.actions.length > 0 || note) && (
                    <div className="attn-actions">
                      {a.actions.map((x) => <ActionButton key={x.actionId + JSON.stringify(x.params)} actionId={x.actionId} params={x.params} label={x.label} flow={flow} />)}
                      {note && <span className="small muted">{a.actions.length ? 'Note: ' : 'No automatic fix: '}{note}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      {flow.node}
    </Card>
  );
}

function TaskLine({ t }: { t: TaskRow }) {
  const never = t.lastResult.kind === 'never-run';
  const clean = ['success', 'ready', 'never-run', 'running'].includes(t.lastResult.kind);
  return (
    <div className="task-row">
      <div><b>{t.name}</b><div className="small muted">{TASK_BLURB[t.kind]}</div></div>
      <div className="stack tight">
        <div className="row tight"><Badge tone={TONE[t.level]} dot>{LABEL[t.status] || t.status}</Badge><span className="small t2">{t.summary}</span></div>
        <div className="small muted">
          Next {t.nextRun ? fmtDate(t.nextRun) : NA}<Sep />Last run {t.lastRun ? <Tip text={fmtFull(t.lastRun)}><span>{ago(t.lastRun)}</span></Tip> : 'never'}
          {t.runLevel && <><Sep />{t.runLevel === 'Highest' ? 'Administrator' : 'Standard user'} rights</>}
          {t.state !== 'NotRegistered' && !clean && <><Sep />Result <Tip text={t.lastResult.text}><span className="mono" tabIndex={0}>{t.lastResult.hex || NA}</span></Tip> {t.lastResult.text}</>}
          {never && <Tip text={'Task Scheduler reports 0x41303 ("has not yet run") for a task that is registered but has not been triggered yet. That is normal.'}><span tabIndex={0}><Sep />Waiting for first run</span></Tip>}
        </div>
        {t.issues.map((i) => <div key={i} className="small warn-text issue"><Icon name="warn" size={13} />{i}</div>)}
      </div>
    </div>
  );
}

export function TaskStatusCard() {
  const { status: s, live } = useStatus();
  const sch = s?.schedule;
  return (
    <Card title="Background maintenance" actions={sch && <Badge tone={sch.error ? 'warn' : TONE[sch.level]} dot>{sch.error ? 'Unreadable' : maintenanceText(sch.tasks, sch.level)}</Badge>}>
      {!s || sch?.pending ? (live.link === 'offline' ? <div className="small t2">Offline.</div> : <SkeletonCards n={1} />) : (
        <div className="stack">
          {sch!.error && <div className="notice warn">Task Scheduler could not be read ({sch!.error}). Showing the last known state. Try <b>Refresh status</b>.</div>}
          {sch!.tasks.length === 0 && !sch!.error && <Empty title="No scheduled tasks found">Run <code>Install-LaptopGuardian.ps1</code> to register the Daily, Weekly and Dashboard tasks.</Empty>}
          <ScheduleRepairNotice />
          <div className="task-grid">{sch!.tasks.map((t) => <TaskLine key={t.kind} t={t} />)}</div>
          <div className="small muted">{s.shutdown.armed ? `Scheduled weekly runs may start a shutdown at ${fmtDate(s.shutdown.target)} when every safety gate passes.` : 'Weekly shutdown is turned off, so the laptop stays on after the weekly run.'} Runs started from this dashboard or by hand never shut the laptop down.</div>
        </div>
      )}
    </Card>
  );
}
