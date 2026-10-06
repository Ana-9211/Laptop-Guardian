import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtDay, fmtFull, NA } from '../format';
import { Seg } from './ui';

export type Range = 7 | 30 | 90 | 0; // 0 = all
export const RANGE_ITEMS = [{ id: 7 as Range, label: '7d' }, { id: 30 as Range, label: '30d' }, { id: 90 as Range, label: '90d' }, { id: 0 as Range, label: 'All' }];
export const RangeSelect = ({ value, onChange }: { value: Range; onChange: (r: Range) => void }) => <Seg<Range> value={value} onChange={onChange} items={RANGE_ITEMS} label="Time range" />;
export function filterRange<T extends { ts: string }>(rows: T[], range: Range): T[] {
  if (!range) return rows;
  const cut = Date.now() - range * 86400000;
  return rows.filter((r) => Date.parse(r.ts) >= cut);
}

export interface Series { id: string; label: string; color: string; values: (number | null | undefined)[]; dashed?: boolean }

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.max(260, Math.floor(e[0].contentRect.width))));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceTicks(min: number, max: number, n = 4) {
  if (max === min) { max = min + 1; }
  const raw = (max - min) / n; const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const lo = Math.floor(min / step) * step; const hi = Math.ceil(max / step) * step;
  const t: number[] = []; for (let v = lo; v <= hi + step / 2; v += step) t.push(Math.round(v * 1000) / 1000);
  return t;
}

interface LineProps {
  x: string[]; series: Series[]; height?: number; unit?: string; min?: number; max?: number; digits?: number;
  area?: boolean; title: string; threshold?: { value: number; label: string }; hideLegend?: boolean;
  /** Shown when there is nothing to plot. The defaults describe the scan metrics; other charts say what they are waiting for. */
  emptyTitle?: string; emptyHint?: string;
  /** Where a click (or Enter on the focused point) on a data point goes, e.g. the report of that day. */
  pointHref?: (index: number) => string | null;
}

/** Multi-series line/area chart: crosshair tooltip, keyboard navigation, data-table fallback. */
export function LineChart({ x, series, height = 200, unit = '', min, max, digits = 1, area, title, threshold, hideLegend, emptyTitle = 'No data for this range', emptyHint = 'Metrics appear after the first daily scan.', pointHref }: LineProps) {
  const [ref, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const m = { l: 40, r: 12, t: 10, b: 22 };
  const iw = W - m.l - m.r; const ih = height - m.t - m.b;
  const vals = series.flatMap((s) => s.values).filter((v): v is number => typeof v === 'number');
  const dMin = min ?? (vals.length ? Math.min(...vals) : 0); const dMax = max ?? (vals.length ? Math.max(...vals) : 1);
  const pad = min === undefined && max === undefined ? (dMax - dMin || 1) * 0.08 : 0;
  const ticks = useMemo(() => niceTicks(dMin - pad, dMax + pad), [dMin, dMax, pad]);
  const lo = min ?? ticks[0]; const hi = max ?? ticks[ticks.length - 1];
  const n = x.length;
  const px = (i: number) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const py = (v: number) => m.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const f = (v: number | null | undefined) => (v == null ? NA : `${v.toLocaleString(undefined, { maximumFractionDigits: digits })}${unit}`);

  const paths = series.map((s) => {
    let d = ''; let pen = false; const pts: [number, number][] = [];
    s.values.forEach((v, i) => { if (typeof v !== 'number') { pen = false; return; } d += `${pen ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`; pen = true; pts.push([px(i), py(v)]); });
    const a = pts.length > 1 ? `${d}L${pts[pts.length - 1][0].toFixed(1)},${(m.t + ih).toFixed(1)}L${pts[0][0].toFixed(1)},${(m.t + ih).toFixed(1)}Z` : '';
    return { s, d, a, pts };
  });

  const idxAt = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect(); const rel = clientX - r.left - m.l;
    return Math.min(n - 1, Math.max(0, Math.round((rel / iw) * (n - 1))));
  };
  const xt = n <= 1 ? [0] : [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];
  const tipLeft = hover == null ? 0 : Math.min(W - 80, Math.max(80, px(hover)));

  if (!n || !vals.length) return <div ref={ref} className="empty" style={{ height }}><b>{emptyTitle}</b><span>{emptyHint}</span></div>;
  return (
    <div className="chart" ref={ref}>
      <svg width={W} height={height} role="img" tabIndex={0} aria-label={`${title}. ${series.map((s) => s.label).join(', ')}. Use left and right arrow keys to inspect values.`}
        onMouseMove={(e) => setHover(idxAt(e.clientX, e.currentTarget))} onMouseLeave={() => setHover(null)}
        onClick={(e) => { const h = pointHref?.(idxAt(e.clientX, e.currentTarget)); if (h) window.location.hash = h; }} style={pointHref ? { cursor: 'pointer' } : undefined}
        onKeyDown={(e) => { if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1)); else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1)); else if (e.key === 'Escape') setHover(null); else if (e.key === 'Enter' && hover != null) { const h = pointHref?.(hover); if (h) window.location.hash = h; } }}
        onBlur={() => setHover(null)}>
        <g className="grid">{ticks.filter((t) => t >= lo && t <= hi).map((t) => <g key={t}><line x1={m.l} x2={W - m.r} y1={py(t)} y2={py(t)} /><text x={m.l - 6} y={py(t) + 4} textAnchor="end">{t.toLocaleString(undefined, { maximumFractionDigits: 1 })}</text></g>)}</g>
        {xt.map((i, k) => <text key={k} x={px(i)} y={height - 5} textAnchor={k === 0 && n > 1 ? 'start' : k === xt.length - 1 && n > 1 ? 'end' : 'middle'}>{fmtDay(x[i])}</text>)}
        {threshold && threshold.value >= lo && threshold.value <= hi && <g><line x1={m.l} x2={W - m.r} y1={py(threshold.value)} y2={py(threshold.value)} stroke="var(--warn)" strokeDasharray="4 4" /><text x={W - m.r} y={py(threshold.value) - 4} textAnchor="end" style={{ fill: 'var(--warn)' }}>{threshold.label}</text></g>}
        {area && paths.map((p) => p.a && <path key={`a${p.s.id}`} d={p.a} fill={p.s.color} opacity=".1" />)}
        {paths.map((p) => <path key={p.s.id} d={p.d} fill="none" stroke={p.s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" pathLength={p.s.dashed ? undefined : 1} className={p.s.dashed ? undefined : 'line-draw'} strokeDasharray={p.s.dashed ? '5 4' : undefined} />)}
        {n <= 40 && paths.map((p) => p.pts.map(([cx, cy], i) => <circle key={`${p.s.id}${i}`} cx={cx} cy={cy} r="2.2" fill={p.s.color} />))}
        {hover != null && <g>
          <line x1={px(hover)} x2={px(hover)} y1={m.t} y2={m.t + ih} stroke="var(--line-strong)" />
          {series.map((s) => typeof s.values[hover] === 'number' && <circle key={s.id} cx={px(hover)} cy={py(s.values[hover] as number)} r="4.5" fill={s.color} stroke="var(--panel)" strokeWidth="2" />)}
        </g>}
      </svg>
      {hover != null && (
        <div className="tip" style={{ left: tipLeft, top: 4 }} role="status">
          <b>{fmtFull(x[hover])}</b>{pointHref?.(hover) && <div className="small muted">Click to open that day</div>}
          {series.map((s) => <div key={s.id}><span><i style={{ background: s.color }} />{s.label}</span><span className="num">{f(s.values[hover])}</span></div>)}
        </div>
      )}
      <div className="row spread" style={{ marginTop: 6 }}>
        {!hideLegend && series.length > 0 && <div className="legend">{series.map((s) => <span key={s.id}><i style={{ background: s.color }} />{s.label}</span>)}</div>}
        <button className="btn ghost sm" onClick={() => setTable(!table)} aria-expanded={table}>{table ? 'Hide table' : 'View as table'}</button>
      </div>
      {table && (
        <div className="table-wrap" style={{ maxHeight: 220, marginTop: 6, border: '1px solid var(--line)', borderRadius: 6 }}>
          <table className="t" aria-label={`${title} data`}><thead><tr><th>Time</th>{series.map((s) => <th key={s.id} className="r">{s.label}</th>)}</tr></thead>
            <tbody>{x.map((t, i) => <tr key={t}><td>{fmtFull(t)}</td>{series.map((s) => <td key={s.id} className="r num">{f(s.values[i])}</td>)}</tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values, color = 'var(--accent)', w = 84, h = 28 }: { values: (number | null | undefined)[]; color?: string; w?: number; h?: number }) {
  const v = values.filter((x): x is number => typeof x === 'number');
  if (v.length < 2) return null;
  const mn = Math.min(...v); const mx = Math.max(...v); const r = mx - mn || 1;
  const d = v.map((y, i) => `${i ? 'L' : 'M'}${((i / (v.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - ((y - mn) / r) * (h - 6)).toFixed(1)}`).join('');
  return <svg width={w} height={h} aria-hidden="true"><path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

/** Vertical bars (counts per run) with per-bar hover title + visible tooltip. */
export function BarChart({ x, values, color, height = 140, title, unit = '', emptyTitle = 'No data', emptyHint }: { x: string[]; values: (number | undefined)[]; color: string; height?: number; title: string; unit?: string; emptyTitle?: string; emptyHint?: string }) {
  const [ref, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const m = { l: 30, r: 8, t: 8, b: 20 };
  const iw = W - m.l - m.r; const ih = height - m.t - m.b;
  const vs = values.map((v) => v ?? 0); const mx = Math.max(1, ...vs);
  const ticks = niceTicks(0, mx, 3);
  const top = ticks[ticks.length - 1];
  const bw = Math.max(2, iw / Math.max(1, vs.length) - 2);
  if (!vs.length) return <div ref={ref} className="empty"><b>{emptyTitle}</b>{emptyHint && <span>{emptyHint}</span>}</div>;
  const n = vs.length;
  return (
    <div className="chart" ref={ref}>
      <svg width={W} height={height} role="img" tabIndex={0} aria-label={`${title}. Use left and right arrow keys to inspect each value.`} onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)}
        onKeyDown={(e) => { if (e.key === 'ArrowRight') { e.preventDefault(); setHover((h) => Math.min(n - 1, (h ?? -1) + 1)); } else if (e.key === 'ArrowLeft') { e.preventDefault(); setHover((h) => Math.max(0, (h ?? n) - 1)); } else if (e.key === 'Home') { e.preventDefault(); setHover(0); } else if (e.key === 'End') { e.preventDefault(); setHover(n - 1); } else if (e.key === 'Escape') setHover(null); }}>
        <g className="grid">{ticks.map((t) => { const y = m.t + ih - (t / top) * ih; return <g key={t}><line x1={m.l} x2={W - m.r} y1={y} y2={y} /><text x={m.l - 5} y={y + 4} textAnchor="end">{t}</text></g>; })}</g>
        {vs.map((v, i) => { const bx = m.l + (i / vs.length) * iw + 1; const bh = (v / top) * ih; return (
          <g key={x[i]} onMouseEnter={() => setHover(i)}>
            <rect x={bx - 1} y={m.t} width={bw + 2} height={ih} fill="transparent" />
            <rect x={bx} y={m.t + ih - bh} width={bw} height={Math.max(bh, v ? 1 : 0)} rx={Math.min(3, bw / 2)} fill={color} opacity={hover == null || hover === i ? 1 : .5}><title>{`${fmtFull(x[i])}: ${v}${unit}`}</title></rect>
          </g>); })}
        <text x={m.l} y={height - 4}>{fmtDay(x[0])}</text><text x={W - m.r} y={height - 4} textAnchor="end">{fmtDay(x[x.length - 1])}</text>
      </svg>
      {hover != null && <div className="tip" style={{ left: Math.min(W - 80, Math.max(80, m.l + ((hover + .5) / vs.length) * iw)), top: 0 }}><b>{fmtFull(x[hover])}</b><div><span>{title}</span><span className="num">{vs[hover]}{unit}</span></div></div>}
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn ghost sm" onClick={() => setTable(!table)} aria-expanded={table}>{table ? 'Hide table' : 'View as table'}</button>
      </div>
      {table && (
        <div className="table-wrap" style={{ maxHeight: 220, marginTop: 6, border: '1px solid var(--line)', borderRadius: 6 }}>
          <table className="t" aria-label={`${title} data`}><thead><tr><th>Time</th><th className="r">{title}</th></tr></thead>
            <tbody>{x.map((t, i) => <tr key={t}><td>{fmtFull(t)}</td><td className="r num">{vs[i]}{unit}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}

export function ScoreRing({ score, size = 56 }: { score?: number; size?: number }) {
  const s = score ?? 0; const stroke = Math.max(5, Math.round(size / 11)); const r = (size - stroke) / 2 - 1; const c = 2 * Math.PI * r; const mid = size / 2;
  const tone = score == null ? 'var(--muted)' : s >= 85 ? 'var(--ok)' : s >= 70 ? 'var(--warn)' : 'var(--crit)';
  return (
    <div className="score" style={{ width: size, height: size }} role="img" aria-label={`Health score ${score ?? 'unknown'} out of 100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={mid} cy={mid} r={r} fill="none" stroke="var(--sunken)" strokeWidth={stroke} />
        <circle className="arc" cx={mid} cy={mid} r={r} fill="none" stroke={tone} strokeWidth={stroke} strokeLinecap="round" style={{ strokeDasharray: `${(s / 100) * c} ${c}` }} transform={`rotate(-90 ${mid} ${mid})`} />
      </svg>
      <b style={{ fontSize: Math.round(size / 3.2) }}>{score ?? NA}</b>
    </div>
  );
}

export const SERIES_COLORS = { cpu: 'var(--s1)', ram: 'var(--s2)', disk: 'var(--s3)' };
