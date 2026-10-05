import { cloneElement, createContext, isValidElement, ReactElement, ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import type { Cmd } from '../types';
import { downloadFile } from '../api';
import { riskTone, NA } from '../format';
import { MAX_TOASTS, TOAST_MS } from '../config';

/* ---------- icons ---------- */
const P = {
  overview: 'M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  daily: 'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1zM8 13h3',
  weekly: 'M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1zM8 12h8M8 16h5',
  processes: 'M4 6h16M4 12h16M4 18h10M18 16l2 2-2 2',
  files: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  health: 'M3 12h4l2-6 4 12 2-6h6',
  reports: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6',
  logs: 'M5 4h14M5 9h14M5 14h9M5 19h6',
  recs: 'M4 5h16v11H8l-4 4zM8 9h8M8 12h5',
  blacklist: 'M12 3a9 9 0 100 18 9 9 0 000-18zM5.6 5.6l12.8 12.8',
  whitelist: 'M12 3a9 9 0 100 18 9 9 0 000-18zM8 12.5l3 3 5-6',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14 3h-4l-.5 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 005 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 002 1.2L10 21h4l.5-2.6a7 7 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  check: 'M5 12.5l4.5 4.5L19 7',
  x: 'M6 6l12 12M18 6L6 18',
  chev: 'M9 6l6 6-6 6',
  sun: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  moon: 'M20 14A8 8 0 019.5 4 8 8 0 1020 14z',
  refresh: 'M20 5v5h-5M4 19v-5h5M5.5 9A7 7 0 0118 7.5M18.5 15A7 7 0 016 16.5',
  play: 'M7 4l13 8-13 8z',
  warn: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v5M12 8h.01',
  shield: 'M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeoff: 'M3 3l18 18M10.6 5.1A9.7 9.7 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.3 6.4A17 17 0 002 12s4 7 10 7c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 004.2 4.2',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 118 0v3',
  compare: 'M8 4v16M16 4v16M4 8l4-4 4 4M12 16l4 4 4-4',
  sortBoth: 'M8 9l4-4 4 4M8 15l4 4 4-4',
  sortUp: 'M7 14l5-5 5 5',
  sortDown: 'M7 10l5 5 5-5',
  offline: 'M3 3l18 18M8.5 8.6A9 9 0 003 12M16 11.2A9 9 0 0121 12M5 15a7 7 0 013-1.9M12 19h.01M10 16.2a4 4 0 014 0',
  elevate: 'M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6zM12 8v5M12 16h.01',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2',
  sidebar: 'M4 5h16v14H4zM9 5v14',
  network: 'M12 3a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM5 15.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM19 15.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM12 8v4M12 12l-5.5 3.7M12 12l5.5 3.7',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
} as const;
export type IconName = keyof typeof P;
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}

/* ---------- primitives ---------- */
export function Badge({ tone = '', children, dot, title }: { tone?: string; children: ReactNode; dot?: boolean; title?: string }) {
  return <span className={`badge ${tone}`} title={title}>{dot && <i />}{children}</span>;
}
/** Dot separator drawn with CSS so it renders identically everywhere (no font-dependent glyphs). */
export const Sep = () => <span className="sep" aria-hidden="true" />;
export const RiskBadge = ({ risk }: { risk?: string }) => <Badge tone={riskTone(risk)} dot>{risk || 'UNKNOWN'}</Badge>;

export function Card({ title, actions, children, flush, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && <header className="card-head"><h2>{title}</h2>{actions}</header>}
      <div className={`card-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <label className="switch">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="track" /><span>{label}</span>
      </label>
      {hint && <div className="hint" style={{ marginLeft: 44 }}>{hint}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items, label, children, listStyle, panelStyle }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; count?: number }[]; label: string; children?: ReactNode; listStyle?: React.CSSProperties; panelStyle?: React.CSSProperties }) {
  const base = useId();
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((x) => x.id === value);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    if (n < 0) return;
    e.preventDefault();
    onChange(items[n].id);
    const list = e.currentTarget;
    requestAnimationFrame(() => list.querySelectorAll<HTMLElement>('[role=tab]')[n]?.focus());
  };
  return (
    <>
      <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKey} style={listStyle}>
        {items.map((t) => (
          <button key={t.id} id={`${base}-tab-${t.id}`} role="tab" aria-selected={value === t.id} aria-controls={children !== undefined && value === t.id ? `${base}-panel` : undefined} tabIndex={value === t.id ? 0 : -1} onClick={() => onChange(t.id)}>
            {t.label}{t.count != null && <span className="n">{t.count}</span>}
          </button>
        ))}
      </div>
      {children !== undefined && <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${value}`} tabIndex={0} className="tabpanel" style={panelStyle}>{children}</div>}
    </>
  );
}

export function Seg<T extends string | number>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[]; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map((i) => <button key={String(i.id)} aria-pressed={value === i.id} onClick={() => onChange(i.id)}>{i.label}</button>)}
    </div>
  );
}

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

export function Drawer({ title, sub, onClose, children, footer }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useOverlay(onClose);
  const tid = useId();
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby={tid} ref={ref} tabIndex={-1}>
        <div className="drawer-head">
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
export function Expander({ head, children, defaultOpen }: { head: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="expander">
      <button aria-expanded={open} onClick={() => setOpen(!open)}><svg className={`chev ${open ? 'open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={P.chev} /></svg>{head}</button>
      <div className="reveal" data-open={open} aria-hidden={!open} {...(open ? {} : { inert: '' as const })}><div><div className="body">{children}</div></div></div>
    </div>
  );
}

/* ---------- command block ---------- */
function highlight(cmd: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /('(?:[^']|'')*'|"(?:[^"`]|`.)*")|(\$[\w:{}]+)|(\s-{1,2}[A-Za-z][\w-]*)|(\b[A-Z][a-z]+-[A-Z]\w+\b|\b(?:sfc|dism|taskkill|schtasks|reg|sc|net|netsh|powershell|wmic)\b)/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(cmd))) {
    if (m.index > last) out.push(cmd.slice(last, m.index));
    const cls = m[1] ? 'tk-str' : m[2] ? 'tk-var' : m[3] ? 'tk-flag' : 'tk-cmd';
    out.push(<span key={i++} className={cls}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  out.push(cmd.slice(last));
  return out;
}
/** A download that goes through the authenticated channel (a plain link cannot carry the session token). */
export function DownloadButton({ path, method = 'GET', body, name, className = 'btn', children, ariaLabel }: { path: string; method?: 'GET' | 'POST'; body?: unknown; name: string; className?: string; children: ReactNode; ariaLabel?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className={className} disabled={busy} aria-label={ariaLabel}
      onClick={() => { setBusy(true); downloadFile(method, path, body, name).catch((e: Error) => toast('error', e.message)).finally(() => setBusy(false)); }}>{children}</button>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }
    catch { toast('error', 'Clipboard is not available. Select the command and copy it manually.'); }
  };
  return <button className="btn sm" onClick={copy} aria-label={`${label} command`}><Icon name={done ? 'check' : 'copy'} size={13} />{done ? 'Copied' : label}</button>;
}
export function CommandBlock({ title, cmd }: { title: string; cmd: Cmd }) {
  return (
    <div className="cmd">
      <div className="cmd-head">
        <span className="t">{title}</span>
        <RiskBadge risk={String(cmd.risk)} />
        <Badge tone={cmd.requiresAdmin ? 'warn' : 'ok'}>{cmd.requiresAdmin ? 'Needs Administrator' : 'No admin needed'}</Badge>
        <Badge tone={cmd.reversible ? 'ok' : 'crit'}>{cmd.reversible ? 'Reversible' : 'Not reversible'}</Badge>
        <CopyButton text={cmd.command} />
      </div>
      <pre><code>{highlight(cmd.command)}</code></pre>
      <div className="why">{cmd.explains} <span className="muted">Displayed only. Laptop Guardian never runs this for you.</span></div>
    </div>
  );
}
export function TextCommand({ title, text }: { title: string; text: string }) {
  return (
    <div className="cmd">
      <div className="cmd-head"><span className="t">{title}</span><Badge tone="info">AI suggestion</Badge><CopyButton text={text} /></div>
      <pre><code>{highlight(text)}</code></pre>
      <div className="why muted">Text from the AI analysis. It is shown for reference and is never executed by Laptop Guardian.</div>
    </div>
  );
}

/* ---------- stat ---------- */
export function Stat({ label, value, unit, sub, tone, bar, spark, tip }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; tone?: string; bar?: number; spark?: ReactNode; tip?: string }) {
  return (
    <div className="card stat" title={tip}>
      <div className="label">{tone && <span className={`dot ${tone}`} />}{label}</div>
      <div className="value">{value}{unit && <small>{unit}</small>}</div>
      <div className="sub">{sub}</div>
      {bar != null && <div className="bar" aria-hidden="true"><i className={tone === 'crit' ? 'crit' : tone === 'warn' ? 'warn' : ''} style={{ width: `${Math.min(100, Math.max(0, bar))}%` }} /></div>}
      {spark && <div className="spark">{spark}</div>}
    </div>
  );
}

export function KV({ items }: { items: [string, ReactNode][] }) {
  return <dl className="kv" style={{ margin: 0 }}>{items.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v ?? NA}</dd></div>)}</dl>;
}

/* ---------- sortable table ---------- */
export interface Col<T> { key: string; label: string; render: (r: T) => ReactNode; sort?: (r: T) => number | string; align?: 'r'; width?: number | string }
export function DataTable<T>({ cols, rows, rowKey, onRow, selected, initialSort, empty, label, stickyLast }: { stickyLast?: boolean; cols: Col<T>[]; rows: T[]; rowKey: (r: T) => string; onRow?: (r: T) => void; selected?: string | null; initialSort?: { key: string; dir: 1 | -1 }; empty?: ReactNode; label: string }) {
  const [sort, setSort] = useState(initialSort || null);
  const col = cols.find((c) => c.key === sort?.key);
  const sorted = col?.sort && sort ? [...rows].sort((a, b) => { const x = col.sort!(a); const y = col.sort!(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; }) : rows;
  if (!rows.length) return <>{empty}</>;
  return (
    <div className="table-wrap">
      <table className={`t ${stickyLast ? 'stick' : ''}`} aria-label={label}>
        <thead><tr>{cols.map((c) => (
          <th key={c.key} className={c.align === 'r' ? 'r' : ''} style={{ width: c.width }} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
            {c.sort ? <button onClick={() => setSort(sort?.key === c.key ? { key: c.key, dir: (sort.dir * -1) as 1 | -1 } : { key: c.key, dir: 1 })}>{c.label}<span aria-hidden="true" className="sort-ic" data-active={sort?.key === c.key}><Icon name={sort?.key === c.key ? (sort.dir === 1 ? 'sortUp' : 'sortDown') : 'sortBoth'} size={12} /></span></button> : c.label}
          </th>))}</tr></thead>
        <tbody>
          {sorted.map((r) => {
            const k = rowKey(r);
            return (
              <tr key={k} className={`${onRow ? 'click' : ''} ${selected === k ? 'sel' : ''}`} tabIndex={onRow ? 0 : undefined}
                onClick={() => onRow?.(r)} onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (onRow && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onRow(r); } }}>
                {cols.map((c) => <td key={c.key} className={c.align === 'r' ? 'r' : ''}>{c.render(r)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <div className="search grow"><Icon name="search" size={14} /><input type="search" aria-label={placeholder} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} /></div>;
}
