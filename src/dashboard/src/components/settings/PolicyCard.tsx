import type { Draft, Upd } from './fields';
import { Card, ErrorState } from '../ui';
import type { useQuery } from '../../api';
import type { Policy } from '../../types';
import { Field, Num } from './fields';

export function PolicyCard({ d, upd, pol }: { d: Draft; upd: Upd; pol: ReturnType<typeof useQuery<Policy>> }) {
  return (
      <Card title="Process policies">
        <div className="stack">
          {pol.data ? <div className="row" style={{ gap: 20 }}><span><b className="num">{pol.data.blacklist.length}</b> <a href="#/blacklist">blacklisted</a></span><span><b className="num">{pol.data.whitelist.length}</b> <a href="#/whitelist">whitelisted</a></span><span><b className="num">{pol.data.ignored.length}</b> ignored recommendations</span></div> : pol.error ? <ErrorState error={pol.error} onRetry={pol.reload} /> : <div className="small muted">Loading...</div>}
          <p className="small muted">Whether blacklisted programs are ended automatically is a Safety setting (above). Only entries on your blacklist are ever ended; unknown programs never are.</p>
          <div className="grid g4">
            <Field label="Flag CPU above (%)"><Num min={1} max={100} value={d.thresholds.cpuPct} onChange={(v) => upd((x) => { x.thresholds.cpuPct = v; })} /></Field>
            <Field label="Flag memory above (MB)"><Num min={50} value={d.thresholds.memoryMB} onChange={(v) => upd((x) => { x.thresholds.memoryMB = v; })} /></Field>
          </div>
        </div>
      </Card>
  );
}
