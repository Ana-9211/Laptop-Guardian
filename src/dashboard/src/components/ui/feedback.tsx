import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { MAX_TOASTS, TOAST_MS } from '../../config';
import { type IconName, Icon } from './icons';

export function Skeleton({ h = 14, w = '100%' }: { h?: number; w?: number | string }) {
  return <div className="skel" style={{ height: h, width: w }} aria-hidden="true" />;
}
export function SkeletonCards({ n = 4, h = 96 }: { n?: number; h?: number }) {
  return <div className="grid g4" role="status" aria-label="Loading">{Array.from({ length: n }, (_, i) => <div key={i} className="card" style={{ padding: 14 }}><Skeleton h={12} w="40%" /><div style={{ height: 10 }} /><Skeleton h={h - 50} w="60%" /></div>)}</div>;
}
export function Empty({ icon = 'inbox', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return <div className="empty"><Icon name={icon} size={28} /><b>{title}</b>{children && <div style={{ maxWidth: 420 }}>{children}</div>}</div>;
}
export function ErrorState({ error, onRetry }: { error: { message: string; status?: number }; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <Icon name="warn" size={20} />
      <div style={{ flex: 1 }}><b>{error.status === 501 ? 'Feature unavailable' : 'Could not load data'}</b><div className="small t2">{error.message}</div></div>
      {onRetry && <button className="btn" onClick={onRetry}>Retry</button>}
    </div>
  );
}

/* ---------- tooltip ---------- */
export function Tip({ text, children, block }: { text: string; children: ReactNode; block?: boolean }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const id = useId();
  const show = (el: HTMLElement) => { const r = el.getBoundingClientRect(); setPos({ x: Math.min(r.left, window.innerWidth - 290), y: r.bottom + 6 }); };
  const described = isValidElement(children) ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': pos ? id : undefined }) : children;
  return (
    <span style={{ display: block ? 'flex' : 'inline-flex', minWidth: 0 }}
      onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={() => setPos(null)} onFocus={(e) => show(e.currentTarget)} onBlur={() => setPos(null)} onKeyDown={(e) => { if (e.key === 'Escape' && pos) setPos(null); }}>
      {described}
      {pos && <span id={id} role="tooltip" className="tooltip" style={{ left: pos.x, top: pos.y }}>{text}</span>}
    </span>
  );
}

/* ---------- toasts ---------- */
interface ToastItem { id: number; tone: 'ok' | 'error' | 'info' | 'warn'; text: string }
const ToastCtx = createContext<(tone: ToastItem['tone'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
function ToastView({ t, onDismiss }: { t: ToastItem; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  // Errors are sticky: they need to be read. Everything else fades out, but not while the pointer or keyboard focus is on it.
  useEffect(() => {
    if (t.tone === 'error' || paused) return;
    const timer = setTimeout(() => onDismiss(t.id), TOAST_MS.default);
    return () => clearTimeout(timer);
  }, [t.id, t.tone, paused, onDismiss]);
  return (
    <div className={`toast ${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <p>{t.text}</p>
      <button aria-label="Dismiss" title="Dismiss" onClick={() => onDismiss(t.id)}><Icon name="x" size={14} /></button>
    </div>
  );
}
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const n = useRef(0);
  const dismiss = useCallback((id: number) => setItems((x) => x.filter((t) => t.id !== id)), []);
  const push = useCallback((tone: ToastItem['tone'], text: string) => {
    const id = ++n.current;
    setItems((x) => [...x.slice(-(MAX_TOASTS - 1)), { id, tone, text }]);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => <ToastView key={t.id} t={t} onDismiss={dismiss} />)}
      </div>
    </ToastCtx.Provider>
  );
}
