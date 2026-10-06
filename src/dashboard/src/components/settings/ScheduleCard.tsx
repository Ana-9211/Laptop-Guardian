import type { Draft, Upd } from './fields';
import { Card, Switch } from '../ui';
import { fmtDate } from '../../format';
import { ScheduleRepairNotice } from '../ScheduleRepair';
import type { useOverview } from '../../state/overview';
import { DAYS, Field } from './fields';

export function ScheduleCard({ d, upd, ov }: { d: Draft; upd: Upd; ov: ReturnType<typeof useOverview> }) {
  return (
      <Card title="Schedule">
        <div className="stack-lg">
          <div className="grid g3" style={{ alignItems: 'start' }}>
            <div className="stack"><Switch checked={d.schedule.daily.enabled} onChange={(v) => upd((x) => { x.schedule.daily.enabled = v; })} label={<b>Daily audit</b>} />
              <Field label="Time"><input type="time" value={d.schedule.daily.time} onChange={(e) => upd((x) => { x.schedule.daily.time = e.target.value; })} /></Field></div>
            <div className="stack"><Switch checked={d.schedule.weekly.enabled} onChange={(v) => upd((x) => { x.schedule.weekly.enabled = v; })} label={<b>Weekly deep analysis</b>} />
              <div className="row"><Field label="Day"><select value={d.schedule.weekly.day} onChange={(e) => upd((x) => { x.schedule.weekly.day = e.target.value; })}>{DAYS.map((x) => <option key={x}>{x}</option>)}</select></Field>
                <Field label="Start"><input type="time" value={d.schedule.weekly.time} onChange={(e) => upd((x) => { x.schedule.weekly.time = e.target.value; })} /></Field></div></div>
            <div className="stack"><b>Weekly shutdown</b>
              <Field label="Target shutdown time" hint={`Unfinished work is recorded as incomplete when this is reached. Shutdown is ${d.safety.weeklyShutdown && d.schedule.weekly.shutdownEnabled ? 'on' : 'off'}; change it with the switch in Safety above.`}><input type="time" value={d.schedule.weekly.shutdownTime} onChange={(e) => upd((x) => { x.schedule.weekly.shutdownTime = e.target.value; })} /></Field></div>
          </div>
          <ScheduleRepairNotice />
          <div className="small muted">Scheduling uses Windows Task Scheduler; no Guardian process stays running. Saving a changed schedule updates the tasks; elevated tasks are never downgraded and need your permission to change. The laptop must be on (or wake for the task) at these times.{ov.data && <> Next: daily {fmtDate(ov.data.next.daily)} - weekly {fmtDate(ov.data.next.weekly)}.</>}</div>
        </div>
      </Card>
  );
}
