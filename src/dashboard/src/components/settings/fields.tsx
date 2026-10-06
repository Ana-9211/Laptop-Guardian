import { type ReactNode, useEffect, useState } from 'react';
import type { Config } from '../../types';

export type Draft = Config;
export const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
export const strip = (c: Config) => { const x = clone(c) as Partial<Config>; delete x._ai; delete x.bridge; delete x.schemaVersion;
  // Deep Network Guard and DNS filtering are switched only from Network Guard, with their own confirmation.
  if (x.network) { delete (x.network as { deep?: unknown }).deep; delete (x.network as { dnsFiltering?: unknown }).dnsFiltering; }
  return x; };
export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
// Shown until "Test connection" fetches the live list for this key. Retired models are not listed.
export const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'];

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <span className="hint" style={{ fontWeight: 400 }}>{hint}</span>}</label>;
}
/** Numeric input that never turns an empty or out-of-range entry into a value: it keeps the text while typing and commits only valid numbers, clamping on blur. */
export function Num({ value, onChange, min = 0, max = 1_000_000_000, step }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText((t) => (Number(t) === value ? t : String(value))); }, [value]);
  const bad = text.trim() === '' || !Number.isFinite(Number(text)) || Number(text) < min || Number(text) > max;
  return <input type="number" inputMode="decimal" min={min} max={max} step={step} value={text} aria-invalid={bad || undefined} title={bad ? `Enter a number from ${min} to ${max}` : undefined}
    onChange={(e) => { setText(e.target.value); const v = Number(e.target.value); if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= min && v <= max) onChange(v); }}
    onBlur={() => { const v = Number(text); const c = text.trim() === '' || !Number.isFinite(v) ? value : Math.min(max, Math.max(min, v)); setText(String(c)); if (c !== value) onChange(c); }} />;
}
export const Lines = ({ value, onChange, rows = 3, placeholder }: { value: string[]; onChange: (v: string[]) => void; rows?: number; placeholder?: string }) => (
  <textarea rows={rows} value={value.join('\n')} placeholder={placeholder} spellCheck={false} style={{ fontFamily: 'var(--mono)', fontSize: 12.5, width: '100%' }} onChange={(e) => onChange(e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))} />
);
export type Upd = (fn: (x: Draft) => void) => void;
