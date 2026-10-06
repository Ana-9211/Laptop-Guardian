import { useState } from 'react';
import { api, ApiError, useQuery } from '../api';
import type { ActionEvent, Process, Recommendation } from '../types';
import { Badge, CommandBlock, Drawer, KV, RiskBadge, TextCommand, useConfirm, useToast, Card, Skeleton, Icon } from './ui';
import { ConfirmDialog } from './ui';
import { ActionTimeline } from './common';
import { fmtFull, fmtMB, pct, NA, toUtcSeconds } from '../format';
import { useActionFlow } from './ActionFlow';
import { RecFixes } from './RecFixes';
import { useOverview } from '../state/overview';
import { confidenceLabel, processClassLabel } from '../labels';

/** Adds a process to blacklist / whitelist / ignored with a user-supplied reason. */
export function PolicyDialog({ list, name, path, recId, onClose, onDone }: { list: 'blacklist' | 'whitelist' | 'ignored'; name: string; path?: string | null; recId?: string | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const toast = useToast();
  const copy = {
    blacklist: { title: `Blacklist ${name}?`, verb: 'Add to blacklist', danger: true, body: <>Future daily runs will <b>automatically terminate</b> <code>{name}</code>{path ? <> when it runs from <code>{path}</code></> : <> wherever it runs</>}. Unsaved work in it will be lost. Automation does nothing while Safe mode or &quot;Pause automation&quot; is on. You can remove or temporarily disable the entry on the Blacklist page.</> },
    whitelist: { title: `Whitelist ${name}?`, verb: 'Add to whitelist', danger: false, body: <>Laptop Guardian will stop flagging and recommending <code>{name}</code>. It will still be listed in the process table.</> },
    ignored: { title: `Ignore ${name}?`, verb: 'Ignore recommendation', danger: false, body: <>This recommendation is hidden from the inbox. The process is not changed and will reappear in the process table.</> },
  }[list];
  const submit = async () => {
    try {
      await api.post('/api/policy', { list, name, path: path || undefined, reason: reason || undefined, recommendationId: recId || undefined });
      if (recId && list !== 'blacklist') await api.post(`/api/recommendations/${recId}/status`, { status: list === 'ignored' ? 'ignored' : 'actioned' }).catch(() => {});
      toast('ok', `${name} ${list === 'blacklist' ? 'blacklisted' : list === 'whitelist' ? 'whitelisted' : 'ignored'}.`);
      onDone();
    } catch (e) { toast('error', (e as ApiError).message); }
  };
  return (
    <ConfirmDialog onClose={onClose} opts={{
      title: copy.title, confirmLabel: copy.verb, danger: copy.danger, onConfirm: submit,
      body: <div className="stack"><div>{copy.body}</div><label className="field"><span>Reason (recorded in the action log)</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" maxLength={300} /></label></div>,
    }} />
  );
}

function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return <Card title={title} actions={actions}>{children}</Card>;
}

export function ProcessDrawer({ proc, rec, onClose, onChanged, back }: { proc: Process; rec?: Recommendation | null; onClose: () => void; onChanged: () => void; back?: { to: string; label: string } | null }) {
  const toast = useToast();
  const ov = useOverview();
  const { confirm, node } = useConfirm();
  const [dlg, setDlg] = useState<null | 'blacklist' | 'whitelist' | 'ignored'>(null);
  const [showHist, setShowHist] = useState(false);
  const [ai, setAi] = useState<Recommendation['ai']>(rec?.ai || null);
  const [aiBusy, setAiBusy] = useState(false);
  const hist = useQuery<{ appearances: { ts: string; cpuPct: number; memoryMB: number; flags: string[] }[]; actions: ActionEvent[] }>(showHist ? `/api/processes/history?name=${encodeURIComponent(proc.name)}` : null);
  const aiOn = ov.data?.ai.enabled && ov.data.ai.keyConfigured;

  const flow = useActionFlow(onChanged);
  // Stopping goes through the confirmed Action flow: live identity (PID, start time, path) is re-checked right before it runs.
  const stop = () => void flow.run('process.stop', { pid: proc.pid, name: proc.name.replace(/.exe$/i, ''), ...(proc.path ? { path: proc.path } : {}), ...(proc.startTime ? { startTime: toUtcSeconds(proc.startTime) } : {}) }, 'Stop process');
  const analyze = async () => {
    if (!rec) return;
    setAiBusy(true);
    try { const r = await api.post<{ ai?: Recommendation['ai'] } & Recommendation['ai']>('/api/ai/analyze', { recommendationId: rec.id }); setAi(r?.ai || r || null); toast('ok', 'AI analysis received and validated.'); onChanged(); }
    catch (e) { toast('error', `AI analysis unavailable: ${(e as ApiError).message}`); } finally { setAiBusy(false); }
  };
  const flags = proc.flags || [];
  const mech = rec?.persistence?.mechanisms?.length ? rec.persistence.mechanisms : (proc.startupEntries || []).map((s) => ({ kind: s.kind, name: s.name, location: s.location }));

  return (
    <>
      <Drawer onClose={onClose} back={back}
        title={<span className="row" style={{ gap: 10 }}>{proc.name}<span className="muted num" style={{ fontSize: 13, fontWeight: 400 }}>PID {proc.pid}</span></span>}
        sub={<span className="row tight">{proc.signed ? <Badge tone="ok" dot>Signed - {proc.publisher}</Badge> : <Badge tone="warn" dot>Unsigned</Badge>}<Badge>{processClassLabel(proc.classification)}</Badge>{proc.persistent && <Badge tone="info">Persistent</Badge>}{proc.policy && proc.policy !== 'none' && <Badge tone={proc.policy === 'blacklist' ? 'crit' : 'accent'}>{proc.policy}</Badge>}</span>}
        footer={<>
          <button className="btn danger" onClick={stop}><Icon name="x" size={13} />Stop process</button>
          <button className="btn danger" onClick={() => setDlg('blacklist')} disabled={proc.policy === 'blacklist'}><Icon name="blacklist" size={13} />Blacklist</button>
          <button className="btn" onClick={() => setDlg('whitelist')} disabled={proc.policy === 'whitelist'}><Icon name="whitelist" size={13} />Whitelist</button>
          <button className="btn" onClick={() => setDlg('ignored')}>Ignore</button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => { onChanged(); toast('info', 'Reloaded latest scan data.'); }}><Icon name="refresh" size={13} />Refresh</button>
          <button className="btn" onClick={() => setShowHist(true)}>View history</button>
        </>}>
        {rec && (
          <Section title="Recommendation" actions={<span className="row tight"><RiskBadge risk={rec.risk} /><Badge title="How certain the analysis is. Separate from risk." tone="outline">{confidenceLabel(rec.confidence)}</Badge><Badge tone="accent">{rec.suggestedAction}</Badge></span>}>
            <div className="stack">
              <div><b>What is it?</b><p className="t2">{rec.whatIsIt || 'No description available.'}</p></div>
              <div><b>Why was it flagged?</b><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{(rec.whyFlagged || []).map((w) => <li key={w}>{w}</li>)}</ul></div>
              <div className="notice">Unfamiliar does not mean malicious. Risk reflects what Guardian could verify locally; unknown stays UNKNOWN.</div>
            </div>
          </Section>
        )}
        <Section title="Fix options" actions={<a className="small" href={rec ? `#/actions?finding=${encodeURIComponent(`rec:${rec.id}`)}` : '#/actions'}>Open in Action Center</a>}>
          {rec ? <RecFixes recId={rec.id} flow={flow} /> : <p className="t2 small">Use <b>Stop process</b> below to end this one instance after a confirmation that re-checks it. There is no recommendation with restart options for this process.</p>}
        </Section>
        <Section title="Identity">
          <KV items={[['Process', proc.name], ['PID', proc.pid], ['Executable', <code key="p">{proc.path || 'inaccessible'}</code>], ['Command line', proc.commandLine ? <code key="c">{proc.commandLine}</code> : 'inaccessible'], ['Publisher', proc.publisher || 'none'], ['Signature', proc.signature], ['User', proc.user], ['Started', fmtFull(proc.startTime)], ['Path class', proc.pathClass], ['Instances', proc.instances]]} />
        </Section>
        <Section title="Resource usage">
          <div className="grid g3"><div><div className="muted small">CPU</div><b className="num">{pct(proc.cpuPct, 1)}</b></div><div><div className="muted small">Memory</div><b className="num">{fmtMB(proc.memoryMB)}</b></div><div><div className="muted small">CPU time</div><b className="num">{proc.cpuSeconds != null ? `${Math.round(proc.cpuSeconds)} s` : NA}</b></div></div>
          {flags.length > 0 && <div className="row tight" style={{ marginTop: 10 }}>{flags.map((f) => <Badge key={f} tone={/cpu|memory|unusual|unsigned|no-pub|blacklisted/.test(f) ? 'warn' : ''}>{f}</Badge>)}</div>}
        </Section>
        <Section title="Parent, startup and services">
          <KV items={[['Parent', proc.parentName ? `${proc.parentName} (PID ${proc.parentPid})` : proc.parentPid ?? NA], ['Services', (proc.services || []).join(', ') || 'none'], ['Scheduled tasks', (proc.scheduledTasks || []).join(', ') || 'none'],
            ['Startup mechanisms', mech.length ? <div key="m" className="stack" style={{ gap: 4 }}>{mech.map((m, i) => <div key={i}><Badge>{m.kind}</Badge> <b>{m.name}</b> <span className="muted">{m.location}</span></div>)}</div> : 'none found']]} />
          <div className="small muted" style={{ marginTop: 8 }}>{mech.length ? 'This process can restart after it is stopped.' : 'No restart mechanism was identified. It may be launched by another program.'}</div>
        </Section>
        {rec?.stopCommand && <CommandBlock title="Stop it temporarily" cmd={rec.stopCommand} />}
        {rec?.preventRestart && <CommandBlock title="Prevent it from restarting" cmd={rec.preventRestart} />}
        {rec && !rec.stopCommand && !rec.preventRestart && <div className="notice">No verified stop or prevent-restart procedure is available for this recommendation.</div>}
        {rec?.consequences && <Section title="Consequences"><p className="t2">{rec.consequences}</p></Section>}
        <Section title="AI analysis" actions={ai && <Badge tone="info">{ai.model || 'Gemini'} - validated</Badge>}>
          {ai ? (
            <div className="stack">
              <div className="row tight"><RiskBadge risk={ai.risk} /><Badge tone="outline">AI: {confidenceLabel(ai.confidence)}</Badge>{ai.classification && <Badge>{processClassLabel(ai.classification)}</Badge>}</div>
              <KV items={[['What it is', ai.what_is_it], ['Why flagged', ai.why_flagged], ['Persistence', ai.persistence], ['Suggested action', ai.suggested_action], ['Consequences', ai.consequences]]} />
              {ai.evidence && ai.evidence.length > 0 && <div><div className="muted small">Evidence</div><div className="row tight">{ai.evidence.map((e) => <Badge key={e} tone="outline">{e}</Badge>)}</div></div>}
              {ai.warnings?.map((w) => <div key={w} className="notice warn">{w}</div>)}
              {ai.temporary_stop_method && <TextCommand title="AI-suggested stop method" text={ai.temporary_stop_method} />}
              {ai.persistence_removal_method && <TextCommand title="AI-suggested persistence removal" text={ai.persistence_removal_method} />}
            </div>
          ) : (
            <div className="stack">
              <p className="t2">No AI analysis for this process. Local analysis above is deterministic and works without Gemini.</p>
              {rec && <div className="row"><button className="btn" disabled={!aiOn || aiBusy} onClick={() => confirm({ title: 'Send to Gemini?', confirmLabel: 'Send metadata', body: <div className="stack"><p>This sends <b>structured metadata only</b> about this process to Google&apos;s Gemini API: name, path, publisher, signature, CPU/memory, startup and service associations.</p><p>No file contents, documents or credentials are sent. The response is validated locally and can never run commands.</p></div>, onConfirm: analyze })}>{aiBusy ? 'Analyzing...' : 'Analyze with Gemini'}</button>{!aiOn && <span className="small muted">Enable AI and add a key in Settings.</span>}</div>}
              {aiBusy && <Skeleton h={40} />}
            </div>
          )}
        </Section>
        {showHist && (
          <Section title="History">
            {hist.loading ? <Skeleton h={60} /> : hist.error ? <div className="notice crit">{hist.error.message}</div> : (
              <div className="stack">
                <div className="small muted">Appeared in {hist.data?.appearances.length || 0} recent daily reports as a top resource user.</div>
                {hist.data?.appearances.slice(0, 8).map((a) => <div key={a.ts} className="row spread small"><span>{fmtFull(a.ts)}</span><span className="num">{pct(a.cpuPct, 1)} CPU - {fmtMB(a.memoryMB)}</span></div>)}
                <b>Actions</b>
                {hist.data?.actions.length ? <ActionTimeline rows={hist.data.actions} max={10} /> : <div className="muted small">No logged actions target this process.</div>}
              </div>
            )}
          </Section>
        )}
      </Drawer>
      {dlg && <PolicyDialog list={dlg} name={proc.name} path={dlg === 'blacklist' ? proc.path : null} recId={rec?.id} onClose={() => setDlg(null)} onDone={() => { setDlg(null); onChanged(); }} />}
      {node}
      {flow.node}
    </>
  );
}
