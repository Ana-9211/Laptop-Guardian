import type { Draft, Upd } from './fields';
import { Card, Switch } from '../ui';
import { Field, Lines, Num } from './fields';

export function StorageCard({ d, upd }: { d: Draft; upd: Upd }) {
  return (
      <Card title="Storage scanning">
        <div className="grid g2">
          <Field label="Scanned drives" hint="One per line, e.g. C:"><Lines value={d.storage.drives} onChange={(v) => upd((x) => { x.storage.drives = v; })} rows={2} /></Field>
          <Field label="Excluded directories" hint="Never scanned."><Lines value={d.storage.excludedDirs} onChange={(v) => upd((x) => { x.storage.excludedDirs = v; })} rows={2} placeholder="D:\Games" /></Field>
          <Field label="Protected directories" hint="Scanned for reporting but never recommended for removal."><Lines value={d.storage.protectedDirs} onChange={(v) => upd((x) => { x.storage.protectedDirs = v; })} rows={2} placeholder="C:\Users\You\Documents" /></Field>
          <div className="grid g2" style={{ alignContent: 'start' }}>
            <Field label="Minimum large file (MB)"><Num min={1} value={d.storage.minLargeFileMB} onChange={(v) => upd((x) => { x.storage.minLargeFileMB = v; })} /></Field>
            <Field label="Old file after (days)"><Num min={1} value={d.storage.oldFileDays} onChange={(v) => upd((x) => { x.storage.oldFileDays = v; })} /></Field>
            <Field label="Duplicate minimum (MB)"><Num min={1} value={d.storage.duplicateMinMB} onChange={(v) => upd((x) => { x.storage.duplicateMinMB = v; })} /></Field>
            <div style={{ alignSelf: 'end' }}><Switch checked={d.storage.duplicateScan} onChange={(v) => upd((x) => { x.storage.duplicateScan = v; })} label="Scan for duplicates" /></div>
          </div>
        </div>
      </Card>
  );
}
