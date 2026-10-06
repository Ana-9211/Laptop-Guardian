import { useState } from 'react';
import { useQuery } from '../../api';
import { Card, ErrorState, KV, SkeletonCards, useToast } from '../ui';
import { ago } from '../../format';

interface Diag {
  bridge: { version: string; startedAt: string; codeMtime: string; restartNeeded: boolean; port: number | null; node: string; uptimeSec: number };
  install: { mode: 'installed' | 'checkout'; dataFolder: string; programFolder: string; administratorsFolder: string | null };
  lastRuns: { daily: { status: string | null; finishedAt: string | null } | null; weekly: { status: string | null; finishedAt: string | null } | null };
  sampler: { deepNetworkGuardOn: boolean; source: string | null; running: boolean; alive: boolean; gaveUp: boolean; restarts: number };
  text: string;
}

/** Facts for a bug report. The copied text has the user name and home paths replaced; what is shown here is for you, on this laptop. */
export function DiagnosticsCard() {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const q = useQuery<Diag>(open ? '/api/diagnostics' : null);
  const d = q.data;
  const copy = async () => {
    if (!d) return;
    try { await navigator.clipboard.writeText(d.text); toast('ok', 'Diagnostics copied (user name and home paths are masked).'); }
    catch { toast('warn', 'The browser would not let Guardian copy. Select the text below and copy it yourself.'); }
  };
  const age = (iso?: string | null) => (iso ? ago(iso) : 'n/a');
  return (
    <Card title="Diagnostics" actions={<button className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>}>
      {!open ? <p className="small muted">Version, install mode, folders, last runs and sampler state, with a button that copies a masked report for a bug report.</p>
        : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !d ? <SkeletonCards n={1} h={120} /> : (
          <div className="stack">
            <KV items={[
              ['Version', `${d.bridge.version} (node ${d.bridge.node})`],
              ['Code age', d.bridge.restartNeeded ? 'The program files changed after this bridge started: restart it from the shortcut' : `Running current code, started ${age(d.bridge.startedAt)}`],
              ['Install mode', d.install.mode === 'installed' ? 'Installed copy' : 'Development checkout (no administrator work)'],
              ['Data folder', d.install.dataFolder],
              ['Program folder', d.install.programFolder],
              ['Last Daily', d.lastRuns.daily ? `${d.lastRuns.daily.status || '?'}, ${age(d.lastRuns.daily.finishedAt)}` : 'never'],
              ['Last Weekly', d.lastRuns.weekly ? `${d.lastRuns.weekly.status || '?'}, ${age(d.lastRuns.weekly.finishedAt)}` : 'never'],
              ['Connection sampler', d.sampler.deepNetworkGuardOn ? (d.sampler.running && d.sampler.alive ? 'Running' : d.sampler.gaveUp ? 'Stopped repeatedly; using the netstat fallback' : 'Not running') + ` (source: ${d.sampler.source || 'none'}, restarts: ${d.sampler.restarts})` : 'Idle (Deep Network Guard is off)'],
            ]} />
            <div className="row"><button className="btn primary" onClick={() => void copy()}>Copy diagnostics</button><span className="small muted">Masked: user name, computer name and home paths.</span></div>
            <pre className="mono-block" style={{ maxHeight: 200, overflow: 'auto', margin: 0 }} aria-label="Masked diagnostics text">{d.text}</pre>
          </div>
        )}
    </Card>
  );
}
