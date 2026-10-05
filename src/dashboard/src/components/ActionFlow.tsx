import { ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { ApiError, remediation } from '../api';
import type { ExecResponse, Plan } from '../types';
import { ACTION_POLL_MS } from '../config';
import { addBackground } from '../state/background';
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
  connectivity: 'I understand this can stop the program, port or address from using the network, and that I can remove the rule from Network Guard.',
  'allow-exposure': 'I understand an allow rule lets this program through the firewall on private and domain networks, and that I should only allow programs I trust.',
  'suspicious-lookalike': 'I understand this program uses the name of a Windows system process but is not the real one. I want to stop it anyway.',
  'dns-limits': 'I understand blocking is by exact host name only, and programs that use their own encrypted DNS can bypass it.',
};
const ADMIN_TEXT = { yes: 'Needs administrator permission', no: 'No administrator permission needed' } as const;
/** A poll that fails this many times in a row is reported as "lost contact", never as a failed action. */
const MAX_POLL_ERRORS = 5;

const paramRows = (p: Record<string, string | number>): [string, ReactNode][] => Object.entries(p).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, <code key={k}>{String(v)}</code>]);

export function statusView(r: ExecResponse): { tone: 'ok' | 'warn' | 'crit' | 'info'; title: string } {
  switch (r.status) {
    case 'done': return { tone: 'ok', title: 'Done and verified' };
    case 'done-unverified': return { tone: 'warn', title: 'Started, not yet verified' };
    case 'awaiting-schedule-permission': return { tone: 'info', title: 'Waiting for Windows permission' };
    case 'declined': return { tone: 'warn', title: 'Not changed: permission was not granted' };
    case 'lost': return { tone: 'warn', title: 'Lost contact: check the Action Center history' };
    default: return { tone: 'crit', title: 'Failed: nothing was verified' };
  }
}

/**
 * Polls the one fixed result file of an elevated run. Transient errors are retried; only repeated failure is reported, and then as
 * "lost contact" (the action may well have run), never as a failed action.
 */
export function useTicketPoll(ticket: string | null, onStatus: (s: 'awaiting-permission' | 'running') => void, onSettled: (r: ExecResponse) => void) {
  const statusRef = useRef(onStatus); statusRef.current = onStatus;
  const settledRef = useRef(onSettled); settledRef.current = onSettled;
  useEffect(() => {
    if (!ticket) return;
    let stop = false; let errors = 0;
    const tick = async () => {
      try {
        const r = await remediation.result(ticket);
        if (stop) return;
        errors = 0;
        if (r.status === 'awaiting-permission' || r.status === 'running') statusRef.current(r.status);
        else { stop = true; settledRef.current(r); }
      } catch {
        if (stop) return;
        errors++;
        if (errors >= MAX_POLL_ERRORS) { stop = true; settledRef.current({ status: 'lost', message: 'Laptop Guardian lost contact with its bridge while waiting. The action may still have run: check the Action Center history before trying again.' }); }
      }
    };
    const t = setInterval(() => { void tick(); }, ACTION_POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [ticket]);
}

export function useActionFlow(onDone?: () => void) {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  /** Bumped whenever the user abandons what is being prepared, so a plan that arrives late is cancelled instead of reopening the dialog. */
  const seq = useRef(0);

  const close = useCallback(() => {
    const p = phaseRef.current;
    if (p.name === 'confirm' && p.busy) return;          // an action is being started: it cannot be cancelled from here
    seq.current++;
    if (p.name === 'confirm') void remediation.cancel(p.plan.token).catch(() => undefined);
    // Hiding the dialog of an elevated run keeps watching it in the background; the outcome arrives as a notification.
    if (p.name === 'waiting') addBackground({ ticket: p.ticket, label: p.plan.label, plan: p.plan });
    setPhase({ name: 'idle' });
  }, []);

  const showPlan = useCallback((plan: Plan) => setPhase({ name: 'confirm', plan, acks: [], busy: false }), []);
  const prepare = useCallback(async (make: () => Promise<Plan>, label: string) => {
    const n = ++seq.current;
    setPhase({ name: 'planning', label });
    try {
      const plan = await make();
      if (n !== seq.current) { void remediation.cancel(plan.token).catch(() => undefined); return; }   // abandoned while it was loading
      showPlan(plan);
    } catch (e) {
      if (n !== seq.current) return;
      const err = e as ApiError;
      setPhase({ name: 'refused', label, message: err.message, reasons: err.errors.length ? err.errors : [err.message] });
    }
  }, [showPlan]);
  const run = useCallback((actionId: string, params: Record<string, string | number>, label = 'Checking') => prepare(() => remediation.plan(actionId, params), label), [prepare]);
  const runUndo = useCallback((eventId: string) => prepare(() => remediation.undo(eventId), 'Preparing undo'), [prepare]);

  const settle = useCallback((plan: Plan, response: ExecResponse) => {
    if (response.status === 'needs-elevation' && response.plan) { showPlan(response.plan); return; }
    setPhase({ name: 'result', plan, response });
    doneRef.current?.();
  }, [showPlan]);

  const confirm = useCallback(async () => {
    if (phase.name !== 'confirm' || phase.busy) return;
    const { plan, acks } = phase;
    setPhase({ ...phase, busy: true });
    try {
      const r = await remediation.execute(plan.token, acks);
      if (r.status === 'awaiting-permission' && r.ticket) setPhase({ name: 'waiting', plan, ticket: r.ticket, status: 'awaiting-permission' });
      else settle(plan, r);
    } catch (e) { settle(plan, { status: 'failed', result: { ok: false, errors: [(e as ApiError).message] } }); }
  }, [phase, settle]);

  // While Windows is showing its permission prompt (or the elevated run is working) poll the one fixed result file.
  const ticket = phase.name === 'waiting' ? phase.ticket : null;
  useTicketPoll(
    ticket,
    (s) => setPhase((p) => (p.name === 'waiting' ? { ...p, status: s } : p)),
    (r) => { const p = phaseRef.current; if (p.name === 'waiting') settle(p.plan, r); },
  );

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
  const busy = phase.name === 'confirm' && phase.busy;

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
        {p.warnings && p.warnings.length > 0 && <div className="notice warn" role="alert">{p.warnings.map((w) => <div key={w}>{w}</div>)}</div>}
        <section><div className="eyebrow">What will happen</div><p>{p.summary}</p></section>
        <section><div className="eyebrow">Impact</div><p className="t2">{p.consequences}</p></section>
        <section><div className="eyebrow">{p.reversible ? 'How to undo' : 'Undo'}</div><p className="t2">{p.undo}</p></section>
        {p.adminRequired && <div className="notice warn"><b>Windows will ask for permission.</b> Guardian runs only this one allowlisted action elevated, then closes it. If you decline, nothing changes. The Windows prompt itself only says &quot;Windows PowerShell&quot;, so check it against the exact action below.</div>}
        <details className="exact"><summary>Exact action</summary><KV items={[['Action', <code key="a">{p.actionId}</code>], ...paramRows(p.params)]} /><p className="small muted">This is a fixed Guardian action, not a command. Parameters are validated and the live target is checked again immediately before it runs.</p></details>
        {p.requiredAcks.map((a) => <label key={a} className="ack"><input type="checkbox" checked={phase.acks.includes(a)} onChange={(e) => onAck(a, e.target.checked)} /><span>{ACK_TEXT[a] || a}</span></label>)}
      </div>
    );
    foot = (<><button className="btn" onClick={onClose} disabled={busy} data-autofocus>Cancel</button><button className={`btn ${p.risk === 'HIGH' || p.risk === 'MEDIUM' ? 'danger solid' : 'primary'}`} disabled={!allAcked || phase.busy} onClick={onConfirm}>{phase.busy ? 'Working...' : p.confirmLabel}</button></>);
  } else if (phase.name === 'waiting') {
    title = phase.plan.label;
    body = (
      <div className="stack">
        <div className="row"><span className="spin"><Icon name="refresh" size={16} /></span><b>{phase.status === 'running' ? 'Running with administrator permission...' : 'Waiting for you to approve the Windows prompt'}</b></div>
        {phase.status === 'awaiting-permission' && (
          <div className="notice warn"><b>Windows is about to ask permission to run exactly this:</b>
            <KV items={[['Action', <code key="a">{phase.plan.actionId}</code>], ...paramRows(phase.plan.params)]} />
            <div className="small">The prompt will only say &quot;Windows PowerShell&quot;. Approve it only if it matches the action above.</div></div>
        )}
        <p className="t2 small">{phase.status === 'running' ? (phase.plan.long ? 'This can take several minutes. You can hide this window; Laptop Guardian keeps watching and tells you when it finishes. The result is also saved in the Action Center history.' : 'This should only take a moment.') : 'Check the taskbar for the permission window. If you decline it or do not answer, nothing is changed.'}</p>
      </div>
    );
    foot = <button className="btn" onClick={onClose} data-autofocus>Hide and keep running</button>;
  } else {
    const r = phase.response; const v = statusView(r); const res = r.result;
    const reasons = (res && res.errors && res.errors.length ? res.errors : []).concat(r.message && !res ? [r.message] : []);
    title = phase.plan.label;
    body = (
      <div className="stack-lg">
        <div className={`notice ${v.tone === 'info' ? '' : v.tone}`} role={v.tone === 'crit' ? 'alert' : 'status'}><b>{v.title}</b>{res?.message && <div>{res.message}</div>}{reasons.map((m) => <div key={m}>{m}</div>)}</div>
        {res?.ok && <div className="row"><Badge tone={res.verified ? 'ok' : 'warn'}>{res.verified ? 'Verified by reading the system back' : 'Not verified'}</Badge></div>}
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
