import type { Draft, Upd } from './fields';
import { Card, Switch } from '../ui';
import { Field, Num } from './fields';

export function CleanupCard({ d, upd }: { d: Draft; upd: Upd }) {
  return (
      <Card title="Cleanup">
        <div className="stack-lg">
          <div className="notice warn">Cleanup only runs when Safe mode is off. It touches clearly temporary data only. Documents, source code, installed programs, Downloads and unknown files are never deleted automatically.</div>
          <div className="grid g2">
            <Switch checked={d.cleanup.tempFiles} onChange={(v) => upd((x) => { x.cleanup.tempFiles = v; })} label="Clean temporary files" hint="Deletes files in user and Windows temp folders older than the age below. Apps using a temp file at that moment are skipped." />
            <Switch checked={d.cleanup.crashDumps} onChange={(v) => upd((x) => { x.cleanup.crashDumps = v; })} label="Clean crash dumps" hint="Removes minidumps and memory dumps. You lose the data used to diagnose a past blue screen." />
            <Switch checked={d.cleanup.caches} onChange={(v) => upd((x) => { x.cleanup.caches = v; })} label="Clean known safe caches" hint="Windows thumbnail and error-report caches. Rebuilt automatically; the first use afterwards may be slightly slower." />
            <Field label="Recycle Bin" hint="Never is safest: Guardian will not empty the Recycle Bin."><select value={d.cleanup.recycleBin} onChange={(e) => upd((x) => { x.cleanup.recycleBin = e.target.value; })}><option value="never">Never empty</option><option value="always">Empty on every run (not recommended)</option></select></Field>
            <Field label="Only clean temp files older than (days)"><Num min={0} max={365} value={d.cleanup.tempMinAgeDays} onChange={(v) => upd((x) => { x.cleanup.tempMinAgeDays = v; })} /></Field>
          </div>
        </div>
      </Card>
  );
}
