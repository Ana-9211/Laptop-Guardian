import { useEffect, useRef, useState } from 'react';
import { api, ApiError, bridge, useQuery } from '../api';
import type { Config, Policy } from '../types';
import { Badge, ErrorState, Icon, PageHead, SkeletonCards, Switch, useConfirm, useToast } from '../components/ui';
import { useOverview } from '../state/overview';
import { useStatus } from '../state/StatusProvider';
import { setNavGuard } from '../router';
import { clone, strip, type Draft } from '../components/settings/fields';
import { AiCard } from '../components/settings/AiCard';
import { ScheduleCard } from '../components/settings/ScheduleCard';
import { CleanupCard } from '../components/settings/CleanupCard';
import { PolicyCard } from '../components/settings/PolicyCard';
import { StorageCard } from '../components/settings/StorageCard';
import { RetentionCard } from '../components/settings/RetentionCard';
import { SafeModePreview } from '../components/Guidance';
import { DiagnosticsCard } from '../components/settings/DiagnosticsCard';

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
  const [liveModels, setLiveModels] = useState<string[]>([]);

  useEffect(() => {
    const c = cfgQ.data; if (!c) return;
    // Keep unsaved edits when only a safety toggle (applied immediately) caused the reload.
    setD((cur) => (cur && JSON.stringify(strip(cur)) !== saved ? { ...cur, safety: clone(c.safety), _ai: c._ai } : clone(c)));
    setSaved(JSON.stringify(strip(c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgQ.data]);
  const dirty = d ? JSON.stringify(strip(d)) !== saved : false;
  // Unsaved edits are not lost silently: leaving the page, or closing the window, asks first.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    setNavGuard((next) => !dirtyRef.current || next.startsWith('/settings') || window.confirm('You have unsaved changes in Settings. Leave without saving?'));
    const beforeUnload = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { setNavGuard(null); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);
  if (cfgQ.error) return <div className="page"><ErrorState error={cfgQ.error} onRetry={cfgQ.reload} /></div>;
  if (!d) return <div className="page"><PageHead title="Settings" /><SkeletonCards n={4} /></div>;

  const upd = (fn: (x: Draft) => void) => setD((cur) => { const n = clone(cur!); fn(n); return n; });
  const keyOn = cfgQ.data?._ai?.keyConfigured;

  /** Saves settings. When the bridge says a change lowers a safety margin it is asked about first and only then re-sent as confirmed. Returns false while that question is open. */
  const putConfig = async (body: Record<string, unknown>, confirmed = false): Promise<boolean> => {
    try { await api.put('/api/config', confirmed ? { ...body, _confirmRisky: true } : body); return true; } catch (e) {
      const err = e as ApiError;
      if (!err.needsConfirmation.length) throw e;
      confirm({
        title: 'Lower a safety margin?', confirmLabel: 'Apply this change', danger: true,
        body: <><p>This change reduces a protection:</p><ul>{err.needsConfirmation.map((t) => <li key={t}>{t}</li>)}</ul></>,
        onConfirm: async () => { try { await api.put('/api/config', { ...body, _confirmRisky: true }); toast('ok', 'Settings saved.'); cfgQ.reload(); ov.reload(); } catch (e2) { toast('error', (e2 as ApiError).message); if (cfgQ.data) setD(clone(cfgQ.data)); } },
      });
      return false;
    }
  };
  const save = async (immediate?: Partial<Config>) => {
    setBusy('save');
    try {
      const body = strip(immediate ? { ...d, ...immediate } as Config : d) as Record<string, unknown>;
      const { schedule, ...rest } = body;
      if (!(await putConfig(rest))) return;
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
  const safety = async (k: keyof Config['safety'], v: boolean, confirmed = false) => {
    upd((x) => { x.safety[k] = v; });
    try { if (await putConfig({ safety: { [k]: v } }, confirmed)) { toast('ok', 'Safety setting applied.'); cfgQ.reload(); ov.reload(); } else upd((x) => { x.safety[k] = !v; }); } catch (e) { toast('error', (e as ApiError).message); upd((x) => { x.safety[k] = !v; }); }
  };
  /** One switch for the weekly shutdown: both the safety gate and the schedule flag move together, so the page can never show "on" while the run would not shut down. */
  const shutdownSwitch = async (v: boolean) => {
    upd((x) => { x.safety.weeklyShutdown = v; x.schedule.weekly.shutdownEnabled = v; });
    try { if (await putConfig({ safety: { weeklyShutdown: v }, schedule: { weekly: { shutdownEnabled: v } } })) { toast('ok', v ? 'The weekly run may shut the laptop down.' : 'The weekly run will leave the laptop on.'); cfgQ.reload(); ov.reload(); } }
    catch (e) { toast('error', (e as ApiError).message); upd((x) => { x.safety.weeklyShutdown = !v; x.schedule.weekly.shutdownEnabled = !v; }); }
  };
  const aiCall = async (name: string, fn: () => Promise<void>) => { setBusy(name); try { await fn(); } catch (e) { toast('error', (e as ApiError).message); } finally { setBusy(''); } };
  const saveKey = () => aiCall('key', async () => { await api.post('/api/ai/key', { key }); setKey(''); setShow(false); toast('ok', 'API key stored, encrypted for your Windows account.'); cfgQ.reload(); ov.reload(); });
  const removeKey = () => confirm({ title: 'Remove the Gemini API key?', confirmLabel: 'Remove key', danger: true, body: 'AI analysis will stop working until you add a key again. Everything else keeps working.', onConfirm: () => aiCall('key', async () => { await api.del('/api/ai/key'); toast('ok', 'Key removed.'); cfgQ.reload(); ov.reload(); }) });
  const test = () => aiCall('test', async () => { setTestMsg(null); try { const r = await api.post<{ ok: boolean; message?: string; model?: string; latencyMs?: number; error?: string; models?: string[] }>('/api/ai/test'); if (r.models && r.models.length) setLiveModels(r.models); setTestMsg({ ok: r.ok, text: r.ok ? `Connected${r.model ? ` to ${r.model}` : ''}${r.latencyMs ? ` in ${r.latencyMs} ms` : ''}.` : r.error || 'Connection failed.' }); } catch (e) { setTestMsg({ ok: false, text: (e as ApiError).message }); } usage.reload(); });

  return (
    <div className="page">
      <PageHead title="Settings" sub="Changes to safety controls apply immediately. Other changes apply when you save." />

      {/* Safety */}
      <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--accent) 50%, var(--line))' }}>
        <header className="card-head"><Icon name="shield" /><h2>Safety</h2>{d.safety.safeMode ? <Badge tone="accent" dot>Safe mode on</Badge> : <Badge tone="warn" dot>Safe mode off</Badge>}</header>
        <div className="card-body stack-lg">
          <div className="safety-banner">
            <Switch checked={d.safety.safeMode} onChange={(v) => (v ? safety('safeMode', true) : confirm({ title: 'Turn off safe mode?', confirmLabel: 'Turn off safe mode', danger: true, body: 'Agents will be allowed to perform the cleanup and blacklisted-process termination you configured. Unknown processes and personal files are still never touched automatically.', onConfirm: () => safety('safeMode', false, true) }))}
              label={<b>Safe mode</b>} hint="Observe and recommend only. No process is terminated and nothing is cleaned automatically." />
          </div>
          <SafeModePreview />
          <div className="grid g2">
            <Switch checked={d.safety.autoKillBlacklisted} onChange={(v) => safety('autoKillBlacklisted', v)} label="Automatically terminate blacklisted processes" hint="Daily agent only, and only entries on your blacklist. Needs Safe mode off. Turning it on asks you to confirm." />
            <Switch checked={d.safety.automationPaused} onChange={(v) => safety('automationPaused', v)} label="Pause automation" hint="Scheduled runs still observe and report; no automatic actions." />
            <Switch checked={d.safety.weeklyShutdown && d.schedule.weekly.shutdownEnabled} onChange={(v) => void shutdownSwitch(v)} label="Shut down after the weekly run" hint="Only the scheduled weekly run can do this, and Windows closes open programs when it does. Turn off to leave the laptop on." />
          </div>
        </div>
      </div>

      <AiCard d={d} upd={upd} keyOn={keyOn} keyText={key} setKey={setKey} show={show} setShow={setShow} busy={busy} testMsg={testMsg} liveModels={liveModels} usage={usage} saveKey={saveKey} removeKey={removeKey} test={test} />

      <ScheduleCard d={d} upd={upd} ov={ov} />

      <CleanupCard d={d} upd={upd} />

      <PolicyCard d={d} upd={upd} pol={pol} />

      <StorageCard d={d} upd={upd} />

      <RetentionCard d={d} upd={upd} />

      <DiagnosticsCard />


      <div style={{ position: 'sticky', bottom: 0, background: 'var(--bg)', borderTop: '1px solid var(--line)', padding: '10px 0', display: 'flex', gap: 10, alignItems: 'center', zIndex: 10 }}>
        <button className="btn primary" disabled={!dirty || busy === 'save'} onClick={() => save()}>{busy === 'save' ? 'Saving...' : 'Save changes'}</button>
        <button className="btn" disabled={!dirty} onClick={() => setD(clone(cfgQ.data!))}>Discard</button>
        <span className="small muted">{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
      </div>
      {node}
    </div>
  );
}
