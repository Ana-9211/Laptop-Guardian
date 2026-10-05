import { ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, remediation } from '../api';
import type { ExecResponse, Plan } from '../types';
import { ACTION_POLL_MS } from '../config';
import { Badge, Icon, KV, RiskBadge, useOverlay } from './ui';

/**
 * The one confirmation-and-result flow for every fix. It always goes plan -> explicit confirmation of THAT plan -> execute ->
 * verified result. Nothing runs from a button press alone, and the dialog states the exact effect, impact, reversibility,
 * administrator need and the allowlisted action id before the user can confirm.
 */
type Phase =
  | { name: 'idle' }
  | { name: 'planning'; label: string }
  | { name: 'refused'; label: string; message: string; reasons: string[] }
  | { name: 'confirm'; plan: Plan; acks: string[]; busy: boolean }
  | { name: 'waiting'; plan: Plan; ticket: string; status: 'awaiting-permission' | 'running' }
  | { name: 'result'; plan: Plan; response: ExecResponse };

const ACK_TEXT: Record<string, string> = {
  'unsaved-work': 'I have saved my work in that program. Anything unsaved will be lost.',
  'dependent-programs': 'I understand programs that depend on this service may stop working until it is re-enabled.',
};
const ADMIN_TEXT = { yes: 'Needs administrator permission', maybe: 'May need administrator permission', no: 'No administrator permission needed' } as const;

const paramRows = (p: Record<string, string | number>): [string, ReactNode][] => Object.entries(p).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, <code key={k}>{String(v)}</code>]);

function statusView(r: ExecResponse): { tone: 'ok' | 'warn' | 'crit' | 'info'; title: string } {
  switch (r.status) {
    case 'done': return { tone: 'ok', title: 'Done and verified' };
    case 'done-unverified': return { tone: 'warn', title: 'Started, not yet verified' };
    case 'declined': return { tone: 'warn', title: 'Not changed: permission was not granted' };
    case 'lost': return { tone: 'crit', title: 'No result was reported' };
    default: return { tone: 'crit', title: 'Failed: nothing was verified' };
  }
}

export function useActionFlow(onDone?: () => void) {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const close = useCallback(() => {
    setPhase((p) => { if (p.name === 'confirm') void remediation.cancel(p.plan.token).catch(() => undefined); return { name: 'idle' }; });
  }, []);

  const showPlan = useCallback((plan: Plan) => setPhase({ name: 'confirm', plan, acks: [], busy: false }), []);
  const run = useCallback(async (actionId: string, params: Record<string, string | number>, label = 'Checking') => {
    setPhase({ name: 'planning', label });
    try { showPlan(await remediation.plan(actionId, params)); }
    catch (e) { const err = e as ApiError; setPhase({ name: 'refused', label, message: err.message, reasons: err.errors.length ? err.errors : [err.message] }); }
  }, [showPlan]);
  const runUndo = useCallback(async (eventId: string) => {
    setPhase({ name: 'planning', label: 'Preparing undo' });
    try { showPlan(await remediation.undo(eventId)); }
    catch (e) { const err = e as ApiError; setPhase({ name: 'refused', label: 'Undo', message: err.message, reasons: err.errors.length ? err.errors : [err.message] }); }
  }, [showPlan]);

  const settle = useCallback((plan: Plan, response: ExecResponse) => {
    if (response.status === 'needs-elevation' && response.plan) { showPlan(response.plan); return; }
    setPhase({ name: 'result', plan, response });
    doneRef.current?.();
  }, [showPlan]);

  const confirm = useCallback(async () => {
    if (phase.name !== 'confirm') return;
    const { plan, acks } = phase;
    setPhase({ ...phase, busy: true });
    try {
      const r = await remediation.execute(plan.token, acks);
      if (r.status === 'awaiting-permission' && r.ticket) setPhase({ name: 'waiting', plan, ticket: r.ticket, status: 'awaiting-permission' });
      else if (r.status === 'awaiting-schedule-permission') settle(plan, { ...r, status: 'done-unverified' });
      else settle(plan, r);
    } catch (e) { settle(plan, { status: 'failed', result: { ok: false, errors: [(e as ApiError).message] } }); }
  }, [phase, settle]);

  // While Windows is showing its permission prompt (or the elevated run is working) poll the one fixed result file.
  const ticket = phase.name === 'waiting' ? phase.ticket : null;
  const waitingPlan = phase.name === 'waiting' ? phase.plan : null;
  useEffect(() => {
    if (!ticket || !waitingPlan) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await remediation.result(ticket);
        if (stop) return;
        if (r.status === 'awaiting-permission' || r.status === 'running') setPhase((p) => (p.name === 'waiting' ? { ...p, status: r.status as 'awaiting-permission' | 'running' } : p));
        else settle(waitingPlan, r);
      } catch (e) { if (!stop) settle(waitingPlan, { status: 'failed', result: { ok: false, errors: [(e as ApiError).message] } }); }
    };
    const t = setInterval(() => { void tick(); }, ACTION_POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [ticket, waitingPlan, settle]);

  const node = phase.name === 'idle' ? null : (
    <FlowDialog phase={phase} onClose={close}
      onAck={(a, on) => setPhase((p) => (p.name === 'confirm' ? { ...p, acks: on ? [...p.acks, a] : p.acks.filter((x) => x !== a) } : p))}
      onConfirm={() => void confirm()} onFollowUp={(id, params) => void run(id, params)} />
  );
  return { run, runUndo, node, active: phase.name !== 'idle' };
}

interface DialogProps { phase: Exclude<Phase, { name: 'idle' }>; onClose: () => void; onAck: (a: string, on: boolean) => void; onConfirm: () => void; onFollowUp: (actionId: string, params: Record<string, string | number>) => void }

function FlowDialog({ phase, onClose, onAck, onConfirm, onFollowUp }: DialogProps) {
  const ref = useOverlay(onClose);
  const tid = useId();
  let title = ''; let body: ReactNode = null; let foot: ReactNode = null;

  if (phase.name === 'planning') {
    title = phase.label; body = <div className="row"><span className="spin"><Icon name="refresh" size={16} /></span><span>Re-checking the live target before asking you to confirm...</span></div>;
    foot = <button className="btn" onClick={onClose} data-autofocus>Cancel</button>;
  } else if (phase.name === 'refused') {
    title = 'Guardian will not do this';
    body = <div className="stack"><div className="notice crit" role="alert"><b>{phase.message}</b></div>{phase.reasons.length > 1 && <ul className="plain-list">{phase.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}<p className="small muted">Nothing was changed. This check protects you: protected Windows and security targets, and anything that changed since you looked, are refused even with confirmation.</p></div>;
    foot = <button className="btn primary" onClick={onClose} data-autofocus>Close</button>;
  } else if (phase.name === 'confirm') {
    const p = phase.plan; const allAcked = p.requiredAcks.every((a) => phase.acks.includes(a));
    title = p.label;
    body = (
      <div className="stack-lg">
        <div className="row"><RiskBadge risk={String(p.risk)} /><Badge tone={p.adminRequired ? 'warn' : 'ok'}>{ADMIN_TEXT[p.adminRequired ? 'yes' : 'no']}</Badge><Badge tone={p.reversible ? 'ok' : 'crit'}>{p.reversible ? 'Reversible' : 'Not reversible'}</Badge></div>
        <section><div className="eyebrow">What will happen</div><p>{p.summary}</p></section>
        <section><div className="eyebrow">Impact</div><p className="t2">{p.consequences}</p></section>
        <section><div className="eyebrow">{p.reversible ? 'How to undo' : 'Undo'}</div><p className="t2">{p.undo}</p></section>
        {p.adminRequired && <div className="notice warn"><b>Windows will ask for permission.</b> Guardian runs only this one allowlisted action elevated, then closes it. If you decline, nothing changes.</div>}
        <details className="exact"><summary>Exact action</summary><KV items={[['Action', <code key="a">{p.actionId}</code>], ...paramRows(p.params)]} /><p className="small muted">This is a fixed Guardian action, not a command. Parameters are validated and the live target is checked again immediately before it runs.</p></details>
        {p.requiredAcks.map((a) => <label key={a} className="ack"><input type="checkbox" checked={phase.acks.includes(a)} onChange={(e) => onAck(a, e.target.checked)} /><span>{ACK_TEXT[a] || a}</span></label>)}
      </div>
    );
    foot = (<><button className="btn" onClick={onClose} data-autofocus>Cancel</button><button className={`btn ${p.risk === 'HIGH' || p.risk === 'MEDIUM' ? 'danger solid' : 'primary'}`} disabled={!allAcked || phase.busy} onClick={onConfirm}>{phase.busy ? 'Working...' : p.confirmLabel}</button></>);
  } else if (phase.name === 'waiting') {
    title = phase.plan.label;
    body = (
      <div className="stack"><div className="row"><span className="spin"><Icon name="refresh" size={16} /></span><b>{phase.status === 'running' ? 'Running with administrator permission...' : 'Waiting for you to approve the Windows prompt'}</b></div>
        <p className="t2 small">{phase.status === 'running' ? (phase.plan.long ? 'This can take several minutes. You can close this window; the result is saved in the Action Center history.' : 'This should only take a moment.') : 'Check the taskbar for the permission window. If you decline it or do not answer, nothing is changed.'}</p></div>
    );
    foot = <button className="btn" onClick={onClose} data-autofocus>Hide</button>;
  } else {
    const r = phase.response; const v = statusView(r); const res = r.result;
    const reasons = (res && res.errors && res.errors.length ? res.errors : []).concat(r.message && !res ? [r.message] : []);
    title = phase.plan.label;
    body = (
      <div className="stack-lg">
        <div className={`notice ${v.tone === 'info' ? '' : v.tone}`} role={v.tone === 'crit' ? 'alert' : 'status'}><b>{v.title}</b>{res?.message && <div>{res.message}</div>}{reasons.map((m) => <div key={m}>{m}</div>)}</div>
        <div className="row"><Badge tone={res?.verified ? 'ok' : 'warn'}>{res?.verified ? 'Verified by reading the system back' : 'Not verified'}</Badge></div>
        {phase.plan.reversible && res?.ok && <p className="t2 small"><b>To undo:</b> {phase.plan.undo}</p>}
        {!phase.plan.reversible && res?.ok && <p className="t2 small"><b>Undo:</b> {phase.plan.undo}</p>}
        {phase.plan.actionId === 'app.revo-launch' && res?.ok && <p className="small">When you finish in Revo, use <b>Check that it is gone</b>. Guardian only reports the uninstall as successful when it can see that the program is gone.</p>}
      </div>
    );
    foot = (<>
      {phase.plan.actionId === 'app.revo-launch' && res?.ok && <button className="btn" onClick={() => onFollowUp('app.verify-removed', { appName: String(phase.plan.params.appName) })}>Check that it is gone</button>}
      <button className="btn primary" onClick={onClose} data-autofocus>Close</button></>);
  }

  return (
    <>
      <div className="scrim" style={{ zIndex: 65 }} onClick={phase.name === 'confirm' || phase.name === 'refused' || phase.name === 'result' ? onClose : undefined} />
      <div className="dialog wide" role="alertdialog" aria-modal="true" aria-labelledby={tid} ref={ref} tabIndex={-1}>
        <div className="card-body"><h2 id={tid}>{title}</h2>{body}</div>
        <div className="dialog-foot">{foot}</div>
      </div>
    </>
  );
}

/** A button that starts a plan for one offer. The label is the catalog label; it never says just "Fix". */
export function ActionButton({ actionId, params, label, tone, disabled, title, flow, icon }: { actionId: string; params: Record<string, string | number>; label: string; tone?: 'danger' | 'primary'; disabled?: boolean; title?: string; flow: ReturnType<typeof useActionFlow>; icon?: Parameters<typeof Icon>[0]['name'] }) {
  return <button className={`btn sm ${tone || ''}`} disabled={disabled} title={title} onClick={() => void flow.run(actionId, params, label)}>{icon && <Icon name={icon} size={13} />}{label}</button>;
}
