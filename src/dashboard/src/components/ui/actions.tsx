import { useState, type ReactNode } from 'react';
import { P } from './icons';
import type { Cmd } from '../../types';
import { downloadFile } from '../../api';
import { Icon } from './icons';
import { Badge, RiskBadge } from './display';
import { useToast } from './feedback';

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
