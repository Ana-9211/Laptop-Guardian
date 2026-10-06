import type { Draft, Upd } from './fields';
import { Card } from '../ui';
import { Field, Num } from './fields';

export function RetentionCard({ d, upd }: { d: Draft; upd: Upd }) {
  return (
      <Card title="Retention">
        <div className="grid g3">
          <Field label="Keep reports for (days)" hint="0 keeps every report forever. Metrics history and the audit log are never deleted automatically."><Num min={0} max={3650} value={d.retention.reportsDays} onChange={(v) => upd((x) => { x.retention.reportsDays = v; })} /></Field>
        </div>
      </Card>
  );
}
