/** Shown wherever a value is missing. Plain ASCII on purpose. */
export const NA = 'n/a';
export const fmtMB = (mb: number | null | undefined) => {
  if (mb == null) return NA;
  if (mb >= 1024 * 1024) return `${(mb / 1024 / 1024).toFixed(1)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;
  return `${Math.round(mb)} MB`;
};
export const fmtDate = (s?: string | null) => {
  if (!s) return NA;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
export const fmtDay = (s?: string | null) => {
  if (!s) return NA;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
export const fmtFull = (s?: string | null) => {
  if (!s) return NA;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
export const ago = (s?: string | null) => {
  if (!s) return NA;
  const ms = Date.now() - new Date(s).getTime();
  if (Number.isNaN(ms)) return NA;
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
};
export const until = (s?: string | null) => {
  if (!s) return NA;
  const ms = new Date(s).getTime() - Date.now();
  if (Number.isNaN(ms)) return NA;
  const h = Math.round(ms / 3600000);
  if (h < 1) return `in ${Math.max(1, Math.round(ms / 60000))} min`;
  if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} d`;
};
export const pct = (v: number | null | undefined, d = 0) => (v == null ? NA : `${v.toFixed(d)}%`);
export const riskTone = (r?: string) => (r === 'HIGH' ? 'crit' : r === 'MEDIUM' ? 'warn' : r === 'LOW' ? 'ok' : '');
export const sevTone = (s?: string) => (s === 'critical' || s === 'high' || s === 'error' ? 'crit' : s === 'medium' || s === 'warning' ? 'warn' : s === 'low' ? 'info' : '');
export const scoreTone = (s?: number) => (s == null ? '' : s >= 85 ? 'ok' : s >= 70 ? 'warn' : 'crit');
/** The UTC second-resolution form PowerShell uses for process start times, so a PID that was reused is detected. */
export const toUtcSeconds = (iso: string) => { const t = Date.parse(iso); return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 19); };
