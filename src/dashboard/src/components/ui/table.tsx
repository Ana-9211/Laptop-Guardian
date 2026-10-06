import { useState, type ReactNode } from 'react';

const SORT_PREFIX = 'lg-sort-';
const readSort = (key: string | undefined, valid: string[]): { key: string; dir: 1 | -1 } | null => {
  if (!key) return null;
  try { const j = JSON.parse(localStorage.getItem(SORT_PREFIX + key) || 'null'); return j && valid.includes(j.key) && (j.dir === 1 || j.dir === -1) ? j : null; } catch { return null; }
};
import { Icon } from './icons';

export interface Col<T> { key: string; label: string; render: (r: T) => ReactNode; sort?: (r: T) => number | string; align?: 'r'; width?: number | string }
export function DataTable<T>({ cols, rows, rowKey, onRow, selected, initialSort, empty, label, stickyLast, persistKey }: { persistKey?: string; stickyLast?: boolean; cols: Col<T>[]; rows: T[]; rowKey: (r: T) => string; onRow?: (r: T) => void; selected?: string | null; initialSort?: { key: string; dir: 1 | -1 }; empty?: ReactNode; label: string }) {
  // With a persistKey the chosen sort is remembered per browser, so the table comes back the way it was left.
  const [sort, setSortState] = useState(() => readSort(persistKey, cols.filter((c) => c.sort).map((c) => c.key)) || initialSort || null);
  const setSort = (s: { key: string; dir: 1 | -1 } | null) => { setSortState(s); if (persistKey && s) { try { localStorage.setItem(SORT_PREFIX + persistKey, JSON.stringify(s)); } catch { /* not remembered */ } } };
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
