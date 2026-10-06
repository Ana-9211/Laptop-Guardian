import type { Draft, Upd } from './fields';
import { Card } from '../ui';
import { Field, Num } from './fields';

export function RetentionCard({ d, upd }: { d: Draft; upd: Upd }) {
  return (
      <Card title="Retention">
        <div className="grid g3">
          <Field label="Keep reports for (days)" hint="0 keeps every report forever. Metrics and audit rows are never deleted; see the two settings beside this one."><Num min={0} max={3650} value={d.retention.reportsDays} onChange={(v) => upd((x) => { x.retention.reportsDays = v; })} /></Field>
          <Field label="Keep raw metric rows for (days)" hint="30 to 730. Older rows are rolled into one summary row per day; the charts keep working."><Num min={30} max={730} value={d.retention.metricsRawDays} onChange={(v) => upd((x) => { x.retention.metricsRawDays = v; })} /></Field>
          <Field label="Keep audit rows in the live log for (days)" hint="30 to 730. Older rows are moved to monthly archive files, never deleted."><Num min={30} max={730} value={d.retention.auditRawDays} onChange={(v) => upd((x) => { x.retention.auditRawDays = v; })} /></Field>
        </div>
      </Card>
  );
}
