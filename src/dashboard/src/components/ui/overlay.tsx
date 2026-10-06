import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons';
import { Tip } from './feedback';

/* ---------- focus-trapped overlays ---------- */
const overlayStack: object[] = [];

export function useOverlay(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onClose = () => closeRef.current();
    const token = {}; overlayStack.push(token);
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') || []).filter((x) => !x.hasAttribute('disabled'));
    (el?.querySelector<HTMLElement>('[data-autofocus]') || focusables()[0] || el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (overlayStack[overlayStack.length - 1] !== token) return;
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab') {
        const f = focusables(); if (!f.length) return;
        const first = f[0]; const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { overlayStack.splice(overlayStack.indexOf(token), 1); document.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, []);
  return ref;
}

export function Drawer({ title, sub, onClose, children, footer, back }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; back?: { to: string; label: string } | null }) {
  const ref = useOverlay(onClose);
  const tid = useId();
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby={tid} ref={ref} tabIndex={-1}>
        <div className="drawer-head">
          {back && <a className="btn ghost sm back-link" href={`#${back.to}`} data-testid="drawer-back">{'< Back to '}{back.label}</a>}
          <div className="grow"><h2 id={tid} style={{ fontSize: 17 }}>{title}</h2>{sub && <div className="muted small" style={{ marginTop: 2 }}>{sub}</div>}</div>
          <Tip text="Close (Esc)"><button className="btn ghost icon-btn" onClick={onClose} aria-label="Close panel"><Icon name="x" /></button></Tip>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </>
  );
}

export interface ConfirmOpts { title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<void> | void }
export function ConfirmDialog({ opts, onClose }: { opts: ConfirmOpts; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  // While the action is running the dialog cannot be dismissed (Esc, the backdrop and Cancel are all ignored).
  const close = () => { if (!busyRef.current) onClose(); };
  const ref = useOverlay(close);
  const tid = useId();
  const go = async () => {
    busyRef.current = true; setBusy(true); setError(null);
    try { await opts.onConfirm(); busyRef.current = false; onClose(); }
    catch (e) { busyRef.current = false; setBusy(false); setError(e instanceof Error ? e.message : 'That did not work. Nothing was changed.'); }   // stays open so the reason can be read and the action retried
  };
  return (
    <>
      <div className="scrim" style={{ zIndex: 65 }} onClick={close} />
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={tid} ref={ref} tabIndex={-1}>
        <div className="card-body"><h2 id={tid}>{opts.title}</h2><div className="t2">{opts.body}</div>{error && <div className="notice crit" role="alert" style={{ marginTop: 10 }}>{error}</div>}</div>
        <div className="dialog-foot">
          <button className="btn" onClick={close} disabled={busy} data-autofocus>Cancel</button>
          <button className={`btn ${opts.danger ? 'danger solid' : 'primary'}`} disabled={busy} onClick={go}>{busy ? 'Working...' : opts.confirmLabel}</button>
        </div>
      </div>
    </>
  );
}
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const node = opts ? <ConfirmDialog opts={opts} onClose={() => setOpts(null)} /> : null;
  return { confirm: setOpts, node };
}

/* ---------- expander ---------- */
