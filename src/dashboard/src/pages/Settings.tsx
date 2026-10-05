import { ReactNode, useEffect, useState } from 'react';
import { api, ApiError, bridge, useQuery } from '../api';
import type { Config, Policy } from '../types';
import { Badge, Card, ErrorState, Icon, PageHead, SkeletonCards, Switch, useConfirm, useToast } from '../components/ui';
import { useOverview } from '../state/overview';
import { fmtDate } from '../format';
import { useStatus } from '../state/StatusProvider';
import { ScheduleRepairNotice } from '../components/ScheduleRepair';

type Draft = Config;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const strip = (c: Config) => { const x = clone(c) as Partial<Config>; delete x._ai; delete x.bridge; delete x.schemaVersion; return x; };
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <span className="hint" style={{ fontWeight: 400 }}>{hint}</span>}</label>;
}
const Lines = ({ value, onChange, rows = 3, placeholder }: { value: string[]; onChange: (v: string[]) => void; rows?: number; placeholder?: string }) => (
  <textarea rows={rows} value={value.join('\n')} placeholder={placeholder} spellCheck={false} style={{ fontFamily: 'var(--mono)', fontSize: 12.5, width: '100%' }} onChange={(e) => onChange(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))} />
);

export default function Settings() {
  const cfgQ = useQuery<Config>('/api/config');
  const usage = useQuery<{ requests: { ts: string; model: string; kind: string; ok: boolean; promptTokens: number; outputTokens: number; error?: string }[]; totals: { requests: number; failures: number; tokensToday: number; tokensAll: number } }>('/api/ai/usage');
  const pol = useQuery<Policy>('/api/policy');
  const ov = useOverview();
  const { check } = useStatus();
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const [d, setD] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [key, setKey] = useState(''); const [show, setShow] = useState(false); const [busy, setBusy] = useState('');
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const c = cfgQ.data; if (!c) return;
    // Keep unsaved edits when only a safety toggle (applied immediately) caused the reload.
    setD((cur) => (cur && JSON.stringify(strip(cur)) !== saved ? { ...cur, safety: clone(c.safety), _ai: c._ai } : clone(c)));
    setSaved(JSON.stringify(strip(c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgQ.data]);
  if (cfgQ.error) return <div className="page"><ErrorState error={cfgQ.error} onRetry={cfgQ.reload} /></div>;
  if (!d) return <div className="page"><PageHead title="Settings" /><SkeletonCards n={4} /></div>;

  const dirty = JSON.stringify(strip(d)) !== saved;
  const upd = (fn: (x: Draft) => void) => setD((cur) => { const n = clone(cur!); fn(n); return n; });
  const keyOn = cfgQ.data?._ai?.keyConfigured;

  const save = async (immediate?: Partial<Config>) => {
    setBusy('save');
    try {
      const body = strip(immediate ? { ...d, ...immediate } as Config : d) as Record<string, unknown>;
      const { schedule, ...rest } = body;
      await api.put('/api/config', rest);
      // Task Scheduler is only touched when the schedule itself changed, so unrelated saves can never alter the tasks.
      if (JSON.stringify(schedule) === JSON.stringify(cfgQ.data?.schedule)) toast('ok', 'Settings saved.');
      else {
        const r = await bridge.saveSchedule(schedule);
        if (r.needsElevation) toast('warn', 'Settings saved. Daily and Weekly run with administrator rights, so applying the new schedule needs your permission. Use the button in the Schedule section.');
        else if (!r.registered) toast('warn', `Settings saved. The schedule was not applied: ${r.message || 'Task Scheduler is unavailable'}.`);
        else toast('ok', 'Settings saved and schedule updated.');
        void check(true);
      }
      cfgQ.reload(); ov.reload();
    } catch (e) { toast('error', (e as ApiError).message); } finally { setBusy(''); }
  };
  /** Safety toggles apply immediately: they are the user's brake. */
  const safety = async (k: keyof Config['safety'], v: boolean) => {
    upd((x) => { x.safety[k] = v; });
    try { await api.put('/api/config', { safety: { [k]: v } }); toast('ok', 'Safety setting applied.'); cfgQ.reload(); ov.reload(); } catch (e) { toast('error', (e as ApiError).message); upd((x) => { x.safety[k] = !v; }); }
  };
  const aiCall = async (name: string, fn: () => Promise<void>) => { setBusy(name); try { await fn(); } catch (e) { toast('error', (e as ApiError).message); } finally { setBusy(''); } };
  const saveKey = () => aiCall('key', async () => { await api.post('/api/ai/key', { key }); setKey(''); setShow(false); toast('ok', 'API key stored, encrypted for your Windows account.'); cfgQ.reload(); ov.reload(); });
  const removeKey = () => confirm({ title: 'Remove the Gemini API key?', confirmLabel: 'Remove key', danger: true, body: 'AI analysis will stop working until you add a key again. Everything else keeps working.', onConfirm: () => aiCall('key', async () => { await api.del('/api/ai/key'); toast('ok', 'Key removed.'); cfgQ.reload(); ov.reload(); }) });
  const test = () => aiCall('test', async () => { setTestMsg(null); try { const r = await api.post<{ ok: boolean; message?: string; model?: string; latencyMs?: number; error?: string }>('/api/ai/test'); setTestMsg({ ok: r.ok, text: r.ok ? `Connected${r.model ? ` to ${r.model}` : ''}${r.latencyMs ? ` in ${r.latencyMs} ms` : ''}.` : r.error || 'Connection failed.' }); } catch (e) { setTestMsg({ ok: false, text: (e as ApiError).message }); } usage.reload(); });

  return (
    <div className="page">
      <PageHead title="Settings" sub="Changes to safety controls apply immediately. Other changes apply when you save." />

      {/* Safety */}
      <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--accent) 50%, var(--line))' }}>
        <header className="card-head"><Icon name="shield" /><h2>Safety</h2>{d.safety.safeMode ? <Badge tone="accent" dot>Safe mode on</Badge> : <Badge tone="warn" dot>Safe mode off</Badge>}</header>
        <div className="card-body stack-lg">
          <div className="safety-banner">
            <Switch checked={d.safety.safeMode} onChange={(v) => (v ? safety('safeMode', true) : confirm({ title: 'Turn off safe mode?', confirmLabel: 'Turn off safe mode', danger: true, body: 'Agents will be allowed to perform the cleanup and blacklisted-process termination you configured. Unknown processes and personal files are still never touched automatically.', onConfirm: () => safety('safeMode', false) }))}
              label={<b>Safe mode</b>} hint="Observe and recommend only. No process is terminated and nothing is cleaned automatically." />
          </div>
          <div className="grid g2">
            <Switch checked={d.safety.requireConfirmation} onChange={(v) => (v ? safety('requireConfirmation', true) : confirm({ title: 'Stop asking for confirmation?', confirmLabel: 'Turn off', danger: true, body: 'Destructive actions in the dashboard will still show a confirmation. This setting also governs scripted actions, which will no longer prompt.', onConfirm: () => safety('requireConfirmation', false) }))} label="Require confirmation for destructive actions" hint="Recommended. Always on in the dashboard." />
            <Switch checked={d.safety.autoKillBlacklisted} onChange={(v) => safety('autoKillBlacklisted', v)} label="Automatically terminate blacklisted processes" hint="Daily agent only. Needs safe mode off." />
            <Switch checked={d.safety.automationPaused} onChange={(v) => safety('automationPaused', v)} label="Pause automation" hint="Scheduled runs still observe and report; no automatic actions." />
            <Switch checked={d.safety.weeklyShutdown} onChange={(v) => safety('weeklyShutdown', v)} label="Shut down after the weekly run" hint="Windows performs the shutdown. Turn off to leave the laptop on." />
          </div>
        </div>
      </div>

      {/* Gemini */}
      <Card title="Gemini (AI analysis)" actions={<Badge tone={d.ai.enabled && keyOn ? 'info' : ''} dot>{d.ai.enabled ? (keyOn ? 'Enabled' : 'Needs key') : 'Off'}</Badge>}>
        <div className="stack-lg">
          <div className="notice"><b>Privacy.</b> When enabled, Laptop Guardian sends <b>structured metadata only</b> to Google&apos;s Gemini API: process names, paths, publishers, signatures, resource numbers, and aggregated findings. It never sends file contents, documents, passwords or tokens. Responses are schema-validated and can never run commands. Without AI everything still works.</div>
          <Switch checked={d.ai.enabled} onChange={(v) => upd((x) => { x.ai.enabled = v; })} label="Enable AI analysis" />
          <form className="grid g2" onSubmit={(e) => { e.preventDefault(); if (key) saveKey(); }} autoComplete="off">
            <Field label="API key" hint={keyOn ? 'A key is stored, encrypted with Windows DPAPI for your account. It is never shown again, never sent to this page and never committed to Git.' : 'Get a key from Google AI Studio. It is stored encrypted for your Windows account only.'}>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder={keyOn ? 'Key stored (hidden)' : 'Paste API key'} value={key} onChange={(e) => setKey(e.target.value)} style={{ flex: 1, fontFamily: 'var(--mono)' }} aria-label="Gemini API key" />
                <button type="button" className="btn icon-btn" aria-label={show ? 'Hide key' : 'Show key'} aria-pressed={show} onClick={() => setShow(!show)}><Icon name={show ? 'eyeoff' : 'eye'} /></button>
              </div>
            </Field>
            <div className="row" style={{ alignSelf: 'end' }}>
              <button type="submit" className="btn primary" disabled={!key || busy === 'key'}><Icon name="lock" size={13} />{keyOn ? 'Replace key' : 'Save key'}</button>
              <button type="button" className="btn" disabled={!keyOn || busy === 'test'} onClick={test}>{busy === 'test' ? 'Testing...' : 'Test connection'}</button>
              {keyOn && <button type="button" className="btn danger" onClick={removeKey}>Remove key</button>}
            </div>
          </form>
          {testMsg && <div className={`notice ${testMsg.ok ? 'ok' : 'crit'}`} role="status">{testMsg.text}</div>}
          <div className="grid g4">
            <Field label="Model"><input list="models" value={d.ai.model} onChange={(e) => upd((x) => { x.ai.model = e.target.value; })} /><datalist id="models">{MODELS.map((m) => <option key={m} value={m} />)}</datalist></Field>
            <Field label="Max requests per run"><input type="number" min={0} max={500} value={d.ai.maxRequestsPerRun} onChange={(e) => upd((x) => { x.ai.maxRequestsPerRun = +e.target.value; })} /></Field>
            <Field label="Max processes per run"><input type="number" min={0} max={100} value={d.ai.maxProcessesPerRun} onChange={(e) => upd((x) => { x.ai.maxProcessesPerRun = +e.target.value; })} /></Field>
            <Field label="Daily token budget"><input type="number" min={0} step={10000} value={d.ai.dailyTokenBudget} onChange={(e) => upd((x) => { x.ai.dailyTokenBudget = +e.target.value; })} /></Field>
          </div>
          <Field label="Analysis scope"><select value={d.ai.scope} onChange={(e) => upd((x) => { x.ai.scope = e.target.value; })}><option value="metadata">Metadata only (default)</option><option value="metadata+paths">Metadata and full executable paths</option></select></Field>
          <div>
            <h3 style={{ marginBottom: 6 }}>Request history</h3>
            {usage.data ? (<>
              <div className="row small t2" style={{ gap: 18 }}><span>{usage.data.totals.requests} requests</span><span>{usage.data.totals.failures} failed</span><span>{usage.data.totals.tokensToday.toLocaleString()} tokens today</span><span>{usage.data.totals.tokensAll.toLocaleString()} tokens total</span></div>
              {usage.data.requests.length === 0 ? <div className="small muted" style={{ marginTop: 6 }}>No requests yet. Gemini token pricing varies by model; check the current Google rates.</div> : (
                <div className="table-wrap" style={{ maxHeight: 200, marginTop: 8, border: '1px solid var(--line)', borderRadius: 6 }}><table className="t"><thead><tr><th>Time</th><th>Model</th><th>Kind</th><th>Result</th><th className="r">Tokens</th></tr></thead><tbody>{usage.data.requests.slice(0, 20).map((r, i) => <tr key={i}><td className="small">{fmtDate(r.ts)}</td><td className="mono">{r.model}</td><td>{r.kind}</td><td><Badge tone={r.ok ? 'ok' : 'crit'} dot>{r.ok ? 'ok' : r.error || 'failed'}</Badge></td><td className="r num">{(r.promptTokens || 0) + (r.outputTokens || 0)}</td></tr>)}</tbody></table></div>)}
            </>) : <div className="small muted">Loading...</div>}
          </div>
        </div>
      </Card>

      {/* Schedule */}
      <Card title="Schedule">
        <div className="stack-lg">
          <div className="grid g3" style={{ alignItems: 'start' }}>
            <div className="stack"><Switch checked={d.schedule.daily.enabled} onChange={(v) => upd((x) => { x.schedule.daily.enabled = v; })} label={<b>Daily audit</b>} />
              <Field label="Time"><input type="time" value={d.schedule.daily.time} onChange={(e) => upd((x) => { x.schedule.daily.time = e.target.value; })} /></Field></div>
            <div className="stack"><Switch checked={d.schedule.weekly.enabled} onChange={(v) => upd((x) => { x.schedule.weekly.enabled = v; })} label={<b>Weekly deep analysis</b>} />
              <div className="row"><Field label="Day"><select value={d.schedule.weekly.day} onChange={(e) => upd((x) => { x.schedule.weekly.day = e.target.value; })}>{DAYS.map((x) => <option key={x}>{x}</option>)}</select></Field>
                <Field label="Start"><input type="time" value={d.schedule.weekly.time} onChange={(e) => upd((x) => { x.schedule.weekly.time = e.target.value; })} /></Field></div></div>
            <div className="stack"><Switch checked={d.schedule.weekly.shutdownEnabled} onChange={(v) => upd((x) => { x.schedule.weekly.shutdownEnabled = v; })} label={<b>Weekly shutdown</b>} />
              <Field label="Target shutdown time" hint="Unfinished work is recorded as incomplete when this is reached."><input type="time" value={d.schedule.weekly.shutdownTime} onChange={(e) => upd((x) => { x.schedule.weekly.shutdownTime = e.target.value; })} /></Field></div>
          </div>
          <ScheduleRepairNotice />
          <div className="small muted">Scheduling uses Windows Task Scheduler; no Guardian process stays running. Saving a changed schedule updates the tasks; elevated tasks are never downgraded and need your permission to change. The laptop must be on (or wake for the task) at these times.{ov.data && <> Next: daily {fmtDate(ov.data.next.daily)} - weekly {fmtDate(ov.data.next.weekly)}.</>}</div>
        </div>
      </Card>

      {/* Cleanup */}
      <Card title="Cleanup">
        <div className="stack-lg">
          <div className="notice warn">Cleanup only runs when Safe mode is off. It touches clearly temporary data only. Documents, source code, installed programs, Downloads and unknown files are never deleted automatically.</div>
          <div className="grid g2">
            <Switch checked={d.cleanup.tempFiles} onChange={(v) => upd((x) => { x.cleanup.tempFiles = v; })} label="Clean temporary files" hint="Deletes files in user and Windows temp folders older than the age below. Apps using a temp file at that moment are skipped." />
            <Switch checked={d.cleanup.crashDumps} onChange={(v) => upd((x) => { x.cleanup.crashDumps = v; })} label="Clean crash dumps" hint="Removes minidumps and memory dumps. You lose the data used to diagnose a past blue screen." />
            <Switch checked={d.cleanup.caches} onChange={(v) => upd((x) => { x.cleanup.caches = v; })} label="Clean known safe caches" hint="Windows thumbnail and error-report caches. Rebuilt automatically; the first use afterwards may be slightly slower." />
            <Field label="Recycle Bin" hint="Never is safest: Guardian will not empty the Recycle Bin."><select value={d.cleanup.recycleBin} onChange={(e) => upd((x) => { x.cleanup.recycleBin = e.target.value; })}><option value="never">Never empty</option><option value="older-than-30-days">Empty items older than 30 days</option><option value="always">Empty on every run (not recommended)</option></select></Field>
            <Field label="Only clean temp files older than (days)"><input type="number" min={0} max={365} value={d.cleanup.tempMinAgeDays} onChange={(e) => upd((x) => { x.cleanup.tempMinAgeDays = +e.target.value; })} /></Field>
          </div>
        </div>
      </Card>

      {/* Process policies */}
      <Card title="Process policies">
        <div className="stack">
          {pol.data ? <div className="row" style={{ gap: 20 }}><span><b className="num">{pol.data.blacklist.length}</b> <a href="#/blacklist">blacklisted</a></span><span><b className="num">{pol.data.whitelist.length}</b> <a href="#/whitelist">whitelisted</a></span><span><b className="num">{pol.data.ignored.length}</b> ignored recommendations</span></div> : <div className="small muted">Loading...</div>}
          <Switch checked={d.safety.autoKillBlacklisted} onChange={(v) => safety('autoKillBlacklisted', v)} label="Automatically terminate blacklisted processes" hint="Only entries on your blacklist. Unknown processes are never terminated automatically." />
          <div className="grid g4">
            <Field label="Flag CPU above (%)"><input type="number" min={1} max={100} value={d.thresholds.cpuPct} onChange={(e) => upd((x) => { x.thresholds.cpuPct = +e.target.value; })} /></Field>
            <Field label="Flag memory above (MB)"><input type="number" min={50} value={d.thresholds.memoryMB} onChange={(e) => upd((x) => { x.thresholds.memoryMB = +e.target.value; })} /></Field>
          </div>
        </div>
      </Card>

      {/* Storage */}
      <Card title="Storage scanning">
        <div className="grid g2">
          <Field label="Scanned drives" hint="One per line, e.g. C:"><Lines value={d.storage.drives} onChange={(v) => upd((x) => { x.storage.drives = v; })} rows={2} /></Field>
          <Field label="Excluded directories" hint="Never scanned."><Lines value={d.storage.excludedDirs} onChange={(v) => upd((x) => { x.storage.excludedDirs = v; })} rows={2} placeholder="D:\Games" /></Field>
          <Field label="Protected directories" hint="Scanned for reporting but never recommended for removal."><Lines value={d.storage.protectedDirs} onChange={(v) => upd((x) => { x.storage.protectedDirs = v; })} rows={2} placeholder="C:\Users\You\Documents" /></Field>
          <div className="grid g2" style={{ alignContent: 'start' }}>
            <Field label="Minimum large file (MB)"><input type="number" min={1} value={d.storage.minLargeFileMB} onChange={(e) => upd((x) => { x.storage.minLargeFileMB = +e.target.value; })} /></Field>
            <Field label="Old file after (days)"><input type="number" min={1} value={d.storage.oldFileDays} onChange={(e) => upd((x) => { x.storage.oldFileDays = +e.target.value; })} /></Field>
            <Field label="Duplicate minimum (MB)"><input type="number" min={1} value={d.storage.duplicateMinMB} onChange={(e) => upd((x) => { x.storage.duplicateMinMB = +e.target.value; })} /></Field>
            <div style={{ alignSelf: 'end' }}><Switch checked={d.storage.duplicateScan} onChange={(v) => upd((x) => { x.storage.duplicateScan = v; })} label="Scan for duplicates" /></div>
          </div>
        </div>
      </Card>

      <Card title="Retention">
        <div className="grid g3">
          {(['reportsDays', 'metricsDays', 'actionsDays'] as const).map((k) => <Field key={k} label={`Keep ${k.replace('Days', '')} for (days)`} hint="0 keeps everything forever."><input type="number" min={0} value={d.retention[k]} onChange={(e) => upd((x) => { x.retention[k] = +e.target.value; })} /></Field>)}
        </div>
      </Card>

      <div style={{ position: 'sticky', bottom: 0, background: 'var(--bg)', borderTop: '1px solid var(--line)', padding: '10px 0', display: 'flex', gap: 10, alignItems: 'center', zIndex: 10 }}>
        <button className="btn primary" disabled={!dirty || busy === 'save'} onClick={() => save()}>{busy === 'save' ? 'Saving...' : 'Save changes'}</button>
        <button className="btn" disabled={!dirty} onClick={() => setD(clone(cfgQ.data!))}>Discard</button>
        <span className="small muted">{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
      </div>
      {node}
    </div>
  );
}
